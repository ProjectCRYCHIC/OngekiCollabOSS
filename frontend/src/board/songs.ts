import { reactive } from "vue";
import type { BoardSong } from "./types";

export interface CatalogSong {
  t: string;
  a: string;
  c: string;
  v: string;
  b: number;
  d: string;
  i: string;
  l: Array<string | null>;
}

export interface SongMeta {
  entry: CatalogSong | null;
  coverUrl: string | null;
  sourceUrl: string;
}

export const SONG_SOURCE_HOME = "https://arcade-songs.zetaraku.dev/ongeki/";
export const SONG_SOURCE_LABEL = "arcade-songs";
const COVER_PREFIX = "https://dp4p6x0xfi5o9.cloudfront.net/ongeki/img/cover/";
const CATALOG_URL = "/api/v1/songs";
const STORE_KEY = "ongeki-collab.songs.v1";
const TTL_MS = 24 * 60 * 60_000;

export function songSourceUrl(title: string): string {
  return `https://arcade-songs.zetaraku.dev/ongeki/song/?id=${encodeURIComponent(title)}`;
}

interface StoredCatalog { fetchedAt: number; updatedAt: string; songs: CatalogSong[] }

export const catalogState = reactive({
  ready: false,
  loading: false,
  failed: false,
  updatedAt: "",
});

let byTitle = new Map<string, CatalogSong[]>();

function normalizeTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replaceAll(/\s+/g, "");
}

function indexCatalog(songs: CatalogSong[]): void {
  byTitle = new Map();
  for (const song of songs) {
    if (typeof song.t !== "string" || !song.t) continue;
    const key = normalizeTitle(song.t);
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(song);
    else byTitle.set(key, [song]);
  }
}

function readStored(): StoredCatalog | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCatalog;
    return Array.isArray(parsed?.songs) ? parsed : null;
  } catch { return null; }
}

function storeStored(catalog: StoredCatalog): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(catalog)); } catch { /* Quota errors are non-fatal. */ }
}

export async function loadCatalog(force = false): Promise<void> {
  if (catalogState.loading || (catalogState.ready && !force)) return;
  const stored = readStored();
  if (stored?.songs.length && !force) {
    indexCatalog(stored.songs);
    catalogState.updatedAt = stored.updatedAt;
    catalogState.ready = true;
    if (Date.now() - stored.fetchedAt < TTL_MS) return;
  }
  catalogState.loading = true;
  try {
    const response = await fetch(CATALOG_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { updatedAt?: string; songs?: CatalogSong[] };
    if (!Array.isArray(payload.songs) || !payload.songs.length) throw new Error("Invalid catalog");
    const catalog: StoredCatalog = {
      fetchedAt: Date.now(),
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : "",
      songs: payload.songs,
    };
    indexCatalog(catalog.songs);
    storeStored(catalog);
    catalogState.updatedAt = catalog.updatedAt;
    catalogState.ready = true;
    catalogState.failed = false;
  } catch {
    // A stale local copy is still better than nothing for covers and metadata.
    catalogState.failed = !byTitle.size;
  } finally {
    catalogState.loading = false;
  }
}

function matchEntry(song: BoardSong): CatalogSong | null {
  const title = typeof song.title === "string" ? song.title : "";
  if (!title) return null;
  const bucket = byTitle.get(normalizeTitle(title));
  if (!bucket?.length) return null;
  if (bucket.length === 1) return bucket[0];
  // Duplicate titles exist; prefer the entry whose category matches the
  // client-reported genre before falling back to the first one.
  return bucket.find((entry) => entry.c && entry.c === song.genre) ?? bucket[0];
}

export function songMeta(song: BoardSong): SongMeta {
  const entry = matchEntry(song);
  return {
    entry,
    coverUrl: entry ? COVER_PREFIX + entry.i : null,
    sourceUrl: entry ? songSourceUrl(entry.t) : SONG_SOURCE_HOME,
  };
}
