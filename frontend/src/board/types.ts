import { difficultyName } from "../shared/format";

export interface BoardSong {
  id?: number | string;
  title?: string;
  artist?: string;
  genre?: string;
  version?: string;
  selectedDifficulty?: number;
  level?: number;
  bpm?: number;
  designer?: string;
}

export interface BoardPlayer {
  peerId?: number;
  name?: string;
  username?: string;
  selectedDifficulty?: number;
  level?: number | null;
  techScore?: number | null;
  battleScore?: number | null;
  playStatus?: string;
  connected?: boolean;
}

/** Convert the internal chart constant to the level shown by the game UI. */
export function relativeLevelLabel(level: unknown): string {
  if (typeof level === "string") {
    const trimmed = level.trim();
    if (/^\d+\+$/.test(trimmed)) return trimmed;
    level = trimmed;
  }
  const value = Number(level);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const base = Math.floor(value + Number.EPSILON);
  const tenths = Math.round((value - base) * 10);
  return `${base}${tenths >= 7 ? "+" : ""}`;
}

export function difficultyLabel(difficulty: unknown, level: unknown): string {
  const name = difficultyName(difficulty);
  if (name === "—") return name;
  const relativeLevel = relativeLevelLabel(level);
  return relativeLevel !== "—" ? `${name} Lv ${relativeLevel}` : name;
}
