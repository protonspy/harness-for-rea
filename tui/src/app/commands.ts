/*
  The slash commands (specs/tui-shell R2.2, R2.3): one list, read by the prompt when it starts with `/` and by the
  Ctrl+P palette. Each screen offers its own commands on top of the global ones, only those that apply to what it
  shows.
*/

export interface Command {
  /** typed after `/`: `continue`, `delete-task` */
  name: string
  title: string
  /** what follows the name, shown while it is typed: `<key>` */
  args?: string
  /** the key that runs it too, shown in the palette */
  key?: string
  run(arg: string): void | Promise<void>
}

/** A line of the prompt read as a command and its argument, or null when it is a message. */
export function readCommand(line: string): { name: string; arg: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(line.trim())
  return m ? { name: m[1], arg: (m[2] ?? "").trim() } : null
}

/** The commands whose name starts with what was typed after `/`, while the name is still being typed (R2.2). */
export function completions(commands: Command[], line: string): Command[] {
  const m = /^\/([a-z0-9-]*)$/.exec(line)
  if (!m) return []
  return commands.filter((c) => c.name.startsWith(m[1])).sort((a, b) => a.name.localeCompare(b.name))
}

/** How well `query` matches `text` as a subsequence, higher better; -1 when it does not (R2.3). */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let score = 0
  let at = -1
  let run = 0
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1)
    if (i < 0) return -1
    run = i === at + 1 ? run + 1 : 0
    // Consecutive letters and a match at a word's start count more.
    score += 1 + run * 2 + (i === 0 || /[\s/-]/.test(t[i - 1]) ? 3 : 0)
    at = i
  }
  return score - t.length * 0.01
}

/** The commands matching a palette query, best first. */
export function search(commands: Command[], query: string): Command[] {
  return commands
    .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.name), fuzzyScore(query, c.title)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c)
}
