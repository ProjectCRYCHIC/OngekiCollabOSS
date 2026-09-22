import type { RoomSocket, RoomSocketRegistry } from "../../../core/rooms/engine.js";
import type { RoomDelivery } from "../../../core/rooms/delivery.js";
import type { SocketData } from "../../../core/rooms/types.js";

/** Wraps a hibernating WebSocket plus its serialized attachment as a RoomSocket. */
export class HibernationRoomSocket implements RoomSocket {
  constructor(private readonly socket: WebSocket, private readonly ctx: DurableObjectState, readonly data: SocketData) {}

  send(message: string): unknown { return this.socket.send(message); }
  sendBinary(bytes: Uint8Array): unknown { return this.socket.send(bytes); }
  close(code: number, reason: string): unknown { return this.socket.close(code, reason); }
  save(): void { this.socket.serializeAttachment(this.data); }
}

/** Per-DO socket registry backed by ctx.getWebSockets() and attachments. */
export class HibernationRegistry implements RoomSocketRegistry {
  private readonly wrapped = new WeakMap<WebSocket, HibernationRoomSocket>();

  constructor(private readonly ctx: DurableObjectState) {}

  /** Register a freshly accepted WebSocket with its attachment data. */
  attach(socket: WebSocket, data: SocketData): HibernationRoomSocket {
    socket.serializeAttachment(data);
    const wrapped = new HibernationRoomSocket(socket, this.ctx, data);
    this.wrapped.set(socket, wrapped);
    return wrapped;
  }

  sockets(): RoomSocket[] {
    const out: RoomSocket[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const wrapped = this.resolve(socket);
      if (wrapped) out.push(wrapped);
    }
    return out;
  }

  /** Returns the wrapper for an event-delivered WebSocket, or null when no
   *  attachment exists (the original engine closed such sockets with 1008). */
  resolve(socket: WebSocket): HibernationRoomSocket | null {
    const existing = this.wrapped.get(socket);
    if (existing) return existing;
    const data = socket.deserializeAttachment() as SocketData | null;
    if (!data) return null;
    const wrapped = new HibernationRoomSocket(socket, this.ctx, data);
    this.wrapped.set(socket, wrapped);
    return wrapped;
  }
}

/** Cloudflare fan-out: loops the DO's hibernating WebSockets, mirroring the
 *  engine's original per-socket filters exactly. */
export class HibernationDelivery implements RoomDelivery {
  constructor(private readonly registry: HibernationRegistry) {}

  broadcastText(text: string, exceptPeerId = 0): void {
    for (const socket of this.registry.sockets()) {
      const data = socket.data;
      if (!data || data.peerId === exceptPeerId) continue;
      try { socket.send(text); } catch { /* Close event reconciles membership. */ }
    }
  }

  notifySpectators(text: string): void {
    for (const socket of this.registry.sockets()) {
      if (!socket.data.spectator) continue;
      try { socket.send(text); } catch { /* Close event reconciles. */ }
    }
  }

  forwardFrame(data: Uint8Array, senderPeerId: number, targetPeerId: number | null): void {
    for (const socket of this.registry.sockets()) {
      const target = socket.data;
      if (!target || target.peerId === senderPeerId || (targetPeerId !== null && target.peerId !== targetPeerId)) continue;
      try { socket.sendBinary(data); } catch { /* Close event reconciles membership. */ }
    }
  }

  closePeer(peerId: number, identityId: string, code: number, reason: string): void {
    for (const socket of this.registry.sockets()) {
      const data = socket.data;
      if (data?.peerId === peerId && data.identityId === identityId) {
        try { socket.close(code, reason); } catch { /* already closed */ }
      }
    }
  }

  closeAll(code: number, reason: string): void {
    for (const socket of this.registry.sockets()) {
      try { socket.close(code, reason); } catch { /* already closed */ }
    }
  }
}
