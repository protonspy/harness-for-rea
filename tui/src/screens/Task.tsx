import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Push, StepRow, TaskHistory } from "../../../src/shared/types"
import { blocks, canSend, pendingCalls, pendingQuestions, type ChatBlock, type ToolItem } from "../../../src/renderer/src/lib/chat"
import { tone } from "../../../src/renderer/src/lib/format"
import { addUsage, filesOfStep, fold } from "../../../src/renderer/src/lib/store"
import { stepOf, Timeline, type SpecialistEntry } from "../../../src/renderer/src/lib/timeline"
import type { Command } from "../app/commands"
import { useApp, useKeys, usePush, useScreen } from "../app/context"
import { toneColor } from "../app/theme"
import { askQuestion, decideCall, Diff } from "../components/decisions"
import { ConfirmDialog } from "../components/dialogs"
import { Markdown } from "../components/Markdown"
import { Sidebar } from "../components/Sidebar"
import { safe } from "../components/ui"
import { actionsFor, callState, delegationSections, toolDetails, toolLine, workingLine } from "../lib/transcript"

/*
  A task as a conversation (specs/tui-conversation): the transcript folded from the event log by the desktop app's
  own Timeline, newest page first and older pages on reaching the top; tool calls, delegations and the specialist's
  run shown expanded and collapsible (specs/chat-timeline R1.2); the working line; the actions the state allows; and
  the decisions it waits on, in dialogs.
*/

const PAGE = 400
const TURN_STARTS = new Set(["task.started", "message.user", "turn.continued", "task.reopened"])

/**
  The task's loaded history, kept outside React's state so pushes fold into it as they arrive: the desktop app's
  Timeline over the events, the pushes that came while the first page loaded, and the decisions already offered.
*/
class Feed {
  private line: Timeline | null = null
  private queued: Push[] | null = []
  private readonly offered = new Set<string>()

  constructor(private readonly taskId: string) {}

  get timeline(): Timeline | null {
    return this.line
  }

  /** The first page; the pushes that waited for it are folded after. Returns them. */
  load(hist: TaskHistory): Push[] {
    this.line = new Timeline(hist.steps, hist.events, !hist.hasOlder)
    const waiting = this.queued ?? []
    this.queued = null
    return waiting
  }

  /** Whether the event was folded in; a push before the first page waits. */
  event(p: Push): "queued" | "folded" | "skipped" {
    if (this.queued) {
      this.queued.push(p)
      return "queued"
    }
    if (p.type !== "event" || p.event.taskId !== this.taskId || !this.line) return "skipped"
    return this.line.append([p.event]) ? "folded" : "skipped"
  }

  /** The older page joined in front (specs/tui-conversation R1.6). */
  prepend(older: TaskHistory): void {
    if (this.line) this.line = this.line.prepend(older.events, older.steps, !older.hasOlder)
  }

  /** True the first time a decision is offered, so its dialog opens once (R3.2, R3.3). */
  offerOnce(id: string): boolean {
    if (this.offered.has(id)) return false
    this.offered.add(id)
    return true
  }
}

export function TaskScreen({ id }: { id: string }) {
  const app = useApp()
  const { api, bus, theme, toast, back } = app
  const feed = useMemo(() => new Feed(id), [id])
  const [h, setH] = useState<TaskHistory | null>(null)
  const [version, setVersion] = useState(0)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // The newest page, then every push folded in; pushes that arrive while it loads wait for it.
  useEffect(() => {
    let alive = true
    const apply = (p: Push) => {
      const r = feed.event(p)
      if (r === "folded" && p.type === "event") {
        setVersion((v) => v + 1)
        setH((cur) => (cur ? { ...cur, usage: addUsage(cur.usage, p.event) } : cur))
      } else if (r === "skipped" && p.type !== "event") setH((cur) => fold(cur, p))
    }
    const off = bus.on(apply)
    void api.getTask(id, { limit: PAGE }).then(
      (hist) => {
        if (!alive) return
        const waiting = feed.load(hist)
        setH({ ...hist, events: [] })
        for (const p of waiting) apply(p)
        setVersion((v) => v + 1)
      },
      (e: unknown) => toast((e as Error).message, "error"),
    )
    return () => {
      alive = false
      off()
    }
  }, [api, bus, id, feed, toast])
  usePush((p) => p.type === "taskDeleted" && p.id === id && back())

  // Reaching the top of the loaded transcript loads the older page (R1.6).
  const t = feed.timeline
  const loadOlder = useCallback(() => {
    const line = feed.timeline
    if (!line || line.fromStart || loadingOlder) return
    setLoadingOlder(true)
    void api
      .getTask(id, { beforeEvent: line.firstId, limit: PAGE })
      .then((older) => {
        feed.prepend(older)
        setVersion((v) => v + 1)
      })
      .finally(() => setLoadingOlder(false))
  }, [api, id, feed, loadingOlder])
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      const box = scroll.current
      if (box && box.scrollTop <= 0 && box.scrollHeight > 0) loadOlder()
    }, 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [loadOlder])

  const items = useMemo(() => (version >= 0 && t ? [...t.items] : []), [t, version])
  const entries = useMemo(() => blocks(items), [items])
  const state = h ? (h.turn ?? h.task.state) : "pending"
  const questions = pendingQuestions(items)
  const calls = pendingCalls(items)
  const gated = new Set(calls.map((c) => String(c.args.patchId ?? "")))
  const orphans = h && state !== "running" && state !== "pending" ? h.patches.filter((p) => p.state === "proposed" && !gated.has(p.id)) : []

  const answer = async (qid?: string) => {
    const q = questions.find((x) => !qid || x.id === qid)
    if (!q) return toast("No question waits for an answer.", "info")
    const a = await askQuestion(app, q.agent, q.question)
    if (a !== null) await app.attempt(() => api.answerQuestion(id, q.id, a))
  }
  const decide = async (callId?: string) => {
    const call = calls.find((c) => !callId || c.callId === callId)
    if (!call) return toast("No call waits for a decision.", "info")
    const patch = h?.patches.find((p) => p.id === call.args.patchId)
    const d = await decideCall(app, call, patch)
    if (d) await app.attempt(() => api.decideTool(id, call.callId, d))
  }
  // A decision that comes up opens its dialog once; Esc leaves it for /answer or /decide (R3.2, R3.3).
  const pending = [...questions.map((q) => q.id), ...calls.map((c) => c.callId)].join(",")
  const offer = useRef<(pending: string) => void>(() => undefined)
  useEffect(() => {
    offer.current = (ids) => {
      // The first decision not offered yet: one left with Esc stays for /answer or /decide, the next still opens.
      const first = ids.split(",").find((x) => x && feed.offerOnce(x))
      if (!first) return
      // Once its dialog closes, answered or left, the next pending decision is offered.
      const next = () => offer.current(ids)
      if (questions.some((q) => q.id === first)) void answer(first).then(next)
      else void decide(first).then(next)
    }
  })
  useEffect(() => offer.current(pending), [pending])

  const remove = async () => {
    const ok = await app.dialog<boolean>((done) => (
      <ConfirmDialog title="Delete the task" body="Delete this task with its history, files and containers? This cannot be undone." yes="Delete" done={done} />
    ))
    if (ok && (await app.attempt(() => api.deleteTask(id), "Task deleted."))) back()
  }
  const toggleAll = () => setCollapsed((c) => (c.size ? new Set() : new Set(entries.map((e) => e.id))))
  const toggle = (eid: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(eid)) n.delete(eid)
      else n.add(eid)
      return n
    })
  const ACTION: Record<string, Command> = {
    stop: { name: "stop", title: "Stop the turn", key: "escape", run: () => void app.attempt(() => api.stopTurn(id)) },
    continue: { name: "continue", title: "Continue from where it stopped", run: () => void app.attempt(() => api.continueTurn(id)) },
    close: { name: "close", title: "Close the conversation, keeping its containers stopped", run: () => void app.attempt(() => api.closeTask(id)) },
    cancel: { name: "cancel", title: "Cancel the task, removing its containers and keeping its files", run: () => void app.attempt(() => api.cancelTask(id)) },
    retry: {
      name: "start-over",
      title: "Start a new task from the same request",
      run: async () => {
        const t2 = await app.attempt(() => api.retryTask(id))
        if (t2) app.go({ kind: "task", id: t2.id })
      },
    },
    delete: { name: "delete", title: "Delete the task, its history, files and containers", run: remove },
  }
  const commands: Command[] = [
    ...actionsFor(state).map((a) => ACTION[a]),
    ...(questions.length ? [{ name: "answer", title: "Answer the question the task waits on", run: () => answer() }] : []),
    ...(calls.length ? [{ name: "decide", title: "Approve, edit or reject the call the task waits on", run: () => decide() }] : []),
    ...orphans.flatMap((p) => [
      {
        name: "approve-patch",
        title: "Apply the proposed patch to your files",
        run: () => void app.attempt(() => api.decidePatch(id, p.id, "approve"), "Patch applied."),
      },
      { name: "reject-patch", title: "Reject the proposed patch", run: () => void app.attempt(() => api.decidePatch(id, p.id, "reject"), "Patch rejected.") },
    ]),
    { name: "events", title: "Open the task's event log", run: () => app.go({ kind: "events", taskId: id }) },
    { name: "older", title: "Load the older events", run: loadOlder },
    { name: "expand", title: "Expand or collapse every tool call and delegation", key: "ctrl+o", run: () => toggleAll() },
  ]

  const live = state === "running" || state === "pending" || state === "waiting"
  const events = t?.events ?? []
  let since = h?.task.updatedAt ?? now
  for (let i = events.length - 1; i >= 0; i--)
    if (TURN_STARTS.has(events[i].kind)) {
      since = events[i].at
      break
    }
  useScreen({
    title: h ? h.task.request.replace(/\s+/g, " ").slice(0, 60) : "Task",
    status: state,
    working: h && live ? workingLine(h.task, state, since, now) : undefined,
    placeholder: canSend(state)
      ? live
        ? "A message the agent reads before its next step"
        : "Your reply, or a message that continues the task"
      : "This task takes no message now",
    onSubmit: canSend(state) ? (text) => void app.attempt(() => api.sendMessage(id, text)) : undefined,
    commands,
    mentionRoot: h?.task.sourceRoot,
  })

  // The transcript's keys: Tab moves into it, ↑ ↓ pick an item, Enter folds it; Esc stops a running turn (R2.4).
  const order = entries.map((e) => e.id)
  const at = Math.max(0, order.indexOf(selected ?? ""))
  const pick = (by: number) => {
    const next = order[Math.min(order.length - 1, Math.max(0, at + by))]
    if (!next) return
    setSelected(next)
    scroll.current?.scrollChildIntoView(`blk-${next}`)
    if (at + by < 0) loadOlder()
  }
  useKeys("task", "Task", [
    { key: "escape", label: "Stop the turn", run: () => (live ? void app.attempt(() => api.stopTurn(id)) : false) },
    {
      key: "tab",
      label: "Prompt or transcript",
      hint: true,
      run: () => {
        app.setPromptFocused(!app.promptFocused)
        if (app.promptFocused && !selected) setSelected(order.at(-1) ?? null)
      },
    },
    { key: "ctrl+o", label: "Expand or collapse all", hint: true, run: toggleAll },
    {
      key: "pageup",
      label: "Scroll up",
      run: () => {
        scroll.current?.scrollBy(-10)
        if (scroll.current?.scrollTop === 0) loadOlder()
      },
    },
    { key: "pagedown", label: "Scroll down", run: () => void scroll.current?.scrollBy(10) },
  ])
  useKeys(
    "transcript",
    "Transcript",
    [
      { key: "up", label: "Previous item", run: () => pick(-1) },
      { key: "down", label: "Next item", run: () => pick(1) },
      { key: "return", label: "Fold or unfold the item", run: () => void (selected && toggle(selected)) },
      { key: "end", label: "Newest", run: () => pick(order.length) },
    ],
    { active: !app.promptFocused },
  )

  if (!h || !t) return <text fg={theme.mutedForeground}>Loading the task…</text>
  const ctx = { steps: h.steps, events: t.events, run: (sid: string) => t.run(sid) }
  return (
    <box flexDirection="row" flexGrow={1}>
      <scrollbox ref={scroll} flexGrow={1} stickyScroll stickyStart="bottom" scrollY>
        {!t.fromStart && <text fg={theme.mutedForeground}>{"  ↑ earlier events load as you reach the top (/older)"}</text>}
        {entries.map((e) => (
          <box
            key={e.id}
            id={`blk-${e.id}`}
            flexDirection="column"
            marginBottom={1}
            backgroundColor={!app.promptFocused && e.id === selected ? theme.accent : undefined}
          >
            <Entry entry={e} open={!collapsed.has(e.id)} ctx={ctx} />
          </box>
        ))}
        {orphans.map((p) => (
          <box key={p.id} flexDirection="column" border borderStyle="rounded" borderColor={theme.warning} marginBottom={1}>
            <Diff patch={p} />
            <text fg={theme.warning}>/approve-patch applies it to your files · /reject-patch drops it</text>
          </box>
        ))}
        {h.task.error ? <text fg={theme.destructive}>{safe(h.task.error)}</text> : null}
      </scrollbox>
      {app.sidebar && <Sidebar h={h} events={t.events} />}
    </box>
  )
}

interface Ctx {
  steps: StepRow[]
  events: TaskHistory["events"]
  run(stepId: string): SpecialistEntry[]
}

function Entry({ entry, open, ctx }: { entry: ChatBlock; open: boolean; ctx: Ctx }) {
  const { theme } = useApp()
  switch (entry.kind) {
    case "user":
      return (
        <box flexDirection="column">
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            {"› You"}
            {entry.read ? null : <span fg={theme.mutedForeground}>{"  not read yet"}</span>}
          </text>
          <box paddingLeft={2}>
            <Markdown text={entry.text} />
          </box>
        </box>
      )
    case "agent":
      return (
        <box flexDirection="column">
          <text fg={theme.success} attributes={TextAttributes.BOLD}>
            ● Orchestrator
          </text>
          <box paddingLeft={2}>
            <Markdown text={entry.text} />
          </box>
        </box>
      )
    case "tools":
      return (
        <box flexDirection="column">
          {entry.items.map((i) => (
            <ToolCall key={i.id} item={i} open={open} ctx={ctx} />
          ))}
        </box>
      )
    case "tool":
      return <ToolCall item={entry} open={open} ctx={ctx} />
    case "approval":
      return (
        <box flexDirection="column">
          {entry.calls.map((c) => (
            <text key={c.callId} fg={c.decision ? theme.mutedForeground : theme.warning}>
              {`⏸ ${c.name} `}
              <span fg={theme.mutedForeground}>
                {c.decision ? `${c.decision.type}${c.origin && c.origin !== "user" ? ` (${c.origin})` : ""}` : "waits for your decision: /decide"}
              </span>
            </text>
          ))}
        </box>
      )
    case "question":
      return (
        <box flexDirection="column">
          <text fg={theme.warning}>
            {`? ${entry.agent} asks: `}
            <span fg={theme.foreground}>{safe(entry.question.prompt)}</span>
          </text>
          <text fg={theme.mutedForeground} paddingLeft={2}>
            {entry.origin ? `→ ${safe(String(entry.answer))} (${entry.origin === "user" ? "you" : entry.origin})` : "waits for your answer: /answer"}
          </text>
        </box>
      )
    case "notice":
      return (
        <text fg={entry.tone === "bad" ? theme.destructive : entry.tone === "warn" ? theme.warning : theme.mutedForeground}>{`— ${safe(entry.text)} —`}</text>
      )
  }
}

const GLYPH = { running: "⋯", failed: "✗", done: "✓" }

function ToolCall({ item, open, ctx }: { item: ToolItem; open: boolean; ctx: Ctx }) {
  const { theme } = useApp()
  const step = item.name === "delegate_to_specialist" ? stepOf(item, ctx.steps) : undefined
  if (step) return <Delegation step={step} open={open} ctx={ctx} />
  const s = callState(item)
  const color = { running: theme.primary, failed: theme.destructive, done: theme.success }[s]
  const d = open ? toolDetails(item, 20) : null
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span fg={color}>{`${GLYPH[s]} `}</span>
        <span fg={theme.foreground}>{safe(toolLine(item))}</span>
      </text>
      {d && (
        <box flexDirection="column" paddingLeft={2}>
          <text fg={theme.mutedForeground}>{safe(d.input)}</text>
          {d.output ? <text fg={item.failed ? theme.destructive : theme.foreground}>{safe(d.output)}</text> : null}
        </box>
      )}
    </box>
  )
}

const RUN_GLYPH: Record<SpecialistEntry["kind"], string> = { text: "•", thinking: "∴", tool: "⚙", result: "■", note: "·" }

function Delegation({ step, open, ctx }: { step: StepRow; open: boolean; ctx: Ctx }) {
  const { theme } = useApp()
  const sections = open ? delegationSections(step, filesOfStep(ctx.events, step.id)) : []
  const run = ctx.run(step.id)
  return (
    <box flexDirection="column" border={["left"]} borderColor={toneColor(theme, tone(step.state))} paddingLeft={1}>
      <text>
        <span fg={theme.primary} attributes={TextAttributes.BOLD}>
          {"◆ specialist "}
        </span>
        <span fg={toneColor(theme, tone(step.state))}>{`[${step.state}] `}</span>
        <span fg={theme.foreground}>{safe(step.title)}</span>
      </text>
      {sections.map((s) => (
        <box key={s.title} flexDirection="column" marginTop={1}>
          <text fg={theme.mutedForeground} attributes={TextAttributes.BOLD}>
            {s.title}
          </text>
          {s.title === "Report" ? (
            <Markdown text={s.lines.join("\n")} />
          ) : (
            s.lines.map((l, i) => (
              <text key={i} fg={theme.foreground}>
                {safe(l)}
              </text>
            ))
          )}
        </box>
      ))}
      {run.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.mutedForeground} attributes={TextAttributes.BOLD}>{`Specialist's run (${run.length})`}</text>
          {run.map((e) => (
            <RunEntry key={e.id} entry={e} open={open} />
          ))}
        </box>
      )}
    </box>
  )
}

function RunEntry({ entry, open }: { entry: SpecialistEntry; open: boolean }) {
  const { theme } = useApp()
  const running = entry.kind === "tool" && entry.output === undefined
  const body = entry.body.split("\n").slice(0, 12).join("\n")
  const output = (entry.output ?? "").split("\n").slice(0, 12).join("\n")
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span fg={entry.failed ? theme.destructive : entry.kind === "thinking" ? theme.mutedForeground : theme.primary}>{`${RUN_GLYPH[entry.kind]} `}</span>
        {entry.subagent ? <span fg={theme.warning}>{`[${safe(entry.subagent)}] `}</span> : null}
        <span fg={entry.failed ? theme.destructive : theme.foreground}>{safe(entry.title)}</span>
        {running ? <span fg={theme.primary}>{`  running${entry.elapsedSeconds ? ` · ${entry.elapsedSeconds}s` : ""}`}</span> : null}
      </text>
      {open && entry.kind !== "text" && body && body !== entry.title ? (
        <text fg={theme.mutedForeground} paddingLeft={2} attributes={entry.kind === "thinking" ? TextAttributes.ITALIC : undefined}>
          {safe(body)}
        </text>
      ) : null}
      {open && entry.kind === "text" && entry.body ? (
        <box paddingLeft={2}>
          <Markdown text={entry.body} />
        </box>
      ) : null}
      {open && output ? (
        <text fg={entry.failed ? theme.destructive : theme.foreground} paddingLeft={2}>
          {safe(output)}
        </text>
      ) : null}
    </box>
  )
}
