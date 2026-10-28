import type { TaskState } from "@shared/types"

/* Display helpers: money, tokens, time, state tone and diff lines. */

export function usd(v: number): string {
  if (!v) return "$0.00"
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function when(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString()
}

export type Tone = "neutral" | "info" | "warn" | "ok" | "bad"

export function tone(state: TaskState | ""): Tone {
  switch (state) {
    case "running":
      return "info"
    case "waiting":
      return "warn"
    case "done":
      return "ok"
    case "failed":
    case "interrupted":
      return "bad"
    default:
      return "neutral"
  }
}

export type DiffLine = { kind: "add" | "del" | "hunk" | "file" | "ctx"; text: string }

export function diffLines(diff: string): DiffLine[] {
  return diff.split("\n").map((text) => {
    if (text.startsWith("+++") || text.startsWith("---")) return { kind: "file", text }
    if (text.startsWith("@@")) return { kind: "hunk", text }
    if (text.startsWith("+")) return { kind: "add", text }
    if (text.startsWith("-")) return { kind: "del", text }
    return { kind: "ctx", text }
  })
}
