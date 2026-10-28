import { useEffect, useMemo, useRef, useState } from "react"
import type { EventRow, StepRow } from "@shared/types"
import { Badge, Card, CardHeader, Mono } from "@/components/ui"
import { cn } from "@/lib/cn"
import { clock, tone } from "@/lib/format"

/* Every event of the task as it arrives, filterable by agent, each expandable to its payload (specs/desktop-ui R2.2). */

const AGENTS = ["all", "orchestrator", "specialist", "sandbox", "app"] as const

export function EventLogPanel({ events, steps }: { events: EventRow[]; steps: StepRow[] }) {
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>("all")
  const [open, setOpen] = useState<number | null>(null)
  const [follow, setFollow] = useState(true)
  const end = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => (agent === "all" ? events : events.filter((e) => e.agent === agent)), [events, agent])
  const titles = useMemo(() => new Map(steps.map((s) => [s.id, s.title])), [steps])

  useEffect(() => {
    if (follow && shown.length) end.current?.scrollIntoView({ block: "nearest" })
  }, [shown.length, follow])

  return (
    <Card>
      <CardHeader
        title={`Event log (${events.length})`}
        actions={
          <div className="flex items-center gap-1">
            {AGENTS.map((a) => (
              <button
                key={a}
                onClick={() => setAgent(a)}
                className={cn("rounded px-2 py-0.5 text-xs", agent === a ? "bg-raised text-accent" : "text-muted hover:text-ink")}
              >
                {a}
              </button>
            ))}
            <label className="ml-2 flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
            </label>
          </div>
        }
      />
      <div className="max-h-[520px] overflow-y-auto font-mono text-[12px]">
        {shown.map((e) => (
          <div key={e.id} className="border-b border-line/60">
            <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-raised">
              <span className="shrink-0 text-muted">{clock(e.at)}</span>
              <span className={cn("w-20 shrink-0", e.agent === "specialist" ? "text-accent" : e.agent === "sandbox" ? "text-warn" : "text-ink/70")}>
                {e.agent}
              </span>
              <span className="w-40 shrink-0 truncate text-muted">{e.kind}</span>
              <span className="min-w-0 flex-1 truncate">{e.summary}</span>
              {e.state && <Badge tone={tone(e.state)}>{e.state}</Badge>}
            </button>
            {open === e.id && (
              <div className="bg-bg px-3 pb-2">
                {e.stepId && <div className="pt-1 text-muted">step: {titles.get(e.stepId) ?? e.stepId}</div>}
                {e.truncated && <div className="text-warn">payload truncated</div>}
                <Mono className="block pt-1 whitespace-pre-wrap break-all text-ink/80">{JSON.stringify(e.payload, null, 2)}</Mono>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
    </Card>
  )
}
