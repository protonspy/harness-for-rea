import { Bot, CheckCheck, ChevronRight, Clock, Wrench } from "lucide-react"
import type { EventRow, PatchView, StepRow } from "@shared/types"
import { DelegationCard } from "@/components/DelegationCard"
import Prose from "@/components/Prose"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { AgentItem, NoticeItem, ToolItem, UserItem } from "@/lib/chat"
import { cn } from "@/lib/cn"
import { clock } from "@/lib/format"

/* The plain entries of the conversation: the user's and the agent's messages, a tool call, a notice (specs/chat R7.1). */

export function UserMessage({ item }: { item: UserItem }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg rounded-br-sm border border-primary/25 bg-primary/10 px-3.5 py-2.5">
        <Prose text={item.text} />
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {clock(item.at)}
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={item.read ? "Read by the orchestrator" : "Not read yet"}>
                {item.read ? <CheckCheck size={13} className="text-primary" /> : <Clock size={12} />}
              </span>
            </TooltipTrigger>
            <TooltipContent>{item.read ? "Read by the orchestrator" : "The orchestrator reads it before its next step"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export function AgentMessage({ item }: { item: AgentItem }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-card text-primary">
        <Bot size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Orchestrator</span>
          {clock(item.at)}
        </div>
        <Prose text={item.text} />
      </div>
    </div>
  )
}

export function ToolCall({ item, steps, events, patches }: { item: ToolItem; steps: StepRow[]; events: EventRow[]; patches: PatchView[] }) {
  const step = item.stepId ? steps.find((s) => s.id === item.stepId) : undefined
  if (step) return <DelegationCard step={step} events={events} patches={patches} />
  return (
    <Collapsible className="rounded-md border bg-card/60">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground [&_svg]:shrink-0">
        <ChevronRight size={13} className="transition-transform group-data-[state=open]:rotate-90" />
        <Wrench size={12} />
        <span className="font-mono text-foreground">{item.name}</span>
        {item.output === undefined ? (
          <Badge variant="info">running</Badge>
        ) : item.failed ? (
          <Badge variant="bad">failed</Badge>
        ) : (
          <span className="truncate">{oneLine(item.output)}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2">
        <Payload label="Input" text={item.input} />
        {item.output !== undefined && <Payload label="Result" text={item.output} />}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A run of the orchestrator's tool calls, folded into one line until opened. */
export function ToolRun({ items, steps, events, patches }: { items: ToolItem[]; steps: StepRow[]; events: EventRow[]; patches: PatchView[] }) {
  if (items.length === 1)
    return (
      <div className="ml-10">
        <ToolCall item={items[0]} steps={steps} events={events} patches={patches} />
      </div>
    )
  const last = items.at(-1)!
  const running = last.output === undefined
  return (
    <Collapsible className="ml-10">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground [&_svg]:shrink-0">
        <ChevronRight size={13} className="transition-transform group-data-[state=open]:rotate-90" />
        <Wrench size={12} />
        <span>
          {items.length} tool calls{items.some((i) => i.failed) ? `, ${items.filter((i) => i.failed).length} failed` : ""}
        </span>
        <span className="truncate">
          · {running ? "running" : "last"} <span className="font-mono text-foreground">{last.name}</span>
        </span>
        {running && <Badge variant="info">running</Badge>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 flex flex-col gap-1.5">
        {items.map((i) => (
          <ToolCall key={i.id} item={i} steps={steps} events={events} patches={patches} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 120)
}

export function Payload({ label, text }: { label: string; text: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="max-h-64 overflow-auto rounded border bg-background p-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap break-all">
        {text || "—"}
      </pre>
    </div>
  )
}

const NOTICE_TONE: Record<NoticeItem["tone"], string> = {
  neutral: "text-muted-foreground",
  warn: "text-warning",
  bad: "text-destructive",
}

export function Notice({ item }: { item: NoticeItem }) {
  return (
    <div className={cn("flex items-center gap-3 text-xs", NOTICE_TONE[item.tone])}>
      <span className="h-px flex-1 bg-border" />
      {item.text}
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}
