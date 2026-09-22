import { valueOrDash } from "../shared/format";
import type { BoardPlayer } from "./types";

export function playerName(player: BoardPlayer): string {
  return valueOrDash(player?.name ?? player?.username);
}

// The room creator keeps peerId 1 in the room projection, spectator scores
// and recorded participants.
export function isHost(player: BoardPlayer): boolean {
  return Number(player?.peerId) === 1;
}

export function scoreValue(value: unknown, locale: string): string {
  const score = Number(value);
  return Number.isFinite(score) ? score.toLocaleString(locale) : "—";
}

export function playerStatusLabel(translate: (key: string) => string, player: BoardPlayer): string {
  if (player?.connected === false) return translate("board.table.disconnected");
  const status = typeof player?.playStatus === "string" ? player.playStatus : "";
  return status ? (/^play/i.test(status) ? translate("board.status.playing") : status) : "—";
}

export function hostFirst(players: BoardPlayer[]): BoardPlayer[] {
  return [...players].sort((a, b) => Number(isHost(b)) - Number(isHost(a)));
}
