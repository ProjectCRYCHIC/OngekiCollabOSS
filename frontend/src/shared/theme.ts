import { ref } from "vue";

export type Theme = "dark" | "light";
const STORAGE_KEY = "ongeki-collab.theme";
const THEME_COLORS: Record<Theme, string> = { dark: "#101820", light: "#eef3f4" };

const theme = ref<Theme>(document.documentElement.dataset.theme === "light" ? "light" : "dark");

function syncDocument(value: Theme): void {
  document.documentElement.dataset.theme = value;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute("content", THEME_COLORS[value]);
  }
}

function setTheme(value: Theme): void {
  theme.value = value;
  syncDocument(value);
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Persistence is best-effort. */ }
}

// Re-apply on module init so direct DOM state (meta theme-color) matches even
// when the entry page had no inline bootstrap, e.g. the CSP-restricted admin.
syncDocument(theme.value);

export function useTheme() {
  return {
    theme,
    isDark: () => theme.value === "dark",
    toggle: () => setTheme(theme.value === "dark" ? "light" : "dark"),
  };
}
