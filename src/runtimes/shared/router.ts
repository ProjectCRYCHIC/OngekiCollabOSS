import { adminApi, adminReset } from "../../core/admin-api.js";
import { historyPage, pageInput, roomPage } from "../../core/directory.js";
import { failure, requireSecrets, response } from "../../core/http.js";
import { challenge, identityMode, register, session } from "../../core/identity.js";
import { admitRoomConnection, match, roomPath } from "../../core/match.js";
import { COLLAB_PROTOCOL_VERSION, parsePool } from "../../core/protocol.js";
import { catalogResponse, songCatalog } from "../../core/songs.js";
import type { AppServices } from "../../core/ports.js";

const RATE_LIMITS = {
  register: 10,
  challenge: 30,
  session: 30,
  match: 60,
  named_lookup: 60,
  live_connect: 30,
  songs_lookup: 30,
} as const;

/** Transport hooks that differ between the Worker and the self-hosted server.
 *  The routing order, limits and error responses are shared. */
export interface RouterHooks {
  /** Hand a /room WebSocket over to the room transport. Called only after the
   *  upgrade header and the shared admission checks passed. */
  connectRoom(request: Request, services: AppServices, ticket: string, roomId: string): Promise<Response>;
  /** Hand the pool directory WebSocket over to the transport. */
  connectLiveDirectory(request: Request, services: AppServices, pool: string): Promise<Response>;
  /** Hand a room spectator WebSocket over to the transport. */
  connectSpectator(request: Request, services: AppServices, roomId: string): Promise<Response>;
  /** Static assets for anything that is not an API/WS/admin route. */
  serveStatic(request: Request): Promise<Response>;
}

async function rateAllowed(hooks: RouterHooks, request: Request, services: AppServices, kind: string, limit: number): Promise<boolean> {
  return services.rateLimit.allow(await services.clientKey(request), kind, limit, 60_000);
}

/** The one routing table shared by both deployments. */
export async function routeRequest(request: Request, services: AppServices, hooks: RouterHooks): Promise<Response> {
  requireSecrets(services.secrets);
  const url = new URL(request.url);
  if (url.pathname.startsWith("/admin")) return adminApi(services, request, url.pathname);
  const pool = roomPath(url.pathname);
  if (pool !== undefined) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return failure("WebSocket required", 426);
    const admission = await admitRoomConnection(services, request, pool);
    if (!admission.ok) return admission.response;
    return hooks.connectRoom(request, services, new URL(request.url).searchParams.get("ticket") ?? "", admission.ticket.roomId);
  }
  const guarded = request.method === "POST" && url.pathname === "/api/v1/identity/register" ? ["register", RATE_LIMITS.register] as const
    : request.method === "POST" && url.pathname === "/api/v1/identity/challenge" ? ["challenge", RATE_LIMITS.challenge] as const
    : request.method === "POST" && url.pathname === "/api/v1/identity/session" ? ["session", RATE_LIMITS.session] as const
    : request.method === "POST" && url.pathname === "/api/v1/match" ? ["match", RATE_LIMITS.match] as const
    : null;
  if (guarded && !await rateAllowed(hooks, request, services, guarded[0], guarded[1])) return failure("Rate limit exceeded", 429);
  if (request.method === "GET" && (url.pathname === "/api/v1/rooms" || url.pathname === "/api/v1/history" || url.pathname === "/api/v1/live") && url.searchParams.has("pool")
    && !await rateAllowed(hooks, request, services, "named_lookup", RATE_LIMITS.named_lookup)) return failure("Rate limit exceeded", 429);
  if (request.method === "GET" && url.pathname === "/api/v1/live" &&
    !await rateAllowed(hooks, request, services, "live_connect", RATE_LIMITS.live_connect)) return failure("Rate limit exceeded", 429);
  if (request.method === "POST" && url.pathname === "/api/v1/identity/register") return register(services, request);
  if (request.method === "POST" && url.pathname === "/api/v1/identity/challenge") return challenge(services, request);
  if (request.method === "POST" && url.pathname === "/api/v1/identity/session") return session(services, request);
  if (request.method === "GET" && url.pathname === "/api/v1/identity-mode") return response(await identityMode(services));
  if (request.method === "POST" && url.pathname === "/api/v1/match") return match(services, request);
  if (request.method === "POST" && url.pathname === "/api/v1/admin/reset") return adminReset(services, request);
  if (request.method === "GET" && url.pathname === "/api/v1/rooms") return response(await roomPage(services.directoryQueries, pageInput(url)));
  if (request.method === "GET" && url.pathname === "/api/v1/history") return response(await historyPage(services.directoryQueries, pageInput(url)));
  if (request.method === "GET" && url.pathname === "/api/v1/live") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return failure("WebSocket required", 426);
    return hooks.connectLiveDirectory(request, services, parsePool(url.searchParams.get("pool")) ?? "");
  }
  if (request.method === "GET" && url.pathname === "/api/v1/songs") {
    if (!await rateAllowed(hooks, request, services, "songs_lookup", RATE_LIMITS.songs_lookup)) return failure("Rate limit exceeded", 429);
    return catalogResponse(await songCatalog(services.catalogCache));
  }
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    await services.health.ping();
    return response({ ok: true, protocol: COLLAB_PROTOCOL_VERSION });
  }
  const spectate = /^\/api\/v1\/rooms\/([0-9a-f-]{36})\/live$/.exec(url.pathname);
  if (spectate && request.method === "GET") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return failure("WebSocket required", 426);
    if (!await rateAllowed(hooks, request, services, "live_connect", RATE_LIMITS.live_connect)) return failure("Rate limit exceeded", 429);
    return hooks.connectSpectator(request, services, spectate[1].toLowerCase());
  }
  if (url.pathname.startsWith("/api/")) return failure("Not found", 404);
  return hooks.serveStatic(request);
}
