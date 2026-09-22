import { reactive } from "vue";
import { translator } from "../shared/i18n";
import type { BoardPlayer, BoardSong } from "./types";
import type { HistoryItem, RoomItem } from "./board";

interface ScorePayload { type?: string; roomId?: string; status?: string; players?: unknown }

export const roomModal = reactive({
  open: false,
  mode: "room" as "room" | "history",
  song: null as BoardSong | null,
  roomId: null as string | null,
  record: null as HistoryItem | null,
  status: "",
  players: [] as BoardPlayer[],
});

const channel = { socket: null as WebSocket | null, roomId: null as string | null };

function closeChannel(): void {
  if (channel.socket) {
    channel.socket.onmessage = channel.socket.onclose = channel.socket.onerror = null;
    try { channel.socket.close(); } catch { /* Already closed. */ }
  }
  channel.socket = null;
  channel.roomId = null;
}

function liveStatus(payload: ScorePayload): string {
  const t = translator();
  if (payload?.status === "playing") return t("board.live.playing");
  if (payload?.status === "recruiting") return t("board.live.recruiting");
  return t("board.live.ended");
}

export function openRoom(room: RoomItem): void {
  const t = translator();
  roomModal.open = true;
  roomModal.mode = "room";
  roomModal.song = room.song;
  roomModal.record = null;
  roomModal.roomId = room.id;
  // Seed the table with the room projection so names and difficulties show
  // before the live scores socket delivers; scores arrive as zeros.
  roomModal.players = Array.isArray(room.players) ? room.players : [];
  roomModal.status = t("board.live.connecting");
  closeChannel();
  channel.roomId = room.id;
  const url = new URL(`/api/v1/rooms/${encodeURIComponent(room.id)}/live`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket;
  try { socket = new WebSocket(url); }
  catch {
    roomModal.status = t("board.live.failed");
    return;
  }
  channel.socket = socket;
  socket.onmessage = (event) => {
    if (channel.roomId !== room.id) return;
    let payload: ScorePayload;
    try { payload = JSON.parse(event.data as string) as ScorePayload; }
    catch { return; }
    if (payload?.type !== "scores" || payload.roomId !== room.id) return;
    roomModal.players = Array.isArray(payload.players) ? payload.players as BoardPlayer[] : [];
    roomModal.status = liveStatus(payload);
  };
  socket.onclose = () => {
    if (channel.roomId !== room.id) return;
    channel.socket = null;
    roomModal.status = translator()("board.live.dropped");
  };
  socket.onerror = () => socket.close();
}

export function openHistory(record: HistoryItem): void {
  roomModal.open = true;
  roomModal.mode = "history";
  roomModal.song = record.song;
  roomModal.record = record;
  roomModal.roomId = null;
  roomModal.players = Array.isArray(record.players) ? record.players : [];
  roomModal.status = "";
  closeChannel();
}

export function closeRoomModal(): void {
  roomModal.open = false;
  closeChannel();
}
