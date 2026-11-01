import { describe, expect, it } from "vitest"
import { addedAbove, atEnd, keepInPlace, offsets, slice } from "../src/renderer/src/lib/virtual"

/* specs/chat-timeline R2.3, R3.1: only what is near the viewport is rendered. */

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`)

describe("the rendered window (specs/chat-timeline R3.1)", () => {
  it("lays entries out from measured heights, and an estimate for the rest", () => {
    expect(offsets(["a", "b", "c"], new Map([["b", 50]]), 10)).toEqual([0, 10, 60, 70])
  })

  it("renders only the entries meeting the viewport and its overscan, out of 10,000", () => {
    const offs = offsets(ids(10_000), new Map(), 40)
    const s = slice(offs, 200_000, 800, 200)
    expect(s.start).toBe(Math.floor((200_000 - 200) / 40))
    expect(s.end).toBe(Math.ceil((200_000 + 800 + 200) / 40) + 1)
    expect(s.end - s.start).toBeLessThan(40)
    expect(s.before + (offs[s.end] - offs[s.start]) + s.after).toBe(offs.at(-1))
  })

  it("starts at the top and stops at the end", () => {
    const offs = offsets(ids(5), new Map(), 100)
    expect(slice(offs, 0, 150, 0)).toEqual({ start: 0, end: 2, before: 0, after: 300 })
    expect(slice(offs, 450, 500, 0)).toEqual({ start: 4, end: 5, before: 400, after: 0 })
    expect(slice(offs, 9999, 100, 0)).toMatchObject({ start: 4, end: 5 })
    expect(slice([0], 0, 100, 0)).toEqual({ start: 0, end: 0, before: 0, after: 0 })
  })

  it("keeps what was on screen in place when older entries are added above it (R2.3)", () => {
    expect(keepInPlace(0, 1000, 1600)).toBe(600)
    expect(keepInPlace(120, 1000, 1000)).toBe(120)
  })

  it("measures what was added above from the first old entry still present, even when the boundary entry merged", () => {
    const old = ["t5", "a", "b"]
    const oldOffs = offsets(old, new Map(), 10)
    // the older page ended in tool calls, so the run at the boundary now starts at t1
    const now = ["u0", "t1", "a", "b"]
    expect(addedAbove(old, oldOffs, now, offsets(now, new Map([["t1", 50]]), 10))).toBe(60 - 10)
    expect(addedAbove(old, oldOffs, old, oldOffs)).toBe(0)
    expect(addedAbove([], [0], now, offsets(now, new Map(), 10))).toBe(0)
    expect(addedAbove(old, oldOffs, ["x"], [0, 10])).toBe(0)
  })

  it("knows when the viewport is at the end", () => {
    expect(atEnd(900, 100, 1000)).toBe(true)
    expect(atEnd(0, 100, 1000)).toBe(false)
  })
})
