/*
  The TUI's colors (specs/tui-shell R1.3): the desktop app's dark theme, token for token from
  src/renderer/src/index.css, and a light variant that inverts the neutrals and keeps the accents. Code is colored
  from `SYNTAX` in src/renderer/src/lib/highlight.ts, as in the desktop app.
*/

export interface Theme {
  name: "dark" | "light"
  background: string
  foreground: string
  card: string
  muted: string
  mutedForeground: string
  accent: string
  primary: string
  border: string
  success: string
  warning: string
  destructive: string
  /** the background of a selected row */
  selection: string
}

export const DARK: Theme = {
  name: "dark",
  background: "#0b0d10",
  foreground: "#e6e8eb",
  card: "#12151a",
  muted: "#181c22",
  mutedForeground: "#8b929c",
  accent: "#1e232b",
  primary: "#7aa2f7",
  border: "#262b33",
  success: "#6fcf97",
  warning: "#e8b85a",
  destructive: "#ef6f6c",
  selection: "#243049",
}

export const LIGHT: Theme = {
  name: "light",
  background: "#fbfbfc",
  foreground: "#1b1f24",
  card: "#ffffff",
  muted: "#eef0f3",
  mutedForeground: "#5d6570",
  accent: "#e6e9ee",
  primary: "#3d6fd9",
  border: "#d5d9df",
  success: "#2f9e5f",
  warning: "#b7791f",
  destructive: "#d64541",
  selection: "#dbe5fb",
}

/** The theme a flag or `HFR_THEME` asks for; dark otherwise. */
export function themeFor(flag: "dark" | "light" | null, env: Record<string, string | undefined>): Theme {
  const name = flag ?? (env.HFR_THEME === "light" ? "light" : "dark")
  return name === "light" ? LIGHT : DARK
}

/** The color of a task or step state, as the desktop app's badges tone it. */
export function toneColor(t: Theme, tone: "neutral" | "info" | "warn" | "ok" | "bad"): string {
  return { neutral: t.mutedForeground, info: t.primary, warn: t.warning, ok: t.success, bad: t.destructive }[tone]
}
