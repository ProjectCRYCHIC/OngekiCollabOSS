import { base64, hex, hmac, signToken, unbase64, verifyToken } from "./crypto.js";
import { parseMatch, parsePool, SongManifest } from "./protocol.js";
import { body, failure, response } from "./http.js";
import { authenticate, identityMode } from "./identity.js";
import type { AppServices, Reservation } from "./ports.js";
import type { RoomTicket } from "./tokens.js";

export async function match(services: AppServices, request: Request): Promise<Response> {
  const mode = await identityMode(services);
  const input = await body(request, 8192);
  let identityId: string | null;
  if (mode.required) identityId = await authenticate(services, request);
  else {
    if (typeof input.anonymousKey !== "string") return failure("Invalid anonymous key");
    const anonymousKey = unbase64(input.anonymousKey);
    if (anonymousKey.length !== 32) return failure("Invalid anonymous key");
    identityId = `anon:${hex(await hmac(services.secrets.identityHash, `anonymous\u0000${base64(anonymousKey)}`))}`;
  }
  if (!identityId) return failure("Authentication required", 401);
  const matchRequest = parseMatch(input);
  const identity = mode.required ? await services.identities.findSessionIdentity(identityId) : { id: identityId, server_domain: "anonymous" };
  if (!identity) return failure("Identity not found", 401);
  if (!await services.playerControls.record(identityId, mode.required ? "registered" : "anonymous", matchRequest.username, identity.server_domain, Date.now()))
    return failure("Player banned", 403);
  const reservation: Reservation = { identityId, username: matchRequest.username, cardId: matchRequest.cardId,
    serverDomain: identity.server_domain, song: matchRequest.song };
  let result: { roomId: string; peerId: number; reservationId: string; status: string };
  if (matchRequest.roomId) {
    // Strict isolation: another player's room can only be entered by naming it explicitly.
    const room = await services.roomQueries.findById(matchRequest.roomId);
    const pool = matchRequest.pool ?? "";
    if (!room || room.status !== "recruiting" || room.pool !== pool)
      return failure("Room unavailable", 409);
    // Only the song id must match the room: chart files may differ between players
    // and are compared client-to-client after ready, not here.
    const expected = JSON.parse(room.song_json) as SongManifest;
    if (expected.id !== matchRequest.song.id)
      return failure("Room unavailable", 409);
    const seat = await services.rooms.reserve(room.id, reservation);
    if (!seat) return failure("Room unavailable", 409);
    result = { roomId: room.id, peerId: seat.peerId, reservationId: seat.reservationId, status: "recruiting" };
  } else {
    // Idempotent re-entry: reuse the caller's own recruiting host room when it still exists,
    // so a failed WebSocket handshake retry does not leave a ghost room on the directory.
    const own = await services.roomQueries.findOwnRecruitingHost(identityId, matchRequest.pool ?? "");
    let seat: { peerId: number; reservationId: string } | null = null;
    let roomId: string | null = null;
    if (own) {
      let sameSong = false;
      try { sameSong = (JSON.parse(own.song_json) as SongManifest).id === matchRequest.song.id; }
      catch { sameSong = false; }
      if (sameSong) {
        seat = await services.rooms.reserve(own.id, reservation);
        if (seat) roomId = own.id;
      }
      // A different selection or a still-connected host is not an idempotent
      // handshake retry. Retire the old room before exposing the replacement so
      // directory clients can never join a room its host has already abandoned.
      if (!seat) await services.rooms.forceClose(own.id);
    }
    if (!seat || roomId === null) {
      const created = await services.pools.create(matchRequest, reservation);
      roomId = created.roomId;
      seat = { peerId: created.peerId, reservationId: created.reservationId };
    }
    result = { roomId, peerId: seat.peerId, reservationId: seat.reservationId, status: "recruiting" };
  }
  const banAfterReservation = await services.playerControls.bannedAt(identityId);
  if (!banAfterReservation || banAfterReservation.banned_at !== null) {
    await services.rooms.banPlayer(result.roomId, identityId);
    return failure("Player banned", 403);
  }
  const pool = matchRequest.pool ?? "";
  const ticket = await signToken(services.secrets.ticketSigning, { type: "room", roomId: result.roomId,
    identityId, peerId: result.peerId, reservationId: result.reservationId, pool, anonymous: !mode.required,
    exp: Date.now() + 60_000 });
  return response({ roomId: result.roomId, peerId: result.peerId, status: result.status,
    ticket, wsPath: pool ? `/room/${encodeURIComponent(pool)}` : "/room" });
}

export type AdmissionResult = { ok: true; ticket: RoomTicket } | { ok: false; response: Response };

/** Shared pre-transport admission for a /room WebSocket: validates the room
 *  ticket against the path pool, the identity mode, identity existence and the
 *  player's ban state. Transport handover stays runtime-specific. */
export async function admitRoomConnection(services: AppServices, request: Request, pool: string | null): Promise<AdmissionResult> {
  const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
  const payload = await verifyToken<RoomTicket>(services.secrets.ticketSigning, ticket, "room");
  if (!payload || payload.pool !== (pool ?? "") || typeof payload.roomId !== "string") return { ok: false, response: failure("Invalid room ticket", 401) };
  if (payload.anonymous) {
    if ((await identityMode(services)).required) return { ok: false, response: failure("Authentication required", 401) };
  } else {
    const identity = await services.identities.exists(payload.identityId);
    if (!identity) return { ok: false, response: failure("Identity not found", 401) };
  }
  const control = await services.playerControls.bannedAt(payload.identityId);
  if (!control || control.banned_at !== null) return { ok: false, response: failure("Player banned", 403) };
  return { ok: true, ticket: payload };
}

/** Path parser for the /room and /room/{pool} WebSocket endpoints: null means
 *  the unnamed pool, undefined means the path is not a room path at all. */
export function roomPath(pathname: string): string | null | undefined {
  if (pathname === "/room") return null;
  const matched = /^\/room\/([^/]+)$/.exec(pathname);
  if (!matched) return undefined;
  return parsePool(decodeURIComponent(matched[1]));
}
