/*
  A unified diff between two texts, for showing a patch to the user. The patch itself is applied
  from whole file contents, so this text only has to be right to read, never to replay.
*/

/** Above this many line pairs the diff shows the whole file replaced instead of an alignment. */
export const ALIGN_CAP = 4_000_000
const CONTEXT = 3
/** Above this many lines on either side, the file is shown replaced rather than aligned. */
export const LINE_LIMIT = 20_000

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number }

function lines(text: string): string[] {
  if (text === "") return []
  const l = text.split(/\r?\n/)
  if (l.at(-1) === "") l.pop()
  return l
}

/** Line operations turning `a` into `b`, by longest common subsequence. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0 || n > LINE_LIMIT || m > LINE_LIMIT || n * m > ALIGN_CAP)
    return [...a.map((line, i) => ({ kind: "-" as const, line, a: i, b: 0 })), ...b.map((line, j) => ({ kind: "+" as const, line, a: n, b: j }))]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ kind: " ", line: a[i], a: i++, b: j++ })
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ kind: "-", line: a[i], a: i++, b: j })
    else ops.push({ kind: "+", line: b[j], a: i, b: j++ })
  }
  while (i < n) ops.push({ kind: "-", line: a[i], a: i++, b: j })
  while (j < m) ops.push({ kind: "+", line: b[j], a: i, b: j++ })
  return ops
}

/** `--- a/<path>` / `+++ b/<path>` and hunks with three lines of context; "" when nothing changed. */
export function unifiedDiff(before: string, after: string, path: string, status: "added" | "modified" | "deleted" = "modified"): string {
  const ops = diffLines(lines(before), lines(after))
  const changed = ops.map((o, k) => (o.kind === " " ? -1 : k)).filter((k) => k >= 0)
  if (!changed.length) return ""
  const out = [`--- ${status === "added" ? "/dev/null" : `a/${path}`}`, `+++ ${status === "deleted" ? "/dev/null" : `b/${path}`}`]
  let k = 0
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - CONTEXT)
    let end = Math.min(ops.length, changed[k] + CONTEXT + 1)
    while (k + 1 < changed.length && changed[k + 1] - CONTEXT <= end) end = Math.min(ops.length, changed[++k] + CONTEXT + 1)
    k++
    const hunk = ops.slice(start, end)
    const aCount = hunk.filter((o) => o.kind !== "+").length
    const bCount = hunk.filter((o) => o.kind !== "-").length
    const aStart = aCount ? hunk.find((o) => o.kind !== "+")!.a + 1 : hunk[0].a
    const bStart = bCount ? hunk.find((o) => o.kind !== "-")!.b + 1 : hunk[0].b
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...hunk.map((o) => `${o.kind}${o.line}`))
  }
  return out.join("\n")
}

export function countChanges(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++
    else if (l.startsWith("-") && !l.startsWith("---")) removed++
  }
  return { added, removed }
}
