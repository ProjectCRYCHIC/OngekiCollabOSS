import { computed, reactive, ref } from "vue";
import { translator } from "../shared/i18n";

export interface RequestStatus { message: string; tone: "" | "error" | "success" }

export async function adminApi(path: string, method = "GET", payload?: unknown): Promise<unknown> {
  const t = translator();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
    ...(method !== "GET" ? { body: JSON.stringify(payload ?? {}) } : {}),
  });
  let result: unknown = null;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    try { result = await response.json(); } catch { /* Reported below as a failed request. */ }
  }
  if (!response.ok) {
    // Self-hosted consoles without a live session land on the sign-in page;
    // Cloudflare Access deployments never produce a 401 here.
    if (response.status === 401) { window.location.assign("/admin/login"); throw new Error(t("admin.login.checking")); }
    const message = result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string"
      ? (result as { error: string }).error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!result) throw new Error(t("admin.list.noJson"));
  return result;
}

function pageOf(payload: unknown): { items: unknown[]; nextCursor: string | null } | null {
  const record = payload as { items?: unknown; nextCursor?: unknown } | null;
  if (!Array.isArray(record?.items)) return null;
  const cursor = record.nextCursor;
  if (cursor !== null && cursor !== undefined && typeof cursor !== "string") return null;
  return { items: record.items, nextCursor: cursor || null };
}

export function useIdentityMode() {
  const t = translator();
  const required = ref<boolean | null>(null);
  const busy = ref(false);
  const status = ref<RequestStatus>({ message: "", tone: "" });

  async function requestMode(method: "GET" | "PUT", value?: boolean): Promise<boolean> {
    const result = await adminApi("/admin/api/identity-mode", method, method === "PUT" ? { required: value } : undefined) as
      { required?: unknown } | null;
    if (!result || typeof result.required !== "boolean") throw new Error(t("admin.mode.invalidResponse"));
    return result.required;
  }

  function showCurrent(value: boolean, tone: RequestStatus["tone"] = "") {
    required.value = value;
    status.value = { message: value ? t("admin.mode.on") : t("admin.mode.off"), tone };
  }

  async function refresh() {
    busy.value = true;
    status.value = { message: t("admin.mode.reading"), tone: "" };
    try {
      showCurrent(await requestMode("GET"));
    } catch (error) {
      status.value = {
        message: t("admin.mode.readFailed", { message: error instanceof Error ? error.message : t("admin.mode.retryRead") }),
        tone: "error",
      };
    } finally {
      busy.value = false;
    }
  }

  async function save(next: boolean) {
    if (busy.value || required.value === null || next === required.value) return;
    busy.value = true;
    status.value = { message: t("admin.mode.saving"), tone: "" };
    try {
      showCurrent(await requestMode("PUT", next), "success");
    } catch (error) {
      showCurrent(required.value as boolean);
      status.value = {
        message: t("admin.mode.saveFailed", { message: error instanceof Error ? error.message : t("admin.mode.retrySave") }),
        tone: "error",
      };
    } finally {
      busy.value = false;
    }
  }

  return { required, busy, status, refresh, save };
}

export function useAdminList(endpoint: string) {
  const t = translator();
  const state = reactive({
    items: [] as unknown[],
    busy: false,
    cursor: null as string | null,
    next: null as string | null,
    previous: [] as string[],
    query: "",
    pendingQuery: undefined as string | undefined,
  });
  const status = ref<RequestStatus>({ message: "", tone: "" });
  const canPrevious = computed(() => !state.busy && state.previous.length > 0);
  const canNext = computed(() => !state.busy && Boolean(state.next));

  function setListStatus(message: string, tone: RequestStatus["tone"] = "") {
    status.value = { message, tone };
  }

  async function loadList(cursor: string | null = null, successMessage = ""): Promise<boolean> {
    if (state.busy) return false;
    state.busy = true;
    setListStatus(t("admin.list.reading"));
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);
      if (state.query) params.set("query", state.query);
      const page = pageOf(await adminApi(`${endpoint}?${params}`));
      if (!page) throw new Error(t("admin.list.invalid"));
      state.cursor = cursor;
      state.next = page.nextCursor;
      state.items = page.items;
      setListStatus(successMessage, successMessage ? "success" : "");
      return true;
    } catch (error) {
      setListStatus(error instanceof Error ? error.message : t("admin.list.failed"), "error");
      return false;
    } finally {
      state.busy = false;
      if (state.pendingQuery !== undefined) {
        state.query = state.pendingQuery;
        state.pendingQuery = undefined;
        state.previous = [];
        void loadList();
      }
    }
  }

  async function onPrevious() {
    const cursor = state.previous[state.previous.length - 1];
    const query = state.query;
    if (await loadList(cursor) && state.query === query) state.previous.pop();
  }

  async function onNext() {
    const previousCursor = state.cursor;
    const query = state.query;
    if (await loadList(state.next) && state.query === query && previousCursor !== null) state.previous.push(previousCursor);
  }

  function search(query: string) {
    if (state.busy) {
      state.pendingQuery = query;
      setListStatus(t("admin.players.waiting"));
      return;
    }
    state.query = query;
    state.previous = [];
    void loadList();
  }

  function refreshCurrent() {
    return loadList(state.cursor);
  }

  return { state, status, setListStatus, loadList, onPrevious, onNext, search, refreshCurrent, canPrevious, canNext };
}
