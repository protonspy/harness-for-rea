import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { addedAbove, atEnd, keepInPlace, offsets, slice } from "@/lib/virtual"

/*
  The timeline rendered through a window (specs/chat-timeline R3.1): only the entries near the
  viewport are mounted, each measured once on screen, the rest held by the space they take. An
  entry above the viewport that grows or shrinks moves the scroll by as much, so what is read stays
  where it is: an older page added above keeps the content in place (R2.3), and while the user is at
  the end the timeline follows it.
*/

const ESTIMATE = 72
const OVERSCAN = 800

export function VirtualTimeline<T extends { id: string }>({
  entries,
  render,
  onNearTop,
  top,
  bottom,
}: {
  entries: T[]
  render(entry: T): ReactNode
  onNearTop?(): void
  /** shown above the entries, e.g. that older ones are loading */
  top?: ReactNode
  /** shown under the entries, outside the window */
  bottom?: ReactNode
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [view, setView] = useState({ top: 0, height: 800 })
  const ids = useMemo(() => entries.map((e) => e.id), [entries])
  const offs = useMemo(() => offsets(ids, heights, ESTIMATE), [ids, heights])
  const layout = useRef({ ids, offs })
  const nearTop = useRef(onNearTop)
  const stick = useRef(true)
  /** height changes of entries above what is read, not yet applied to the scroll */
  const shift = useRef(0)

  useLayoutEffect(() => {
    nearTop.current = onNearTop
  }, [onNearTop])

  /** A row's measured height; an entry above what is read moves the scroll with it once the layout has it. */
  const onSize = useCallback((id: string, height: number) => {
    const { ids: at, offs: by } = layout.current
    const i = at.indexOf(id)
    if (i >= 0 && by[i + 1] <= (viewport.current?.scrollTop ?? 0)) shift.current += height - (by[i + 1] - by[i])
    setHeights((cur) => {
      if (cur.get(id) === height) return cur
      const next = new Map(cur)
      next.set(id, height)
      return next
    })
  }, [])

  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const update = () => {
      stick.current = atEnd(el.scrollTop, el.clientHeight, el.scrollHeight)
      setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }))
      if (el.scrollTop < OVERSCAN) nearTop.current?.()
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const size = new ResizeObserver(update)
    size.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      size.disconnect()
    }
  }, [])

  // After every layout: entries added above move the scroll by their height; at the end, stay at the end.
  useLayoutEffect(() => {
    const before = layout.current
    layout.current = { ids, offs }
    const el = viewport.current
    if (!el) return
    const added = addedAbove(before.ids, before.offs, ids, offs)
    if (added) el.scrollTop = keepInPlace(el.scrollTop, 0, added)
    else if (stick.current) el.scrollTop = el.scrollHeight
    else if (shift.current) el.scrollTop += shift.current
    shift.current = 0
    // Still near the top after a page went in: no scroll event will come, so ask for the next one now.
    if (added && el.scrollTop < OVERSCAN) nearTop.current?.()
  }, [ids, offs])

  const s = slice(offs, view.top, view.height, OVERSCAN)
  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewport}>
      <div className="mx-auto flex max-w-4xl flex-col px-6 py-5">
        {top}
        <div style={{ paddingTop: s.before, paddingBottom: s.after }}>
          {entries.slice(s.start, s.end).map((e) => (
            <Row key={e.id} id={e.id} onSize={onSize}>
              {render(e)}
            </Row>
          ))}
        </div>
        {bottom}
      </div>
    </ScrollArea>
  )
}

function Row({ id, onSize, children }: { id: string; onSize(id: string, height: number): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const size = new ResizeObserver(([row]) => onSize(id, row.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight))
    size.observe(el)
    return () => size.disconnect()
  }, [id, onSize])
  return (
    <div ref={ref} data-id={id} className="pb-4">
      {children}
    </div>
  )
}
