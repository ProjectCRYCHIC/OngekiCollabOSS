import type { AdminQueries, CursorPage, PlayerControlRow, RoomAdminRow, RoomMemberAdminRow } from "./ports.js";

function page(url: URL, query = ""): CursorPage {
  const rawLimit = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 20;
  const cursor = url.searchParams.get("cursor");
  if (!cursor) return { limit, beforeTime: null, beforeId: null };
  try {
    const value = JSON.parse(decodeURIComponent(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")))) as { t: number; i: string; q: string };
    if (value.q !== query || !Number.isSafeInteger(value.t) || typeof value.i !== "string" || !/^(?:[0-9a-f-]{36}|anon:[0-9a-f]{64})$/i.test(value.i)) throw new Error();
    return { limit, beforeTime: value.t, beforeId: value.i };
  } catch { throw new Error("Invalid cursor"); }
}

function cursor(time: number, id: string, query = ""): string {
  return btoa(encodeURIComponent(JSON.stringify({ t: time, i: id, q: query }))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function listPlayers(admin: AdminQueries, url: URL) {
  const query = (url.searchParams.get("query") ?? "").trim();
  if (query.length > 128) throw new Error("Invalid query");
  const pageParams = page(url, query);
  const { rows, hasMore } = await admin.playerRows({ query, ...pageParams });
  const visible = rows.slice(0, pageParams.limit);
  const last = visible.at(-1);
  return { items: visible.map((row: PlayerControlRow) => ({ id: row.id, kind: row.kind, username: row.username,
    serverDomain: row.server_domain, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
    bannedAt: row.banned_at, banReason: row.ban_reason })),
    nextCursor: hasMore && last ? cursor(last.last_seen_at, last.id, query) : null };
}

export async function listBattles(admin: AdminQueries, url: URL) {
  const pageParams = page(url);
  const { rows, hasMore } = await admin.battleRows(pageParams);
  const visible = rows.slice(0, pageParams.limit);
  const items = await Promise.all(visible.map(async (row: RoomAdminRow) => {
    const members: RoomMemberAdminRow[] = await admin.battleMemberRows(row.id);
    const song = JSON.parse(row.song_json) as { id: number; title: string; artist: string };
    return { id: row.id, pool: row.pool, status: row.status, playerCount: row.player_count,
      createdAt: row.created_at, startedAt: row.started_at,
      song: { id: song.id, title: song.title, artist: song.artist },
      players: members.map((member) => ({ id: member.identity_id, username: member.username, serverDomain: member.server_domain })) };
  }));
  const last = visible.at(-1);
  return { items, nextCursor: hasMore && last ? cursor(last.updated_at, last.id) : null };
}
