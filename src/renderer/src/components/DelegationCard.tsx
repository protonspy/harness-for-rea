import { Brain, ChevronDown, ChevronRight, MessageSquareText, Wrench } from "lucide-react"
import { useMemo, useState } from "react"
import type { ContextPackage, Evidence } from "@shared/context"
import type { EventRow, PatchView, StepRow } from "@shared/types"
import Markdown from "@/components/Markdown"
import Prose from "@/components/Prose"
import { Mono } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { SpecialistEntry } from "@/lib/timeline"
import { tone } from "@/lib/format"
import { filesOfStep } from "@/lib/store"

/*
  One delegation: its context package, the specialist's own run nested under it (specs/chat-timeline R1.1),
  its report and evidence, and the files it touched (specs/desktop-ui R2.3).
*/

export function DelegationCard({ step, events, patches, run = [] }: { step: StepRow; events: EventRow[]; patches: PatchView[]; run?: SpecialistEntry[] }) {
  // Open from the start, with the run and reasoning under it (specs/chat-timeline R1.2).
  const [open, setOpen] = useState(true)
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
        <Badge variant="info">specialist</Badge>
        <Badge variant={tone(step.state)}>{step.state}</Badge>
        {pkg && <Badge>{pkg.mode}</Badge>}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{step.title}</span>
        {patch && <Badge variant={patch.state === "applied" ? "ok" : patch.state === "proposed" ? "warn" : "neutral"}>patch {patch.state}</Badge>}
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-border p-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {pkg && (
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Context package</h4>
              {pkg.brief && <Prose text={pkg.brief} className="rounded-md border border-border bg-background p-3 text-muted-foreground" />}
              <Prose text={pkg.objective} />
              <List title="Questions" items={pkg.questions} />
              <List title="Constraints" items={pkg.constraints} />
              <List title="Environment" items={pkg.environment} />
              <List title="Excerpts" items={pkg.excerpts.map((e) => `${e.path}:${e.startLine}-${e.endLine}${e.note ? ` — ${e.note}` : ""}`)} mono />
            </section>
          )}
          {run.length > 0 && (
            <section className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Specialist's run ({run.length})</h4>
              {run.map((e) => (
                <RunEntry key={e.id} entry={e} />
              ))}
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
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Report</h4>
              <Markdown text={report} className="max-h-[480px] overflow-y-auto rounded-md border border-border bg-background p-3" />
            </section>
          )}
          {evidence.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Evidence</h4>
              {evidence.map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <Badge variant={e.kind === "rea" ? "info" : e.checked ? "ok" : "bad"} className="mt-0.5 shrink-0">
                    {e.kind === "rea" ? (e.ref?.startsWith("unk_") ? "REA unknown, cited" : "REA evidence, cited") : e.checked ? "in package" : "unverified"}
                  </Badge>
                  <Mono className="shrink-0 text-primary" title={e.ref}>
                    {evidenceLabel(e)}
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

const ICONS = { text: MessageSquareText, thinking: Brain, tool: Wrench, result: MessageSquareText, note: ChevronRight }

/** One entry of the specialist's run — its text, reasoning or tool call — shown open (specs/chat-timeline R1.2). */
function RunEntry({ entry }: { entry: SpecialistEntry }) {
  const Icon = ICONS[entry.kind]
  const running = entry.kind === "tool" && entry.output === undefined
  return (
    <Collapsible defaultOpen className="rounded border bg-background/60">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground [&_svg]:shrink-0">
        <Icon size={12} />
        {entry.subagent && <Badge>{entry.subagent}</Badge>}
        <span className={entry.failed ? "truncate text-destructive" : "truncate text-foreground"}>{entry.title}</span>
        {running && <Badge variant="info">running{entry.elapsedSeconds ? ` · ${entry.elapsedSeconds}s` : ""}</Badge>}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-2.5 py-2">
        <pre className="max-h-64 overflow-auto font-mono text-[11.5px] leading-5 break-all whitespace-pre-wrap">{entry.body || "—"}</pre>
        {entry.output !== undefined && (
          <pre className="mt-2 max-h-64 overflow-auto border-t pt-2 font-mono text-[11.5px] leading-5 break-all whitespace-pre-wrap">{entry.output || "—"}</pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function List({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  if (!items.length) return null
  return (
    <div>
      <div className="text-xs text-muted-foreground">{title}</div>
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
    <div className="rounded-md border border-border bg-background p-2.5">
      <div className="mb-1 text-xs text-muted-foreground">
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

/** Where a piece of evidence points: a line range, an address in a file, or an REA id shortened for the eye (specs/rea-native R3). */
function evidenceLabel(e: Evidence): string {
  if (e.kind === "rea") return `${e.ref?.slice(0, 16)}…`
  if (e.kind === "address") return `${e.path}@${e.ref}`
  return `${e.path}:${e.startLine}-${e.endLine}`
}
