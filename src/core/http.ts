export const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function response(value: unknown, status = 200): Response { return Response.json(value, { status, headers: NO_STORE }); }

export function failure(message: string, status = 400): Response { return response({ error: message }, status); }

export async function body(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new Error("Request too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error("Request too large");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}

/** Shared boundary classification for handler errors: client faults become 400
 *  responses with the thrown message, everything else a generic 500. */
export function routeError(cause: unknown): Response {
  if (cause instanceof SyntaxError || cause instanceof TypeError || (cause instanceof Error && /^(Invalid|Expected|Duplicate|Selected|Request too large)/.test(cause.message))) {
    return failure(cause instanceof Error ? cause.message : "Invalid request");
  }
  console.error("Request failed", cause instanceof Error ? cause.name : "unknown");
  return failure("Internal error", 500);
}

export function requireSecrets(secrets: { identityHash: string; keyEncryption: string; ticketSigning: string }): void {
  if (!secrets.identityHash || !secrets.keyEncryption || !secrets.ticketSigning) throw new Error("Server secrets unavailable");
}
