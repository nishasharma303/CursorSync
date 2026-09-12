export const PALETTE = [
  "#E8604C",
  "#D4A017",
  "#2F8C82",
  "#7B5EA7",
  "#3B6FA0",
  "#C2467D",
] as const;

export function randomColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)] ?? PALETTE[0];
}

export function randomId(): string {
  // crypto.randomUUID is available in all modern browsers this app targets;
  // sliced for brevity since these ids are ephemeral, session-scoped.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

const THEME_STORAGE_KEY = "cursor-sync-theme";

/** Reads a saved theme, then the OS preference, then falls back to light. Safe on the server (no window). */
export function getInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function persistTheme(theme: "light" | "dark"): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
}
