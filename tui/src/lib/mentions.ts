import { readdirSync, type Dirent } from "node:fs"
import { join, relative, sep } from "node:path"

/*
  `@` mentions in the prompt (specs/tui-conversation R4.3): what follows an `@` is completed from the paths of the
  project's target folder, folders first, so a message can name a file the orchestrator then finds under its
  workspace. Folders that hold nothing worth naming are skipped, and the walk is bounded.
*/

const SKIP = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "dist", "build", "target", "out"])
const MAX_RESULTS = 50
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/
const MAX_SCANNED = 20_000

/** The `@` mention the cursor is in: where it starts and what is typed after the `@`, or null. */
export function mentionAt(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor)
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!m) return null
  return { start: cursor - m[1].length - 1, query: m[1] }
}

export type ReadDir = (dir: string) => Dirent[]

/** The target's paths, relative and with `/`, that contain the query's letters in order, best first, at most 50. */
export function suggestPaths(root: string, query: string, read: ReadDir = (d) => readdirSync(d, { withFileTypes: true })): string[] {
  const q = query.replace(/\\/g, "/").toLowerCase()
  const found: { path: string; score: number }[] = []
  const queue = [root]
  let scanned = 0
  while (queue.length && scanned < MAX_SCANNED) {
    const dir = queue.shift()!
    let entries: Dirent[]
    try {
      entries = read(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (++scanned > MAX_SCANNED) break
      // A name with controls, bidi marks or line breaks would carry them into the message; it is never offered.
      if (SKIP.has(e.name) || UNSAFE_NAME.test(e.name)) continue
      const full = join(dir, e.name)
      const rel = relative(root, full).split(sep).join("/") + (e.isDirectory() ? "/" : "")
      const score = matchScore(q, rel.toLowerCase())
      if (score >= 0) found.push({ path: rel, score: score + (e.isDirectory() ? 0.5 : 0) })
      if (e.isDirectory()) queue.push(full)
    }
  }
  return found
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, MAX_RESULTS)
    .map((f) => f.path)
}

/** A path matches when the query is its prefix, a substring, or its letters in order; -1 otherwise. */
function matchScore(q: string, path: string): number {
  if (!q) return path.split("/").filter(Boolean).length === 1 ? 2 : -1
  if (path.startsWith(q)) return 10
  const name = path.replace(/\/$/, "").split("/").at(-1) ?? ""
  if (name.startsWith(q)) return 8
  if (path.includes(q)) return 6
  let at = -1
  for (const ch of q) {
    at = path.indexOf(ch, at + 1)
    if (at < 0) return -1
  }
  return 1
}

/** The prompt's text with the mention replaced by the chosen path, and where the cursor goes after it. */
export function insertMention(text: string, mention: { start: number; query: string }, path: string): { text: string; cursor: number } {
  const end = mention.start + 1 + mention.query.length
  const inserted = `@${path}${path.endsWith("/") ? "" : " "}`
  return { text: text.slice(0, mention.start) + inserted + text.slice(end), cursor: mention.start + inserted.length }
}
