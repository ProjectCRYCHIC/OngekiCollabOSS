import { IdentityInput, normalizeServer } from "./protocol.js";

const encoder = new TextEncoder();
function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function unbase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("Invalid base64");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function urlBase64(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unUrlBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid token");
  return unbase64(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
}

function keyBytes(secret: string): Uint8Array {
  const bytes = unbase64(secret);
  if (bytes.length !== 32) throw new Error("Secret must be 32 bytes");
  return bytes;
}

async function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const bytes = typeof secret === "string" ? keyBytes(secret) : secret;
  return crypto.subtle.importKey("raw", buffer(bytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmac(secret: string | Uint8Array, message: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message));
  return new Uint8Array(signature);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface IdentityHashes {
  keychipHash: string;
  accessHash: string;
  userHash: string;
  serverHash: string;
  compositeHash: string;
  serverDomain: string;
}

export async function identityHashes(secret: string, identity: IdentityInput): Promise<IdentityHashes> {
  const server = normalizeServer(identity.server);
  const [keychipHash, accessHash, userHash, serverHash] = await Promise.all([
    hmac(secret, `keychip\u0000${identity.keychipid}`),
    hmac(secret, `access\u0000${identity.accessCode}`),
    hmac(secret, `user\u0000${identity.userId}`),
    hmac(secret, `server-host\u0000${server.host}`),
  ]).then((values) => values.map(hex));
  const compositeHash = hex(await hmac(secret, `identity\u0000${keychipHash}\u0000${accessHash}\u0000${userHash}\u0000${serverHash}`));
  return { keychipHash, accessHash, userHash, serverHash, compositeHash, serverDomain: server.domain };
}

export async function encryptClientKey(secret: string, clientKey: Uint8Array): Promise<string> {
  if (clientKey.length !== 32) throw new Error("Invalid client key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", buffer(keyBytes(secret)), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv) }, key, buffer(clientKey)));
  return `${base64(iv)}.${base64(ciphertext)}`;
}

export async function decryptClientKey(secret: string, encrypted: string): Promise<Uint8Array> {
  const parts = encrypted.split(".");
  if (parts.length !== 2) throw new Error("Invalid encrypted key");
  const iv = unbase64(parts[0]);
  if (iv.length !== 12) throw new Error("Invalid encrypted key");
  const key = await crypto.subtle.importKey("raw", buffer(keyBytes(secret)), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(iv) }, key, buffer(unbase64(parts[1]))));
}

export async function sameClientKey(bound: Uint8Array, proposed: Uint8Array): Promise<boolean> {
  if (bound.length !== 32 || proposed.length !== 32) return false;
  const message = encoder.encode("OngekiCollab/v1/register-retry");
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(proposed), message);
  return crypto.subtle.verify("HMAC", await hmacKey(bound), signature, message);
}

export async function verifyProof(clientKey: Uint8Array, challengeId: string, nonce: string, proof: string): Promise<boolean> {
  let bytes: Uint8Array;
  try { bytes = unbase64(proof); } catch { return false; }
  if (bytes.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(clientKey), buffer(bytes),
    encoder.encode(`OngekiCollab/v1/session\n${challengeId}\n${nonce}`));
}

export function randomBase64(byteCount: number): string {
  return base64(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export async function signToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = urlBase64(encoder.encode(JSON.stringify(payload)));
  return `${body}.${urlBase64(await hmac(secret, body))}`;
}

export async function verifyToken<T extends { type: string; exp: number }>(secret: string, token: string, type: string): Promise<T | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const signature = unUrlBase64(parts[1]);
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), buffer(signature), encoder.encode(parts[0]));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(unUrlBase64(parts[0]))) as T;
    if (payload.type !== type || typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    return payload;
  } catch { return null; }
}
