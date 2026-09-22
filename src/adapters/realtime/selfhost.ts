import type { MatchRequest } from "../../core/protocol.js";
import type { PoolRealtimeService, RateLimitService, Reservation, RoomRealtimeService, Seat } from "../../core/ports.js";
import type { RoomTicket } from "../../core/tokens.js";
import type { LocalSocket } from "./local/sockets.js";

export interface SelfhostRoomService extends RoomRealtimeService {
  initializeRoom(roomId: string, coordinator: string, request: MatchRequest): Promise<void>;
  reserve(roomId: string, reservation: Reservation): Promise<Seat | null>;
  validatePlayerConnection(roomId: string, payload: RoomTicket | null): Promise<Response | { ok: true }>;
  completePlayerConnection(roomId: string, socket: LocalSocket, payload: RoomTicket): Promise<void>;
  validateSpectator(roomId: string): Promise<Response | { ok: true }>;
  addSpectator(roomId: string, socket: LocalSocket): Promise<void>;
  detach(roomId: string, socket: LocalSocket): void;
  onMessage(roomId: string, socket: LocalSocket, message: string | ArrayBuffer | Uint8Array): Promise<void>;
  onClose(roomId: string, socket: LocalSocket, reason: string): Promise<void>;
}

export interface SelfhostDirectoryService {
  attach(pool: string, socket: LocalSocket): Promise<string>;
  detach(pool: string, socket: LocalSocket): void;
}

/** Runtime-neutral self-host realtime bundle. Redis supports multi-instance
 * coordination; memory is intentionally single-process, but both drive the
 * exact same RoomEngine and core ports. */
export interface SelfhostRealtime {
  rooms: SelfhostRoomService;
  pools: PoolRealtimeService;
  rateLimit: RateLimitService;
  directory: SelfhostDirectoryService;
  start(): void | Promise<void>;
  health(): Promise<void>;
  stop(): void;
}
