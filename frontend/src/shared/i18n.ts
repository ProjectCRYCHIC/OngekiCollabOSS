import { createI18n } from "vue-i18n";
import enUS from "./locales/en";
import jaJP from "./locales/ja";
import zhCN from "./locales/zh-CN";

export const LOCALES = ["zh-CN", "en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_LABELS: Record<Locale, string> = { "zh-CN": "中文", en: "English", ja: "日本語" };
const STORAGE_KEY = "ongeki-collab.locale";
const DEFAULT_LOCALE: Locale = "en";

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;
  } catch { /* Storage unavailable falls through to detection. */ }
  for (const tag of navigator.languages ?? []) {
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("ja")) return "ja";
    if (lower.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}

export function createAppI18n() {
  const locale = initialLocale();
  document.documentElement.lang = locale;
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    messages: { "zh-CN": zhCN, en: enUS, ja: jaJP },
    missingWarn: false,
    fallbackWarn: false,
  });
}

// Single shared composer so non-component modules (modal status strings,
// admin API errors) translate without threading a composer around.
export const i18n = createAppI18n();

type Translate = (key: string, params?: Record<string, unknown>) => string;

export function translator(): Translate {
  const global = i18n.global;
  return (global.t as unknown as Translate);
}

export function persistLocale(locale: string): void {
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* Persistence is best-effort. */ }
  document.documentElement.lang = locale;
}
