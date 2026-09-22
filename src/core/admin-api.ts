import { body, failure, response } from "./http.js";
import { identityMode } from "./identity.js";
import { listBattles, listPlayers } from "./management.js";
import type { AppServices } from "./ports.js";

/** CSRF/same-origin guard for admin mutations: matching origin, same-origin
 *  fetch metadata and a JSON content type must all be present. */
export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return origin === new URL(request.url).origin && (!fetchSite || fetchSite === "same-origin") &&
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

/** Admin API surface. Authentication is injected via services.adminAuth so the
 *  same handlers serve Cloudflare Access and self-hosted password sessions.
 *  Non-API /admin paths fall through to the injected static renderer. */
async function rateAllowed(services: AppServices, request: Request, kind: string, limit: number): Promise<boolean> {
  return services.rateLimit.allow(await services.clientKey(request), kind, limit, 60_000);
}

export async function adminApi(services: AppServices, request: Request, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  // Session lifecycle endpoints run before the auth gate; /admin/api/session is
  // public so the SPA can detect an unauthenticated self-hosted console.
  if (pathname === "/admin/api/session" && method === "GET")
    return response({ authenticated: await services.adminAuth.authenticate(request) });
  if (pathname === "/admin/api/login" && method === "POST") {
    if (!services.adminSession) return failure("Not found", 404);
    if (!await rateAllowed(services, request, "admin_login", 10)) return failure("Rate limit exceeded", 429);
    if (!sameOriginMutation(request)) return failure("Forbidden", 403);
    return services.adminSession.login(request);
  }
  if (pathname === "/admin/api/logout" && method === "POST") {
    if (!services.adminSession) return failure("Not found", 404);
    if (!sameOriginMutation(request)) return failure("Forbidden", 403);
    return services.adminSession.logout(request);
  }
  // The unauthenticated /admin/login page itself must be reachable.
  if (pathname === "/admin/login" && (method === "GET" || method === "HEAD"))
    return services.serveAdminStatic(request, "/admin/login");
  // Self-hosted deployments serve the console shell (HTML/JS/CSS) publicly:
  // the SPA detects the missing session and bounces to /admin/login. Every
  // data endpoint below stays authenticated. Cloudflare keeps the shell
  // behind the Access-checked static branch at the end of this handler.
  const consoleShell = (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin.html" ||
    pathname === "/admin.js" || pathname === "/admin.css") && (method === "GET" || method === "HEAD");
  if (consoleShell && services.adminSession)
    return services.serveAdminStatic(request, pathname === "/admin.js" || pathname === "/admin.css" ? pathname : "/admin");
  if (!await services.adminAuth.authenticate(request)) return failure("Forbidden", services.adminSession ? services.adminSession.unauthorizedStatus : 403);
  if (pathname === "/admin/api/identity-mode") {
    if (request.method === "GET") return response(await identityMode(services));
    if (request.method !== "PUT") return failure("Method not allowed", 405);
    if (!sameOriginMutation(request)) return failure("Forbidden", 403);
    const input = await body(request, 128);
    if (typeof input.required !== "boolean" || Object.keys(input).length !== 1) return failure("Invalid mode", 400);
    const updatedAt = Date.now();
    await services.settings.setIdentityRequired(input.required, updatedAt);
    return response({ required: input.required, updatedAt });
  }
  if (pathname === "/admin/api/players" && request.method === "GET") return response(await listPlayers(services.adminQueries, url));
  if (pathname === "/admin/api/battles" && request.method === "GET") return response(await listBattles(services.adminQueries, url));
  const playerAction = /^\/admin\/api\/players\/([^/]+)\/(ban|unban)$/.exec(pathname);
  if (playerAction && request.method === "POST") {
    if (!sameOriginMutation(request)) return failure("Forbidden", 403);
    let playerId: string;
    try { playerId = decodeURIComponent(playerAction[1]); }
    catch { return failure("Invalid player", 400); }
    if (!/^(?:[0-9a-f-]{36}|anon:[0-9a-f]{64})$/i.test(playerId)) return failure("Invalid player", 400);
    const input = await body(request, 512);
    if (playerAction[2] === "ban") {
      const reason = input.reason === undefined ? null : input.reason;
      if (reason !== null && reason !== "abuse" && reason !== "disruption" && reason !== "other") return failure("Invalid reason", 400);
      const updated = await services.playerControls.ban(playerId, reason, Date.now());
      if (!updated) return failure("Player not found", 404);
      const rooms = await services.playerControls.activeRoomIdsFor(playerId);
      const outcomes = await Promise.allSettled(rooms.map((room) => services.rooms.banPlayer(room, playerId)));
      return response({ banned: true, disconnectedRooms: outcomes.filter((item) => item.status === "fulfilled" && item.value).length,
        failedRooms: outcomes.filter((item) => item.status === "rejected").length });
    }
    if (Object.keys(input).length) return failure("Invalid request", 400);
    const updated = await services.playerControls.unban(playerId);
    if (!updated) return failure("Player not found", 404);
    return response({ banned: false });
  }
  const battleAction = /^\/admin\/api\/battles\/([0-9a-f-]{36})\/close$/i.exec(pathname);
  if (battleAction && request.method === "POST") {
    if (!sameOriginMutation(request)) return failure("Forbidden", 403);
    if (Object.keys(await body(request, 128)).length) return failure("Invalid request", 400);
    const closed = await services.rooms.forceClose(battleAction[1]);
    return closed ? response({ closed: true }) : failure("Battle not found", 404);
  }
  if (method !== "GET" && method !== "HEAD") return failure("Method not allowed", 405);
  if (!["/admin", "/admin/", "/admin.html", "/admin.js", "/admin.css"].includes(pathname)) return failure("Not found", 404);
  // Static assets redirect an explicit /admin.html fetch back to /admin (default
  // html_handling), which would loop forever through this route; the extensionless
  // path serves the admin.html content directly.
  const assetPath = pathname === "/admin.js" || pathname === "/admin.css" ? pathname : "/admin";
  return services.serveAdminStatic(request, assetPath);
}

/** Keyed admin reset endpoint (POST /api/v1/admin/reset): shared by both
 *  deployments via the ADMIN_RESET_SECRET API key, not via admin sessions. */
export async function adminReset(services: AppServices, request: Request): Promise<Response> {
  const key = request.headers.get("x-admin-key") ?? "";
  if (!services.secrets.adminReset || key !== services.secrets.adminReset) return failure("Forbidden", 403);
  const input = await body(request, 1024);
  const identityId = String(input.identityId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(identityId)) return failure("Invalid identity", 400);
  await services.identities.deleteWithChallenges(identityId);
  return response({ reset: true });
}
