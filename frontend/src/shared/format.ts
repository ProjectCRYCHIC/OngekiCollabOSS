export const DIFFICULTY_NAMES = ["BASIC", "ADVANCED", "EXPERT", "MASTER", "LUNATIC"] as const;

export function valueOrDash(value: unknown): string {
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

export function difficultyName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < DIFFICULTY_NAMES.length ? DIFFICULTY_NAMES[index] : String(value);
}

export function difficultyClass(value: unknown): string {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < DIFFICULTY_NAMES.length
    ? `difficulty-${DIFFICULTY_NAMES[index].toLowerCase()}`
    : "";
}

function safeDate(value: unknown): Date | null {
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWith(locale: string, value: unknown, options: Intl.DateTimeFormatOptions): string {
  const date = value === undefined || value === null || value === "" ? null : safeDate(value);
  return date ? new Intl.DateTimeFormat(locale, options).format(date) : "—";
}

export function formatStamp(locale: string, value: unknown): string {
  return formatWith(locale, value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatClock(locale: string, value: unknown): string {
  return formatWith(locale, value, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatFull(locale: string, value: unknown): string {
  return formatWith(locale, value, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatCount(locale: string, value: unknown): string {
  const count = Number(value);
  return Number.isFinite(count) ? count.toLocaleString(locale) : "—";
}
