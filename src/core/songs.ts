import type { CatalogSong, SongCatalog, SongCatalogCache } from "./ports.js";

// Normalized song metadata for the spectator board, sourced from the public
// arcade-songs database mirror. The upstream JSON is ~2 MB and ships no CORS
// headers, so the server normalizes it once and caches the small projection.
// Responses intentionally carry no chart hashes and no player data.
const CATALOG_URL = "https://dp4p6x0xfi5o9.cloudfront.net/ongeki/data.json";
const EDGE_TTL_SECONDS = 24 * 60 * 60;
const BROWSER_TTL_SECONDS = 4 * 60 * 60;

const DIFFICULTIES = ["basic", "advanced", "expert", "master", "lunatic"] as const;
const MAX_SONGS = 4000;

interface UpstreamSheet { difficulty?: unknown; level?: unknown }
interface UpstreamSong {
  title?: unknown; artist?: unknown; category?: unknown; version?: unknown;
  bpm?: unknown; releaseDate?: unknown; imageName?: unknown; sheets?: unknown;
}
interface UpstreamCatalog { updateTime?: unknown; songs?: unknown }

function text(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value : "";
}

function normalizeSong(raw: UpstreamSong): CatalogSong | null {
  const title = text(raw.title, 256);
  const image = text(raw.imageName, 128);
  if (!title || !/^[a-z0-9_-]+\.png$/i.test(image)) return null;
  const levels: Array<string | null> = DIFFICULTIES.map(() => null);
  if (Array.isArray(raw.sheets)) {
    for (const sheet of raw.sheets as UpstreamSheet[]) {
      const index = DIFFICULTIES.indexOf(sheet?.difficulty as typeof DIFFICULTIES[number]);
      const level = text(sheet?.level, 8);
      if (index >= 0 && level) levels[index] = level;
    }
  }
  const bpm = typeof raw.bpm === "number" && Number.isFinite(raw.bpm) ? Math.trunc(raw.bpm) : 0;
  return {
    t: title,
    a: text(raw.artist, 256),
    c: text(raw.category, 64),
    v: text(raw.version, 64),
    b: bpm,
    d: text(raw.releaseDate, 10),
    i: image,
    l: levels,
  };
}

export function normalizeCatalog(payload: UpstreamCatalog): SongCatalog {
  const songs: CatalogSong[] = [];
  if (Array.isArray(payload?.songs)) {
    for (const raw of payload.songs.slice(0, MAX_SONGS)) {
      const song = normalizeSong(raw as UpstreamSong);
      if (song) songs.push(song);
    }
  }
  if (!songs.length) throw new Error("Catalog is empty");
  return { updated: text(payload?.updateTime, 40) || new Date().toISOString(), songs };
}

async function fetchCatalog(): Promise<SongCatalog> {
  const upstream = await fetch(CATALOG_URL, { headers: { accept: "application/json" } });
  if (!upstream.ok) throw new Error(`Catalog upstream HTTP ${upstream.status}`);
  return normalizeCatalog(await upstream.json() as UpstreamCatalog);
}

export async function songCatalog(cache: SongCatalogCache): Promise<SongCatalog> {
  const cached = await cache.get();
  if (cached) return cached;
  const catalog = await fetchCatalog();
  await cache.set(catalog);
  return catalog;
}

export function catalogResponse(catalog: SongCatalog): Response {
  return new Response(JSON.stringify(catalog), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${BROWSER_TTL_SECONDS}`,
      "x-content-type-options": "nosniff",
    },
  });
}

export const SONGS_CACHE_TTL_SECONDS = EDGE_TTL_SECONDS;
