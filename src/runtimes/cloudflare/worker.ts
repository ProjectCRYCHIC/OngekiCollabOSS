import type { Env } from "../../types.js";
import { createAccessAdminAuth } from "../../adapters/auth/cloudflare-access.js";
import { createCatalogCache, createPoolRealtime, createRateLimit, createRoomRealtime } from "../../adapters/realtime/cloudflare.js";
import { createD1DataStores } from "../../adapters/database/d1/index.js";
import { runCleanup } from "../../core/cleanup.js";
import { routeError } from "../../core/http.js";
import { routeRequest } from "../shared/router.js";
import type { RouterHooks } from "../shared/router.js";
import type { AppServices } from "../../core/ports.js";

export { PoolCoordinator, RateGuard, RelayRoom, PoolDirectory } from "../../adapters/realtime/durable-objects/index.js";

async function clientKey(request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ADMIN_STATIC_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function servicesFromEnv(env: Env): AppServices {
  return {
    clientKey,
    secrets: {
      identityHash: env.IDENTITY_HASH_SECRET,
      keyEncryption: env.KEY_ENCRYPTION_SECRET,
      ticketSigning: env.TICKET_SIGNING_SECRET,
      adminReset: env.ADMIN_RESET_SECRET,
    },
    ...createD1DataStores(env.DB),
    rooms: createRoomRealtime(env),
    pools: createPoolRealtime(env),
    rateLimit: createRateLimit(env),
    catalogCache: createCatalogCache(),
    adminAuth: createAccessAdminAuth(env),
    serveAdminStatic: async (request, assetPath) => {
      const asset = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
      const headers = new Headers(asset.headers);
      for (const [name, value] of Object.entries(ADMIN_STATIC_HEADERS)) headers.set(name, value);
      return new Response(asset.body, { status: asset.status, headers });
    },
  };
}

function hooksFromEnv(env: Env): RouterHooks {
  return {
    async connectRoom(_request, _services, ticket, roomId): Promise<Response> {
      const forwarded = new Request("https://room.internal/connect", { headers: { Upgrade: "websocket", "X-Room-Ticket": ticket } });
      return env.ROOMS.getByName(roomId).fetch(forwarded);
    },
    async connectLiveDirectory(_request, _services, pool): Promise<Response> {
      const forwarded = new Request(`https://directory.internal/live?pool=${encodeURIComponent(pool)}`, {
        headers: { Upgrade: "websocket" },
      });
      return env.DIRECTORIES.getByName(`live:${pool}`).fetch(forwarded);
    },
    async connectSpectator(_request, _services, roomId): Promise<Response> {
      return env.ROOMS.getByName(roomId).fetch(
        new Request("https://room.internal/spectate", { headers: { Upgrade: "websocket", "X-Spectator": "1" } }));
    },
    serveStatic(request: Request): Promise<Response> {
      return env.ASSETS.fetch(request);
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, servicesFromEnv(env), hooksFromEnv(env));
    } catch (cause) {
      return routeError(cause);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runCleanup(servicesFromEnv(env).cleanup, Date.now());
  },
} satisfies ExportedHandler<Env>;
