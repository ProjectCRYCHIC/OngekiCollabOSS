import { parsePool } from "./protocol.js";
import type { DirectoryQueries, PageInput, PlayHistoryRow, RoomDirectoryRow, RoomMemberPublicRow } from "./ports.js";

export function pageInput(url: URL): PageInput {
  const pool = parsePool(url.searchParams.get("pool")) ?? "";
  const limitRaw = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
  const cursor = url.searchParams.get("cursor");
  if (!cursor) return { pool, limit, beforeTime: null, beforeId: null };
  try {
    const decoded = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as { p: string; t: number; i: string };
    if (decoded.p !== pool || !Number.isSafeInteger(decoded.t) || typeof decoded.i !== "string" || !/^[0-9a-f-]{36}$/i.test(decoded.i)) throw new Error("Bad cursor");
    return { pool, limit, beforeTime: decoded.t, beforeId: decoded.i };
  } catch { throw new Error("Invalid cursor"); }
}

function nextCursor(pool: string, time: number, id: string): string {
  return btoa(JSON.stringify({ p: pool, t: time, i: id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function projectSong(song: Record<string, unknown>) {
  return { id: song.id, title: song.title, artist: song.artist,
    genre: song.genre, version: song.version, selectedDifficulty: song.selectedDifficulty,
    level: song.level, bpm: song.bpm, designer: song.designer };
}

export async function roomPage(queries: DirectoryQueries, page: PageInput) {
  const { rows, hasMore } = await queries.activeRoomRows(page);
  const visible = rows.slice(0, page.limit);
  const items = await Promise.all(visible.map(async (room: RoomDirectoryRow) => {
    const members: RoomMemberPublicRow[] = await queries.memberRows(room.id);
    const song = JSON.parse(room.song_json) as Record<string, unknown>;
    return { id: room.id, status: room.status, song: projectSong(song),
      playerCount: room.player_count, maxPlayers: room.max_players,
      // The player's title server stays internal; public payloads are anonymous.
      players: members.map((member) => ({ peerId: member.peer_id, name: member.username, cardId: member.card_id ?? 0,
        serverDomain: "anonymous", selectedDifficulty: member.selected_difficulty, level: member.level,
        connected: Boolean(member.connected) })),
      createdAt: room.created_at, startedAt: room.started_at };
  }));
  const last = visible.at(-1);
  return { items, nextCursor: hasMore && last ? nextCursor(page.pool, last.updated_at, last.id) : null };
}

export const HISTORY_WINDOW_MS = 72 * 60 * 60_000;

export async function historyPage(queries: DirectoryQueries, page: PageInput) {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  const { rows, hasMore } = await queries.historyRows(page, cutoff);
  const visible = rows.slice(0, page.limit);
  const items = visible.map((play: PlayHistoryRow) => {
    const song = JSON.parse(play.song_json) as Record<string, unknown>;
    const rawPlayers = JSON.parse(play.participants_json) as Array<Record<string, unknown>>;
    // Sanitize identity-bound fields and keep the final scores stored at endPlay.
    const players = rawPlayers.map((player) => ({ ...player, serverDomain: "anonymous" }));
    return { id: play.id, roomId: play.room_id, song: projectSong(song),
      playerCount: players.length, maxPlayers: 4, players, startedAt: play.started_at,
      endedAt: play.ended_at, endReason: play.end_reason };
  });
  const last = visible.at(-1);
  return { items, nextCursor: hasMore && last ? nextCursor(page.pool, last.ended_at, last.id) : null };
}

export async function directorySnapshot(queries: DirectoryQueries, pool: string, revision: number) {
  const page: PageInput = { pool, limit: 20, beforeTime: null, beforeId: null };
  const [rooms, history] = await Promise.all([roomPage(queries, page), historyPage(queries, page)]);
  return { type: "snapshot" as const, rooms, history, revision, at: Date.now() };
}
