import { expect } from "vitest";

/** Shared contract-suite fixtures and helpers. Both deployment harnesses drive
 *  the exact same scenario code through the ContractHarness interface. */

export interface ContractRequest {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Fixed client IP for rate-limit scenarios (Cloudflare only needs this; the
   *  self-hosted server keys on the real connection address). */
  ip?: string;
}

export interface WsInbox {
  /** Next text message (JSON-parsed) of the given type. */
  control(type: string): Promise<Record<string, unknown>>;
  /** Next binary relay frame. */
  binary(): Promise<ArrayBuffer>;
  /** Resolves when the socket closes; reason is the close text. */
  closed(): Promise<{ code: number; reason: string }>;
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  close(): void;
}

export interface ContractHarness {
  readonly backend: "cloudflare" | "selfhost";
  http(path: string, init?: ContractRequest): Promise<Response>;
  /** Admin call with valid credentials (Access JWT / password session). */
  admin(path: string, init?: ContractRequest): Promise<Response>;
  /** Admin call without credentials. */
  adminUnauthenticated(path: string, init?: ContractRequest): Promise<Response>;
  connectRoom(wsPath: string, ticket: string): Promise<WsInbox>;
  /** Read-only room live score feed. */
  connectSpectator(roomId: string): Promise<WsInbox>;
  watchDirectory(pool: string): Promise<WsInbox>;
  /** Status code of a rejected (failed) WebSocket upgrade. */
  rejectedUpgradeStatus(path: string): Promise<number>;
  /** Status the backend answers for unauthenticated admin API calls. */
  unauthorizedStatus(): number;
  /** Status of a login attempt; null when the backend has no login endpoint. */
  loginStatus(password: string): Promise<number | null>;
}

// --- shared fixtures --------------------------------------------------------

export const TEST_ORIGIN = "https://collab.example.test";

export const hashA = "a".repeat(64);
export const hashB = "b".repeat(64);
export const hashC = "c".repeat(64);

let requestCounter = 0;

export function testIp(): string {
  return `198.51.100.${++requestCounter % 254 + 1}`;
}

export function uniquePool(): string {
  return `test-${crypto.randomUUID()}`;
}

export function song(charts: Array<{ difficulty: number; sha256: string }> = [
  { difficulty: 0, sha256: hashA }, { difficulty: 2, sha256: hashB }, { difficulty: 3, sha256: hashC },
]) {
  return { id: 1000, title: "Test Overture", artist: "Example Artist", genre: "ORIGINAL", version: "1.50",
    selectedDifficulty: 3, level: 13.7, bpm: 180, designer: "Test Designer", charts };
}

export function anonKey(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64");
}

export async function expectWsError(harness: ContractHarness, wsPath: string, ticket: string, code: string): Promise<void> {
  const socket = await harness.connectRoom(wsPath, ticket);
  const message = await socket.control("error");
  expect(message.code).toBe(code);
  socket.close();
}
