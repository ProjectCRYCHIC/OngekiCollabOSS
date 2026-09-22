export interface ChartHash {
  difficulty: number;
  sha256: string;
}

export interface SongManifest {
  id: number;
  title: string;
  artist: string;
  genre: string;
  version: string;
  selectedDifficulty: number;
  level: number;
  bpm: number;
  designer: string;
  charts: ChartHash[];
}

export interface MatchRequest {
  protocolVersion: number;
  pool: string | null;
  roomId: string | null;
  gameVersion: string;
  username: string;
  cardId?: number;
  song: SongManifest;
}

export interface IdentityInput {
  keychipid: string;
  accessCode: string;
  userId: string;
  server: string;
}

export interface BinaryFrame {
  kind: 1 | 2 | 3 | 4;
  sender: number;
  target: number;
  streamId: number;
  sequence: number;
  payload: Uint8Array;
}

export const FRAME_HEADER_BYTES = 22;
export const MAX_FRAME_PAYLOAD = 4096;
export const MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;
export const COLLAB_PROTOCOL_VERSION = 1;
const textEncoder = new TextEncoder();

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${label}`);
  return value as number;
}

export function parsePool(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const name = stringField(value, "pool", 64);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid pool");
  return name;
}

export function parseIdentity(value: unknown): IdentityInput {
  const raw = record(value);
  const identity = {
    keychipid: stringField(raw.keychipid, "keychipid", 128).trim(),
    accessCode: stringField(raw.accessCode, "accessCode", 128).trim(),
    userId: stringField(raw.userId, "userId", 128).trim(),
    server: stringField(raw.server, "server", 512).trim(),
  };
  if (Object.values(identity).some((field) => field.length === 0)) throw new Error("Invalid identity fields");
  return identity;
}

export function normalizeServer(server: string): { value: string; host: string; domain: string } {
  const url = new URL(server.includes("://") ? server : `https://${server}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid server");
  if (url.username || url.password || !url.hostname) throw new Error("Invalid server");
  const hostname = url.hostname.toLowerCase();
  const domain = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(hostname) ? hostname : "private-host";
  return { value: url.toString(), host: hostname, domain };
}

export function parseSong(value: unknown): SongManifest {
  const raw = record(value);
  if (!Array.isArray(raw.charts) || raw.charts.length < 1 || raw.charts.length > 5) throw new Error("Invalid charts");
  const charts = raw.charts.map((item) => {
    const chart = record(item);
    const difficulty = integer(chart.difficulty, "difficulty", 0, 4);
    if (typeof chart.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(chart.sha256)) throw new Error("Invalid chart hash");
    return { difficulty, sha256: chart.sha256.toLowerCase() };
  }).sort((a, b) => a.difficulty - b.difficulty);
  if (new Set(charts.map((chart) => chart.difficulty)).size !== charts.length) throw new Error("Duplicate difficulty");
  const selectedDifficulty = integer(raw.selectedDifficulty, "selectedDifficulty", 0, 4);
  if (!charts.some((chart) => chart.difficulty === selectedDifficulty)) throw new Error("Selected difficulty missing");
  const level = Number(raw.level);
  if (!Number.isFinite(level) || level < 0 || level > 100) throw new Error("Invalid level");
  return {
    id: integer(raw.id, "music id", 1, 999999),
    title: stringField(raw.title, "title", 256),
    artist: stringField(raw.artist, "artist", 256, 0),
    genre: stringField(raw.genre, "genre", 128, 0),
    version: stringField(raw.version, "song version", 64),
    selectedDifficulty,
    level,
    bpm: integer(raw.bpm, "bpm", 0, 1000),
    designer: stringField(raw.designer, "designer", 128, 0),
    charts,
  };
}

function parseRoomId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Invalid room");
  return value.toLowerCase();
}

export function parseMatch(value: unknown): MatchRequest {
  const raw = record(value);
  return {
    protocolVersion: integer(raw.protocolVersion, "protocolVersion", COLLAB_PROTOCOL_VERSION, COLLAB_PROTOCOL_VERSION),
    pool: parsePool(raw.pool),
    roomId: parseRoomId(raw.roomId),
    gameVersion: stringField(raw.gameVersion, "gameVersion", 64),
    username: stringField(raw.username, "username", 64),
    // Optional for wire compatibility with older clients. New clients send the
    // native profile card id so the public recruit list can render the host icon.
    cardId: integer(raw.cardId ?? 0, "cardId", 0, 999999),
    song: parseSong(raw.song),
  };
}

export function encodeFrame(frame: BinaryFrame): Uint8Array {
  if (frame.payload.length > MAX_FRAME_PAYLOAD) throw new Error("Frame too large");
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4f43);
  view.setUint8(2, 1);
  view.setUint8(3, frame.kind);
  view.setUint32(4, frame.sender);
  view.setUint32(8, frame.target);
  view.setUint32(12, frame.streamId);
  view.setUint32(16, frame.sequence);
  view.setUint16(20, frame.payload.length);
  bytes.set(frame.payload, FRAME_HEADER_BYTES);
  return bytes;
}

export function decodeFrame(input: ArrayBuffer | Uint8Array): BinaryFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < FRAME_HEADER_BYTES || bytes.length > FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD) throw new Error("Invalid frame length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0x4f43 || view.getUint8(2) !== 1) throw new Error("Invalid frame header");
  const kind = view.getUint8(3);
  if (kind < 1 || kind > 4 || view.getUint16(20) !== bytes.length - FRAME_HEADER_BYTES) throw new Error("Invalid frame payload");
  return {
    kind: kind as BinaryFrame["kind"], sender: view.getUint32(4), target: view.getUint32(8),
    streamId: view.getUint32(12), sequence: view.getUint32(16), payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

export function utf8Size(value: string): number {
  return textEncoder.encode(value).byteLength;
}
