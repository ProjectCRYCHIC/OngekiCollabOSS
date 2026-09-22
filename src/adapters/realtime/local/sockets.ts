import type { WebSocket } from "ws";
import type { RoomSocket, RoomSocketRegistry } from "../../../core/rooms/engine.js";
import type { SocketData } from "../../../core/rooms/types.js";

/** A player or spectator connection served by this process. */
export class LocalSocket implements RoomSocket {
  readonly data: SocketData;

  constructor(readonly ws: WebSocket, data: SocketData) {
    this.data = data;
  }

  send(message: string): void { this.ws.send(message); }
  sendBinary(bytes: Uint8Array): void { this.ws.send(bytes); }
  close(code: number, reason: string): void { this.ws.close(code, reason); }
  save(): void { /* attachment state lives inline on this object */ }
}

/** Per-process connection registry, shared by both Redis and memory modes. */
export class LocalRoomRegistry {
  private readonly rooms = new Map<string, Set<LocalSocket>>();

  add(roomId: string, socket: LocalSocket): void {
    let set = this.rooms.get(roomId);
    if (!set) { set = new Set(); this.rooms.set(roomId, set); }
    set.add(socket);
  }

  remove(roomId: string, socket: LocalSocket): void {
    const set = this.rooms.get(roomId);
    if (!set) return;
    set.delete(socket);
    if (!set.size) this.rooms.delete(roomId);
  }

  socketsFor(roomId: string): LocalSocket[] {
    return [...(this.rooms.get(roomId) ?? [])];
  }

  view(roomId: string): RoomSocketRegistry {
    return { sockets: () => this.socketsFor(roomId) };
  }
}
