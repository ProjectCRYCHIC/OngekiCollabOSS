/** Stable per-pool coordinator identifier. Both deployments address a pool's
 *  coordinating entity by this name: the Durable Object instance name on
 *  Cloudflare, the pool lock key self-hosted. */
export async function coordinatorName(pool: string | null): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pool:${pool ?? ""}`)));
  return `pool-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
