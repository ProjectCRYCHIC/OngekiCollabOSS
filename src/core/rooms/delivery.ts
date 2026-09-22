/** Fan-out of room events to connected sockets. Cloudflare implements this over
 *  hibernation WebSockets; self-hosted over the local socket registry plus a
 *  Redis pub/sub bus so every instance delivers to its own connections. */
export interface RoomDelivery {
  /** Text to every participant except one (0 = nobody excluded). */
  broadcastText(text: string, exceptPeerId?: number): void;
  /** Text to spectators only (room live score feed). */
  notifySpectators(text: string): void;
  /** Binary relay frame from sender to everyone (targetPeerId null) or one peer. */
  forwardFrame(data: Uint8Array, senderPeerId: number, targetPeerId: number | null): void;
  /** Close the matching participant connection (peer id and identity must both match). */
  closePeer(peerId: number, identityId: string, code: number, reason: string): void;
  /** Close every connection to the room (players and spectators). */
  closeAll(code: number, reason: string): void;
}
