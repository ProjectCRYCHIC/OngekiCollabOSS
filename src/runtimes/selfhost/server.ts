import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPool } from "mysql2/promise";
import type { Pool as MySqlPool } from "mysql2/promise";
import Redis from "ioredis";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { serveAdminStaticFrom, serveStaticFrom } from "./static.js";
import { createMysqlDataStores } from "../../adapters/database/mysql/index.js";
import { createNodeSqliteDataStores } from "../../adapters/database/sqlite/node.js";
import type { SelfhostDataStores } from "../../adapters/database/selfhost.js";
import { createAdminSession, PasswordSessionAuthenticator } from "../../adapters/auth/password.js";
import type { PasswordSessionStore } from "../../adapters/auth/password.js";
import { MemoryPasswordSessionStore } from "../../adapters/auth/memory-sessions.js";
import { createRedisRealtime } from "../../adapters/realtime/redis/index.js";
import { createMemoryRealtime } from "../../adapters/realtime/memory/index.js";
import type { SelfhostRealtime } from "../../adapters/realtime/selfhost.js";
import { LocalSocket } from "../../adapters/realtime/local/sockets.js";
import { admitRoomConnection, roomPath } from "../../core/match.js";
import { parsePool } from "../../core/protocol.js";
import { routeError } from "../../core/http.js";
import { routeRequest } from "../shared/router.js";
import type { RouterHooks } from "../shared/router.js";
import type { AppServices, SongCatalog, SongCatalogCache } from "../../core/ports.js";
import type { RoomTicket } from "../../core/tokens.js";

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 409: "Conflict", 426: "Upgrade Required",
  429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable",
};

/** In-process cache mirroring the Worker's edge cache TTL (24h). */
function createMemoryCatalogCache(): SongCatalogCache {
  let cached: { catalog: SongCatalog; at: number } | null = null;
  const ttl = 24 * 60 * 60_000;
  return {
    async get() {
      if (cached && Date.now() - cached.at < ttl) return cached.catalog;
      return null;
    },
    async set(catalog) {
      cached = { catalog, at: Date.now() };
    },
  };
}

async function bridgeRequest(req: IncomingMessage, clientIp: string, scheme: string): Promise<Request> {
  const host = req.headers.host ?? `127.0.0.1:${process.env.PORT ?? "8787"}`;
  const url = new URL(req.url ?? "/", `${scheme}://${host}`);
  const headers = new Headers();
  headers.set("x-ongeki-client-ip", clientIp);
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? Readable.toWeb(req) as ReadableStream<Uint8Array> : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response, isHead: boolean): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  if (isHead || !response.body) { res.end(); return; }
  Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(res);
}

async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = await response.text();
  const statusText = STATUS_TEXT[response.status] ?? "Error";
  const head = [
    `HTTP/1.1 ${response.status} ${statusText}`,
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
  ].join("\r\n");
  socket.write(`${head}\r\n\r\n${body}`);
  socket.destroy();
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first) return first.trim();
  }
  const remote = req.socket.remoteAddress ?? "unknown";
  return remote.replace(/^::ffff:/, "");
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<{ stop(): Promise<void> }> {
  const config = loadConfig(env);
  let mysqlPool: MySqlPool | null = null;
  let closeSqlite: (() => void) | null = null;
  let stores: SelfhostDataStores;
  if (config.databaseBackend === "mysql") {
    mysqlPool = createPool({
      host: config.db.host, port: config.db.port, user: config.db.user,
      password: config.db.password, database: config.db.database,
      connectionLimit: 10,
      decimalNumbers: true,
    });
    stores = createMysqlDataStores(mysqlPool);
  } else {
    const sqlite = createNodeSqliteDataStores(config.sqlitePath);
    stores = sqlite;
    closeSqlite = () => sqlite.close();
  }

  let db: Redis | null = null;
  let publisher: Redis | null = null;
  let subscriber: Redis | null = null;
  let realtime: SelfhostRealtime;
  let sessionStore: PasswordSessionStore;
  if (config.realtimeBackend === "redis") {
    db = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    realtime = createRedisRealtime(db, publisher, subscriber, stores);
    sessionStore = db;
  } else {
    realtime = createMemoryRealtime(stores);
    sessionStore = new MemoryPasswordSessionStore();
  }
  try {
    await realtime.start();
  } catch (cause) {
    realtime.stop();
    subscriber?.disconnect();
    publisher?.disconnect();
    db?.disconnect();
    await mysqlPool?.end().catch(() => undefined);
    closeSqlite?.();
    throw cause;
  }

  const adminAuthenticator = new PasswordSessionAuthenticator(sessionStore, stores.settings);
  if (await adminAuthenticator.bootstrap(config.adminInitialPassword ?? ""))
    console.log("Initialized the admin password from ADMIN_INITIAL_PASSWORD");
  else if (config.adminInitialPassword)
    console.log("Admin password already configured; ADMIN_INITIAL_PASSWORD ignored");

  const clientKey = async (request: Request): Promise<string> => {
    const ip = request.headers.get("x-ongeki-client-ip") ?? "unknown";
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  const services: AppServices = {
    secrets: config.secrets,
    clientKey,
    ...stores,
    health: {
      async ping() {
        await stores.health.ping();
        await realtime.health();
      },
    },
    rooms: realtime.rooms,
    pools: realtime.pools,
    rateLimit: realtime.rateLimit,
    catalogCache: createMemoryCatalogCache(),
    adminAuth: adminAuthenticator,
    adminSession: createAdminSession(adminAuthenticator),
    serveAdminStatic: serveAdminStaticFrom(config.webRoot, true),
  };

  const serveStatic = serveStaticFrom(config.webRoot);
  const hooks: RouterHooks = {
    connectRoom: async () => new Response(null, { status: 426 }), // upgrades never reach the router
    connectLiveDirectory: async () => new Response(null, { status: 426 }),
    connectSpectator: async () => new Response(null, { status: 426 }),
    serveStatic: (request) => serveStatic(request),
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Behind a trusted proxy the forwarded scheme decides absolute URLs,
        // which the admin same-origin guard compares request origins against.
        const proto = config.trustProxy
          ? (req.headers["x-forwarded-proto"]?.toString().split(",")[0].trim() || "http")
          : "http";
        const request = await bridgeRequest(req, clientAddress(req, config.trustProxy), proto);
        const response = await routeRequest(request, services, hooks);
        await writeResponse(res, response, (req.method ?? "GET") === "HEAD");
      } catch (cause) {
        await writeResponse(res, routeError(cause), false);
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });

  const rateLimitCheck = async (request: Request, kind: string, limit: number): Promise<boolean> =>
    services.rateLimit.allow(await services.clientKey(request), kind, limit, 60_000);

  const roomSession = async (ws: WebSocket, roomId: string, payload: RoomTicket): Promise<void> => {
    const local = new LocalSocket(ws, { peerId: payload.peerId, identityId: payload.identityId, messages: 0, windowStart: Date.now() });
    ws.on("message", (data, isBinary) => {
      const message = isBinary ? new Uint8Array(data as Buffer) : data.toString();
      realtime.rooms.onMessage(roomId, local, message).catch(() => {
        try { ws.close(1011, "Internal error"); } catch { /* already closed */ }
      });
    });
    ws.on("close", () => { void realtime.rooms.onClose(roomId, local, "disconnect").catch(() => undefined); });
    ws.on("error", () => { void realtime.rooms.onClose(roomId, local, "socket_error").catch(() => undefined); });
    await realtime.rooms.completePlayerConnection(roomId, local, payload);
  };

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        const proto = config.trustProxy
          ? (req.headers["x-forwarded-proto"]?.toString().split(",")[0].trim() || "http")
          : "http";
        const request = await bridgeRequest(req, clientAddress(req, config.trustProxy), proto);
        const url = new URL(request.url);
        const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
        const room = roomPath(url.pathname);
        if (room !== undefined) {
          if (!upgrade) return void rejectUpgrade(socket, new Response(JSON.stringify({ error: "WebSocket required" }), { status: 426 }));
          const admission = await admitRoomConnection(services, request, room);
          if (!admission.ok) return void rejectUpgrade(socket, admission.response);
          // Match the Cloudflare DO admission boundary: a replayed, occupied or
          // otherwise stale reservation is rejected before the HTTP 101 upgrade.
          // completePlayerConnection validates again under the room lock to close
          // the upgrade-to-registration race.
          const roomAdmission = await realtime.rooms.validatePlayerConnection(admission.ticket.roomId, admission.ticket);
          if (roomAdmission instanceof Response) return void rejectUpgrade(socket, roomAdmission);
          wss.handleUpgrade(req, socket, head, (ws) => { void roomSession(ws, admission.ticket.roomId, admission.ticket); });
          return;
        }
        if (url.pathname === "/api/v1/live") {
          if (!upgrade) return void rejectUpgrade(socket, new Response(JSON.stringify({ error: "WebSocket required" }), { status: 426 }));
          const pool = parsePool(url.searchParams.get("pool")) ?? "";
          if (url.searchParams.has("pool") && !await rateLimitCheck(request, "named_lookup", 60))
            return void rejectUpgrade(socket, new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 }));
          if (!await rateLimitCheck(request, "live_connect", 30))
            return void rejectUpgrade(socket, new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 }));
          wss.handleUpgrade(req, socket, head, (ws) => {
            void (async () => {
              const local = new LocalSocket(ws, { peerId: 0, identityId: "", messages: 0, windowStart: Date.now() });
              const snapshot = await realtime.directory.attach(pool, local);
              ws.on("close", () => realtime.directory.detach(pool, local));
              ws.on("message", () => ws.close(1008, "Read-only directory"));
              ws.send(snapshot);
            })().catch(() => { try { ws.close(1011, "Directory unavailable"); } catch { /* closed */ } });
          });
          return;
        }
        const spectate = /^\/api\/v1\/rooms\/([0-9a-f-]{36})\/live$/.exec(url.pathname);
        if (spectate) {
          if (!upgrade) return void rejectUpgrade(socket, new Response(JSON.stringify({ error: "WebSocket required" }), { status: 426 }));
          if (!await rateLimitCheck(request, "live_connect", 30))
            return void rejectUpgrade(socket, new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 }));
          const roomId = spectate[1].toLowerCase();
          const validated = await realtime.rooms.validateSpectator(roomId);
          if (validated instanceof Response) return void rejectUpgrade(socket, validated);
          wss.handleUpgrade(req, socket, head, (ws) => {
            void (async () => {
              const local = new LocalSocket(ws, { peerId: 0, identityId: "", messages: 0, windowStart: Date.now(), spectator: true });
              ws.on("close", () => realtime.rooms.detach(roomId, local));
              await realtime.rooms.addSpectator(roomId, local);
            })().catch(() => { try { ws.close(1011, "Room unavailable"); } catch { /* closed */ } });
          });
          return;
        }
        await rejectUpgrade(socket, new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
      } catch {
        rejectUpgrade(socket, new Response(JSON.stringify({ error: "Internal error" }), { status: 500 })).catch(() => socket.destroy());
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, () => resolveListen());
  });
  console.log(`OngekiCollab self-hosted server listening on port ${config.port}`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    realtime.stop();
    server.close();
    server.closeIdleConnections();
    wss.clients.forEach((client) => { try { client.close(1001, "Server shutting down"); } catch { /* closed */ } });
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      subscriber?.disconnect();
      await Promise.allSettled([
        ...(publisher ? [publisher.quit()] : []),
        ...(db ? [db.quit()] : []),
        ...(mysqlPool ? [mysqlPool.end()] : []),
      ]);
      closeSqlite?.();
    } finally {
      clearTimeout(force);
    }
  };

  return { stop };
}

/** CLI entry: `node dist/runtimes/selfhost/server.js` boots the server and
 *  shuts down gracefully on SIGTERM/SIGINT. */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const instance = startServer().catch((cause) => {
    console.error("Server boot failed:", cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      const { stop } = await instance;
      await stop();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
