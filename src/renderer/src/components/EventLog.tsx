import { useEffect, useMemo, useRef, useState } from "react"
import type { EventRow, StepRow } from "@shared/types"
import { Mono, PanelHeader } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
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
      <PanelHeader
        title={`Event log (${events.length})`}
        actions={
          <div className="flex items-center gap-1">
            {AGENTS.map((a) => (
              <button
                key={a}
                onClick={() => setAgent(a)}
                className={cn("rounded px-2 py-0.5 text-xs", agent === a ? "bg-muted text-primary" : "text-muted-foreground hover:text-foreground")}
              >
                {a}
              </button>
            ))}
            <Label className="ml-2 gap-1 text-xs text-muted-foreground">
              <Checkbox checked={follow} onCheckedChange={(v) => setFollow(v === true)} /> follow
            </Label>
          </div>
        }
      />
      <div className="max-h-[520px] overflow-y-auto font-mono text-[12px]">
        {shown.map((e) => (
          <div key={e.id} className="border-b border-border/60">
            <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-accent">
              <span className="shrink-0 text-muted-foreground">{clock(e.at)}</span>
              <span className={cn("w-20 shrink-0", e.agent === "specialist" ? "text-primary" : e.agent === "sandbox" ? "text-warning" : "text-foreground/70")}>
                {e.agent}
              </span>
              <span className="w-40 shrink-0 truncate text-muted-foreground">{e.kind}</span>
              <span className="min-w-0 flex-1 truncate">{e.summary}</span>
              {e.state && <Badge variant={tone(e.state)}>{e.state}</Badge>}
            </button>
            {open === e.id && (
              <div className="bg-background px-3 pb-2">
                {e.stepId && <div className="pt-1 text-muted-foreground">step: {titles.get(e.stepId) ?? e.stepId}</div>}
                {e.truncated && <div className="text-warning">payload truncated</div>}
                <Mono className="block pt-1 whitespace-pre-wrap break-all text-foreground/80">{JSON.stringify(e.payload, null, 2)}</Mono>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
    </Card>
  )
}
