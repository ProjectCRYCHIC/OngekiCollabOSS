import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { loadCatalog } from "./songs";
import type { BoardPlayer, BoardSong } from "./types";

export const PAGE_SIZE = 20;
const REFRESH_MS = 10_000;

export interface RoomItem {
  id: string;
  status: string;
  song: BoardSong;
  playerCount: number;
  maxPlayers: number;
  players: BoardPlayer[];
  createdAt: number;
  startedAt: number | null;
}

export interface HistoryItem {
  id: string;
  roomId: string | null;
  song: BoardSong;
  playerCount: number;
  maxPlayers: number;
  players: BoardPlayer[];
  startedAt: number;
  endedAt: number;
  endReason: string;
}

interface PagePayload { items: unknown[]; nextCursor?: unknown }

interface PageState {
  page: number;
  cursors: Array<string | null>;
  nextCursor: string | null;
  items: unknown[];
  failed: boolean;
  controller: AbortController | null;
  generation: number;
}

function emptyPage(): PageState {
  return { page: 0, cursors: [null], nextCursor: null, items: [], failed: false, controller: null, generation: 0 };
}

function validPage(payload: unknown): payload is PagePayload {
  const page = payload as PagePayload | null;
  return Array.isArray(page?.items) &&
    (page.nextCursor === null || page.nextCursor === undefined || typeof page.nextCursor === "string");
}

function isRoom(item: unknown): item is RoomItem {
  const room = item as RoomItem;
  return typeof room?.id === "string" && (room.status === "recruiting" || room.status === "playing");
}

function isHistory(item: unknown): item is HistoryItem {
  const play = item as HistoryItem;
  return typeof play?.id === "string" && typeof play?.endedAt === "number";
}

export function useBoard() {
  const { t, locale } = useI18n();

  const pool = ref("");
  const rooms = reactive(emptyPage());
  const history = reactive(emptyPage());
  const recruitingCount = ref<number | null>(null);
  const playingCount = ref<number | null>(null);
  const srStatus = ref("");
  const connecting = ref(true);

  const live = reactive({
    socket: null as WebSocket | null,
    token: 0,
    snapshot: null as { rooms: PagePayload; history: PagePayload; at: number } | null,
    lastRevision: -1,
    reconnectTimer: 0,
    reconnectDelay: 1000,
  });

  // The live socket is the only automatic data path: updates arrive as pushed
  // snapshots, a watchdog re-opens the socket at a fixed period, and HTTP is
  // reserved for manual refresh and pagination.
  const WATCHDOG_MS = 10_000;
  const RECONNECT_MAX_MS = 10_000;
  let watchdogTimer = 0;

  const roomList = computed(() => rooms.items.filter((item): item is RoomItem => isRoom(item)));
  const historyList = computed(() => history.items.filter((item): item is HistoryItem => isHistory(item)));

  function applySummary(entries: RoomItem[], at: number): void {
    recruitingCount.value = entries.filter((item) => item.status === "recruiting").length;
    playingCount.value = entries.filter((item) => item.status === "playing").length;
  }

  function applyPage(kind: "rooms" | "history", payload: PagePayload, at: number | null): void {
    const pageState = kind === "rooms" ? rooms : history;
    pageState.nextCursor = typeof payload.nextCursor === "string" && payload.nextCursor ? payload.nextCursor : null;
    pageState.items = payload.items;
    pageState.failed = false;
    srStatus.value = kind === "rooms"
      ? t("board.rooms.updated", { count: roomList.value.length })
      : t("board.history.updated", { count: historyList.value.length });
    // Matches the original summary rule: HTTP pages only refresh the counters
    // while the live snapshot is absent or the first page is on screen.
    if (kind === "rooms" && (!live.snapshot || rooms.page === 0)) applySummary(roomList.value, at ?? Date.now());
  }

  function renderLivePage(kind: "rooms" | "history"): void {
    const snapshot = live.snapshot;
    const pageState = kind === "rooms" ? rooms : history;
    if (!snapshot || pageState.page !== 0) return;
    pageState.controller?.abort();
    pageState.generation++;
    applyPage(kind, snapshot[kind], snapshot.at);
  }

  async function load(kind: "rooms" | "history"): Promise<void> {
    const pageState = kind === "rooms" ? rooms : history;
    pageState.controller?.abort();
    const controller = new AbortController();
    pageState.controller = controller;
    const generation = ++pageState.generation;
    srStatus.value = kind === "rooms" ? t("board.rooms.loading") : t("board.history.loading");
    const url = new URL(`/api/v1/${kind}`, location.origin);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (pool.value) url.searchParams.set("pool", pool.value);
    const cursor = pageState.cursors[pageState.page];
    if (cursor) url.searchParams.set("cursor", cursor);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      if (!validPage(payload)) throw new Error("Invalid response");
      if (generation !== pageState.generation) return;
      applyPage(kind, payload, Date.now());
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || generation !== pageState.generation) return;
      pageState.nextCursor = null;
      pageState.failed = true;
      srStatus.value = kind === "rooms" ? t("board.rooms.failed") : t("board.history.failed");
      if (kind === "rooms") {
        recruitingCount.value = null;
        playingCount.value = null;
      }
    }
  }

  function refresh(): void {
    void load("rooms");
    void load("history");
  }

  function scheduleReconnect(token: number): void {
    if (token !== live.token || !("WebSocket" in window)) return;
    live.reconnectTimer = window.setTimeout(connectLive, live.reconnectDelay);
    live.reconnectDelay = Math.min(live.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function closeSocket(): void {
    if (live.socket) {
      live.socket.onmessage = live.socket.onclose = live.socket.onerror = null;
      live.socket.close();
    }
    live.socket = null;
  }

  function connectLive(): void {
    const token = ++live.token;
    window.clearTimeout(live.reconnectTimer);
    closeSocket();
    live.snapshot = null;
    live.lastRevision = -1;
    connecting.value = true;
    if (!("WebSocket" in window)) return;

    const url = new URL("/api/v1/live", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    if (pool.value) url.searchParams.set("pool", pool.value);
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch { scheduleReconnect(token); return; }
    live.socket = socket;
    socket.onmessage = (event) => {
      if (token !== live.token) return;
      let snapshot: unknown;
      try { snapshot = JSON.parse(event.data as string); }
      catch { socket.close(); return; }
      const data = snapshot as { type?: string; revision?: unknown; at?: unknown; rooms?: unknown; history?: unknown };
      if (data?.type !== "snapshot" || !Number.isSafeInteger(data.revision as number) ||
        !validPage(data.rooms) || !validPage(data.history)) {
        socket.close();
        return;
      }
      const revision = data.revision as number;
      if (revision < live.lastRevision) return;
      live.lastRevision = revision;
      const rawAt = Number(data.at);
      const at = Number.isFinite(rawAt) && rawAt > 0 ? (rawAt < 1e12 ? rawAt * 1000 : rawAt) : Date.now();
      live.snapshot = { rooms: data.rooms, history: data.history, at };
      live.reconnectDelay = 1000;
      connecting.value = false;
      renderLivePage("rooms");
      renderLivePage("history");
      if (rooms.page > 0) applySummary((data.rooms as PagePayload).items.filter((item): item is RoomItem => isRoom(item)), at);
    };
    socket.onclose = () => {
      if (token !== live.token) return;
      live.socket = null;
      live.snapshot = null;
      scheduleReconnect(token);
    };
    socket.onerror = () => socket.close();
  }

  function switchPool(next: string): void {
    pool.value = next;
    for (const pageState of [rooms, history]) {
      pageState.page = 0;
      pageState.cursors = [null];
      pageState.nextCursor = null;
      pageState.controller?.abort();
      pageState.generation++;
      pageState.items = [];
      pageState.failed = false;
    }
    recruitingCount.value = null;
    playingCount.value = null;
    connectLive();
  }

  function previousPage(kind: "rooms" | "history"): void {
    const pageState = kind === "rooms" ? rooms : history;
    if (pageState.page === 0) return;
    pageState.page--;
    if (pageState.page === 0 && live.snapshot) renderLivePage(kind);
    else void load(kind);
  }

  function nextPage(kind: "rooms" | "history"): void {
    const pageState = kind === "rooms" ? rooms : history;
    if (!pageState.nextCursor) return;
    pageState.cursors[pageState.page + 1] = pageState.nextCursor;
    pageState.page++;
    void load(kind);
  }

  onMounted(() => {
    void loadCatalog();
    connectLive();
    watchdogTimer = window.setInterval(() => {
      if (!live.socket) connectLive();
    }, REFRESH_MS);
  });
  onUnmounted(() => {
    window.clearTimeout(live.reconnectTimer);
    window.clearInterval(watchdogTimer);
    closeSocket();
  });

  return {
    t, locale,
    pool, rooms, history, roomList, historyList, connecting,
    recruitingCount, playingCount, srStatus,
    refresh, switchPool, previousPage, nextPage,
  };
}
