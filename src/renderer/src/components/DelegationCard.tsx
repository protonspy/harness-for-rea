import { ChevronDown, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import type { ContextPackage, Evidence } from "@shared/context"
import type { EventRow, PatchView, StepRow } from "@shared/types"
import Prose from "@/components/Prose"
import { Badge, Card, Mono } from "@/components/ui"
import { tone } from "@/lib/format"
import { filesOfStep } from "@/lib/store"

/* One delegation: its context package, the specialist's report and evidence, and the files it touched (specs/desktop-ui R2.3). */

export function DelegationCard({ step, events, patches }: { step: StepRow; events: EventRow[]; patches: PatchView[] }) {
  const [open, setOpen] = useState(step.state === "running")
  const files = useMemo(() => filesOfStep(events, step.id), [events, step.id])
  const pkg = step.data.context as ContextPackage | undefined
  const report = typeof step.data.report === "string" ? step.data.report : ""
  const evidence = (step.data.evidence as Evidence[] | undefined) ?? []
  const error = typeof step.data.error === "string" ? step.data.error : ""
  const patch = patches.find((p) => p.stepId === step.id)

  return (
    <Card>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Badge tone="info">specialist</Badge>
        <Badge tone={tone(step.state)}>{step.state}</Badge>
        {pkg && <Badge>{pkg.mode}</Badge>}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{step.title}</span>
        {patch && <Badge tone={patch.state === "applied" ? "ok" : patch.state === "proposed" ? "warn" : "neutral"}>patch {patch.state}</Badge>}
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-line p-4">
          {error && <p className="text-sm text-bad">{error}</p>}
          {pkg && (
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">Context package</h4>
              <Prose text={pkg.objective} />
              <List title="Questions" items={pkg.questions} />
              <List title="Constraints" items={pkg.constraints} />
              <List title="Environment" items={pkg.environment} />
              <List title="Excerpts" items={pkg.excerpts.map((e) => `${e.path}:${e.startLine}-${e.endLine}${e.note ? ` — ${e.note}` : ""}`)} mono />
            </section>
          )}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Files title="Copied in" items={files.copy} />
            <Files title="Read" items={files.read} />
            <Files title="Written" items={files.write} />
            <Files title="Applied" items={files.apply} />
          </section>
          {report && (
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">Report</h4>
              <Prose text={report} className="max-h-[480px] overflow-y-auto rounded-md border border-line bg-bg p-3" />
            </section>
          )}
          {evidence.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">Evidence</h4>
              {evidence.map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <Badge tone={e.checked ? "ok" : "bad"} className="mt-0.5 shrink-0">
                    {e.checked ? "in package" : "unverified"}
                  </Badge>
                  <Mono className="shrink-0 text-accent">
                    {e.path}:{e.startLine}-{e.endLine}
                  </Mono>
                  <span>{e.claim}</span>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </Card>
  )
}

function List({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  if (!items.length) return null
  return (
    <div>
      <div className="text-xs text-muted">{title}</div>
      <ul className="ml-4 list-disc text-sm">
        {items.map((x, i) => (
          <li key={i}>{mono ? <Mono>{x}</Mono> : x}</li>
        ))}
      </ul>
    </div>
  )
}

function Files({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-md border border-line bg-bg p-2.5">
      <div className="mb-1 text-xs text-muted">
        {title} <span className="font-mono">{items.length}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((f) => (
          <li key={f} className="truncate font-mono text-[11px]" title={f}>
            {f}
          </li>
        ))}
      </ul>
    </div>
  )
}
