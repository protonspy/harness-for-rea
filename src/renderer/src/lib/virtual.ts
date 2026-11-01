/*
  Which timeline entries to render (specs/chat-timeline R3.1): measured heights where an entry has
  been on screen, an estimate where it has not, and the slice of entries that meets the viewport
  widened by an overscan. Pure, so the view only measures and scrolls.
*/

/** Each entry's top offset, and the total height as the last element: `n + 1` numbers. */
export function offsets(ids: string[], measured: ReadonlyMap<string, number>, estimate: number): number[] {
  const out = new Array<number>(ids.length + 1)
  out[0] = 0
  for (let i = 0; i < ids.length; i++) out[i + 1] = out[i] + (measured.get(ids[i]) ?? estimate)
  return out
}

/** The first index whose entry ends below `y`. */
function firstEndingBelow(offs: number[], y: number): number {
  let lo = 0
  let hi = offs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offs[mid + 1] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface Slice {
  /** first entry rendered */
  start: number
  /** one past the last entry rendered */
  end: number
  /** space above the first entry rendered */
  before: number
  /** space below the last entry rendered */
  after: number
}

/** The entries meeting `[scrollTop - overscan, scrollTop + viewport + overscan]`. */
export function slice(offs: number[], scrollTop: number, viewport: number, overscan: number): Slice {
  const n = offs.length - 1
  if (n <= 0) return { start: 0, end: 0, before: 0, after: 0 }
  const start = Math.min(firstEndingBelow(offs, Math.max(0, scrollTop - overscan)), n - 1)
  let end = firstEndingBelow(offs, scrollTop + viewport + overscan) + 1
  end = Math.max(start + 1, Math.min(end, n))
  return { start, end, before: offs[start], after: offs[n] - offs[end] }
}

/**
  The scroll position that keeps what was on screen in place after entries were added above it
  (specs/chat-timeline R2.3): moved down by exactly the height that was added.
*/
export function keepInPlace(scrollTop: number, heightBefore: number, heightAfter: number): number {
  return scrollTop + Math.max(0, heightAfter - heightBefore)
}

/**
  How far entries added above moved the old ones down: found from the first old entry still present,
  since the one at the boundary may have merged with what was added (a run of tool calls, say).
  Zero when nothing was added above.
*/
export function addedAbove(oldIds: string[], oldOffs: number[], newIds: string[], newOffs: number[]): number {
  if (!oldIds.length || oldIds[0] === newIds[0]) return 0
  const at = new Map(newIds.map((id, i) => [id, i]))
  for (let j = 0; j < Math.min(oldIds.length, 8); j++) {
    const k = at.get(oldIds[j])
    if (k !== undefined) return Math.max(0, newOffs[k] - oldOffs[j])
  }
  return 0
}

/** Whether the viewport is at the end, so new entries should keep it there. */
export function atEnd(scrollTop: number, viewport: number, total: number, slack = 160): boolean {
  return total - scrollTop - viewport < slack
}
