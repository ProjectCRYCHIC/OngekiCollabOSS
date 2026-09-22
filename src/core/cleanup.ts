import type { CleanupStore } from "./ports.js";

export const PLAY_HISTORY_WINDOW_MS = 72 * 60 * 60_000;
export const ANONYMOUS_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Hourly housekeeping shared by the Cloudflare cron trigger and the self-hosted
 *  scheduler: expired challenges, the rolling play history window, closed rooms
 *  with their members, and stale un-banned anonymous player rows. */
export async function runCleanup(store: CleanupStore, now: number): Promise<void> {
  await store.purge({
    expiredBefore: now,
    playCutoff: now - PLAY_HISTORY_WINDOW_MS,
    anonymousCutoff: now - ANONYMOUS_RETENTION_MS,
  });
}
