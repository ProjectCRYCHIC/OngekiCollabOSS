import { decryptClientKey, encryptClientKey, identityHashes, randomBase64, sameClientKey, signToken, unbase64, verifyProof, verifyToken } from "./crypto.js";
import { parseIdentity } from "./protocol.js";
import { body, failure, response } from "./http.js";
import { UniqueConstraintError } from "./ports.js";
import type { AppServices, IdentityBinding, IdentityRow } from "./ports.js";
import type { SessionToken } from "./tokens.js";

function sameHashes(row: IdentityRow, hashes: Awaited<ReturnType<typeof identityHashes>>): boolean {
  return row.keychip_hash === hashes.keychipHash && row.access_hash === hashes.accessHash && row.user_hash === hashes.userHash &&
    row.server_hash === hashes.serverHash && row.composite_hash === hashes.compositeHash;
}

export async function register(services: AppServices, request: Request): Promise<Response> {
  const input = await body(request, 4096);
  const identity = parseIdentity(input);
  const clientKey = unbase64(String(input.clientKey ?? ""));
  if (clientKey.length !== 32) return failure("Invalid client key");
  const hashes = await identityHashes(services.secrets.identityHash, identity);
  const existingBinding = () => services.identities.findBinding(hashes);
  async function retryOrConflict(existing: IdentityBinding | null): Promise<Response> {
    if (existing?.composite_hash === hashes.compositeHash) {
      const boundKey = await decryptClientKey(services.secrets.keyEncryption, existing.encrypted_key);
      if (await sameClientKey(boundKey, clientKey)) {
        await services.playerControls.record(existing.id, "registered", "", hashes.serverDomain, Date.now());
        return response({ identityId: existing.id });
      }
    }
    return failure("Identity already bound; administrator reset required", 409);
  }
  const existing = await existingBinding();
  if (existing) return retryOrConflict(existing);
  const identityId = crypto.randomUUID();
  const now = Date.now();
  const encrypted = await encryptClientKey(services.secrets.keyEncryption, clientKey);
  try {
    await services.identities.create({ id: identityId, hashes, encryptedKey: encrypted, now });
  } catch (cause) {
    if (cause instanceof UniqueConstraintError) return retryOrConflict(await existingBinding());
    throw cause;
  }
  await services.playerControls.record(identityId, "registered", "", hashes.serverDomain, now);
  return response({ identityId }, 201);
}

export async function challenge(services: AppServices, request: Request): Promise<Response> {
  const input = await body(request, 1024);
  const identityId = String(input.identityId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(identityId)) return failure("Invalid identity", 400);
  if (!await services.identities.exists(identityId)) return failure("Identity not found", 404);
  const challengeId = crypto.randomUUID();
  const nonce = randomBase64(32);
  await services.challenges.create({ id: challengeId, identityId, nonce, expiresAt: Date.now() + 120_000 });
  return response({ challengeId, nonce });
}

export async function session(services: AppServices, request: Request): Promise<Response> {
  const input = await body(request, 4096);
  const identityId = String(input.identityId ?? "");
  const challengeId = String(input.challengeId ?? "");
  const proof = String(input.proof ?? "");
  const identityInput = parseIdentity(input.identity);
  const [identity, challengeRow] = await Promise.all([
    services.identities.findById(identityId),
    services.challenges.find(challengeId, identityId),
  ]);
  if (!identity || !challengeRow || challengeRow.used_at || challengeRow.expires_at <= Date.now()) return failure("Authentication failed", 401);
  const clientKey = await decryptClientKey(services.secrets.keyEncryption, identity.encrypted_key);
  if (!await verifyProof(clientKey, challengeId, challengeRow.nonce, proof)) return failure("Authentication failed", 401);
  const hashes = await identityHashes(services.secrets.identityHash, identityInput);
  const sameCore = identity.keychip_hash === hashes.keychipHash && identity.access_hash === hashes.accessHash &&
    identity.user_hash === hashes.userHash;
  if (!sameCore) return failure("Identity fields changed", 403);
  if (!sameHashes(identity, hashes)) {
    // Legacy rows hashed the entire game API URI. Migrate only a proven client key
    // whose other identity fields and recorded public hostname still match.
    if (identity.server_domain === "private-host" || identity.server_domain !== hashes.serverDomain)
      return failure("Identity fields changed", 403);
    const migrated = await services.identities.migrateServerHash(identityId, hashes, identity, Date.now());
    if (!migrated) {
      const latest = await services.identities.findById(identityId);
      if (!latest || !sameHashes(latest, hashes)) return failure("Identity fields changed", 403);
    }
  }
  const used = await services.challenges.consume(challengeId, Date.now());
  if (!used) return failure("Challenge already used", 401);
  const expiresAt = Date.now() + 15 * 60_000;
  const token = await signToken(services.secrets.ticketSigning, { type: "session", identityId, exp: expiresAt });
  return response({ token, expiresAt });
}

export async function authenticate(services: AppServices, request: Request): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = await verifyToken<SessionToken>(services.secrets.ticketSigning, header.slice(7), "session");
  return token?.identityId ?? null;
}

export async function identityMode(services: AppServices): Promise<{ required: boolean; updatedAt: number | null }> {
  return services.settings.getIdentityRequired();
}
