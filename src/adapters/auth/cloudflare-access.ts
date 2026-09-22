import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../../types.js";
import type { AdminAuthenticator } from "../../core/ports.js";

function accessIssuer(teamDomain: string): string | null {
  try {
    const url = new URL(teamDomain);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(url.hostname) ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/** Cloudflare Zero Trust / Access JWT authentication for /admin/api. Missing or
 *  invalid configuration always fails closed (never authenticates). */
export function createAccessAdminAuth(env: Env): AdminAuthenticator {
  return {
    async authenticate(request: Request): Promise<boolean> {
      const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
      const token = request.headers.get("cf-access-jwt-assertion");
      if (!issuer || !env.ACCESS_AUD || !token) return false;
      try {
        await jwtVerify(token, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), {
          issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"],
        });
        return true;
      } catch { return false; }
    },
  };
}
