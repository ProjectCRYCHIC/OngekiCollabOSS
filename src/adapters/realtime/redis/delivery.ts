import type Redis from "ioredis";
import type { RoomDelivery } from "../../../core/rooms/delivery.js";
import type { LocalRoomRegistry } from "../local/sockets.js";

export type RoomBusMessage =
  | { op: "text"; roomId: string; text: string; exceptPeerId?: number; spectatorsOnly?: boolean; onlyPeerId?: number; from: string }
  | { op: "binary"; roomId: string; data: string; senderPeerId: number; targetPeerId: number | null; from: string }
  | { op: "close"; roomId: string; code: number; reason: string; peerId?: number; identityId?: string; from: string };

export const roomChannel = (roomId: string) => `bus:room:${roomId}`;
export const liveChannel = (pool: string) => `bus:live:${pool}`;

/** Identifies this process on the bus; the subscriber drops echoes of messages
 *  this instance published (they were already delivered locally). */
export const INSTANCE_ID = crypto.randomUUID();

/** Fan-out for one room: deliver to local connections, then mirror the operation
 *  on Redis pub/sub so every other instance delivers to its own connections. */
export class RedisRoomDelivery implements RoomDelivery {
  constructor(private readonly roomId: string, private readonly registry: LocalRoomRegistry, private readonly publisher: Redis) {}

  private publish(message: RoomBusMessage): void {
    this.publisher.publish(roomChannel(this.roomId), JSON.stringify(message))
      .catch(() => { console.warn("Room bus publish failed"); });
  }

  broadcastText(text: string, exceptPeerId = 0): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (socket.data.peerId === exceptPeerId) continue;
      try { socket.send(text); } catch { /* Close event reconciles membership. */ }
    }
    this.publish({ op: "text", roomId: this.roomId, text, exceptPeerId, from: INSTANCE_ID });
  }

  notifySpectators(text: string): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (!socket.data.spectator) continue;
      try { socket.send(text); } catch { /* Close event reconciles. */ }
    }
    this.publish({ op: "text", roomId: this.roomId, text, spectatorsOnly: true, from: INSTANCE_ID });
  }

  forwardFrame(data: Uint8Array, senderPeerId: number, targetPeerId: number | null): void {
    const payload = Buffer.from(data).toString("base64");
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (socket.data.peerId === senderPeerId) continue;
      if (targetPeerId !== null && socket.data.peerId !== targetPeerId) continue;
      try { socket.sendBinary(data); } catch { /* Close event reconciles membership. */ }
    }
    this.publish({ op: "binary", roomId: this.roomId, data: payload, senderPeerId, targetPeerId, from: INSTANCE_ID });
  }

  closePeer(peerId: number, identityId: string, code: number, reason: string): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      if (socket.data.peerId !== peerId || socket.data.identityId !== identityId) continue;
      try { socket.close(code, reason); } catch { /* already closed */ }
    }
    this.publish({ op: "close", roomId: this.roomId, code, reason, peerId, identityId, from: INSTANCE_ID });
  }

  closeAll(code: number, reason: string): void {
    for (const socket of this.registry.socketsFor(this.roomId)) {
      try { socket.close(code, reason); } catch { /* already closed */ }
    }
    this.publish({ op: "close", roomId: this.roomId, code, reason, from: INSTANCE_ID });
  }
}

/** Applies a mirrored room bus message to this instance's local connections. */
export function applyRoomBusMessage(registry: LocalRoomRegistry, message: RoomBusMessage, selfId: string): void {
  if (message.from === selfId) return;
  const sockets = registry.socketsFor(message.roomId);
  if (!sockets.length) return;
  if (message.op === "text") {
    for (const socket of sockets) {
      if (message.exceptPeerId !== undefined && socket.data.peerId === message.exceptPeerId) continue;
      if (message.onlyPeerId !== undefined && socket.data.peerId !== message.onlyPeerId) continue;
      if (message.spectatorsOnly && !socket.data.spectator) continue;
      try { socket.send(message.text); } catch { /* Close event reconciles. */ }
    }
    return;
  }
  if (message.op === "binary") {
    const bytes = Buffer.from(message.data, "base64");
    for (const socket of sockets) {
      if (socket.data.peerId === message.senderPeerId) continue;
      if (message.targetPeerId !== null && socket.data.peerId !== message.targetPeerId) continue;
      try { socket.sendBinary(bytes); } catch { /* Close event reconciles membership. */ }
    }
    return;
  }
  for (const socket of sockets) {
    if (message.peerId !== undefined) {
      if (socket.data.peerId !== message.peerId || socket.data.identityId !== message.identityId) continue;
    }
    try { socket.close(message.code, message.reason); } catch { /* already closed */ }
  }
}
