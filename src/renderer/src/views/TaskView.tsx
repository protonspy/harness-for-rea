import { ListTodo, RotateCcw, ScrollText, SquareX, Trash2, Users, Wallet } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Answer, ToolDecision } from "@shared/chat"
import type { Push, TaskHistory } from "@shared/types"
import { ApprovalCard } from "@/components/chat/ApprovalCard"
import { Composer } from "@/components/chat/Composer"
import { AgentMessage, Notice, ToolCall, ToolRun, UserMessage, type ToolContext } from "@/components/chat/Messages"
import { QuestionCard } from "@/components/chat/QuestionCard"
import { VirtualTimeline } from "@/components/chat/VirtualTimeline"
import { ErrorText, Mono } from "@/components/common"
import { DelegationCard } from "@/components/DelegationCard"
import { EventLogPanel } from "@/components/EventLog"
import { PatchReview } from "@/components/PatchReview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { blocks, canClose, canDelete, pendingCalls, pendingQuestions, type ChatBlock } from "@/lib/chat"
import { tokens, tone, usd, when } from "@/lib/format"
import { addUsage, canRetry, fold, isLive } from "@/lib/store"
import { Timeline } from "@/lib/timeline"

/*
  One task as a chat timeline (specs/chat R7, specs/chat-timeline): the newest page of its events first,
  older pages as the user scrolls up, only the entries near the viewport rendered, the message box under
  them, and beside them the plan, delegations, usage and event log. Usage and step state are the main
  process's, for the whole task (specs/chat-timeline R3.3).
*/

/** Events per page read from the log (specs/chat-timeline R2.2). */
const PAGE = 400

export function TaskView({ id, onOpen, onDeleted }: { id: string; onOpen(id: string): void; onDeleted(): void }) {
  /** the history without its events, which the timeline holds */
  const [h, setH] = useState<TaskHistory | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  /** the timeline's entries, taken again whenever it folds in place (specs/chat-timeline R3.2) */
  const [entries, setEntries] = useState<ChatBlock[]>([])
  const [error, setError] = useState("")
  const api = window.hfr.api
  const loadingOlder = useRef(false)

  useEffect(() => {
    let alive = true
    let line: Timeline | null = null
    const queued: Push[] = []
    const apply = (p: Push) => {
      if (p.type === "event") {
        if (p.event.taskId !== id || !line) return
        if (line.append([p.event])) {
          setEntries(blocks(line.items))
          setH((cur) => (cur ? { ...cur, usage: addUsage(cur.usage, p.event) } : cur))
        }
      } else setH((cur) => fold(cur, p))
    }
    const off = window.hfr.onPush((p) => (line ? apply(p) : queued.push(p)))
    void api.getTask(id, { limit: PAGE }).then((hist) => {
      if (!alive) return
      line = new Timeline(hist.steps, hist.events, !hist.hasOlder)
      setTimeline(line)
      setEntries(blocks(line.items))
      setH({ ...hist, events: [] })
      for (const p of queued) apply(p)
    })
    return () => {
      alive = false
      off()
    }
  }, [api, id])

  const loadOlder = useCallback(() => {
    const t = timeline
    if (!t || t.fromStart || loadingOlder.current) return
    loadingOlder.current = true
    void api
      .getTask(id, { beforeEvent: t.firstId, limit: PAGE })
      .then((older) => {
        // Events pushed while the page loaded are already in `t`; the refold keeps them (R2.3).
        const whole = t.prepend(older.events, older.steps, !older.hasOlder)
        setTimeline(whole)
        setEntries(blocks(whole.items))
      })
      .finally(() => {
        loadingOlder.current = false
      })
  }, [api, id, timeline])

  const items = timeline?.items ?? []

  if (!h || !timeline) return null
  const { task, usage } = h
  const ctx: ToolContext = { steps: h.steps, events: timeline.events, patches: h.patches, run: (stepId) => timeline.run(stepId) }
  const state = h.turn ?? task.state
  const todos = h.steps.filter((s) => s.kind === "todo")
  const delegations = h.steps.filter((s) => s.kind === "delegation")
  const waitingOn = pendingCalls(items).length + pendingQuestions(items).length
  const gated = new Set(pendingCalls(items).map((c) => String(c.args.patchId ?? "")))
  // A patch no paused turn waits on — the agent never applied it, or the app restarted — is decided by hand.
  const orphans = state === "running" || state === "pending" ? [] : h.patches.filter((p) => p.state === "proposed" && !gated.has(p.id))

  /** Run a call; its failure is shown and returned. */
  const act = async (fn: () => Promise<unknown>): Promise<string | null> => {
    setError("")
    try {
      await fn()
      return null
    } catch (e) {
      const message = (e as Error).message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, "")
      setError(message)
      return message
    }
  }
  const decide = async (callId: string, d: ToolDecision) => {
    const failed = await act(() => api.decideTool(id, callId, d))
    if (failed) throw new Error(failed)
  }
  const answer = async (questionId: string, a: Answer) => {
    const failed = await act(() => api.answerQuestion(id, questionId, a))
    if (failed) throw new Error(failed)
  }

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-6 border-b px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={tone(state)}>{state}</Badge>
              <span className="text-xs text-muted-foreground">{when(task.createdAt)}</span>
              <Mono className="text-muted-foreground">{task.model}</Mono>
            </div>
            <h1 className="mt-1.5 line-clamp-2 text-base font-semibold">{task.request}</h1>
            <Mono className="text-muted-foreground">{task.sourceRoot}</Mono>
          </div>
          <div className="flex shrink-0 gap-2">
            {canClose(state) && (
              <Button size="sm" onClick={() => act(() => api.closeTask(id))}>
                <SquareX size={14} /> Close
              </Button>
            )}
            {isLive(state) && (
              <Button size="sm" variant="destructive" onClick={() => act(() => api.cancelTask(id))}>
                Cancel task
              </Button>
            )}
            {canRetry(state) && (
              <Button size="sm" variant="outline" onClick={() => act(async () => onOpen((await api.retryTask(id)).id))}>
                <RotateCcw size={14} /> Start over
              </Button>
            )}
            {canDelete(state) && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  // Deleting removes the task's history, files and containers for good (specs/task-persistence R4.1).
                  window.confirm("Delete this task with its history, files and containers? This cannot be undone.") &&
                  act(async () => {
                    await api.deleteTask(id)
                    onDeleted()
                  })
                }
              >
                <Trash2 size={14} /> Delete
              </Button>
            )}
          </div>
        </header>

        <VirtualTimeline<ChatBlock>
          entries={entries}
          onNearTop={loadOlder}
          top={!timeline.fromStart && <p className="pb-4 text-center text-xs text-muted-foreground">Loading earlier events…</p>}
          bottom={
            <>
              {orphans.map((p) => (
                <PatchReview key={p.id} patch={p} onDecide={async (d) => void (await act(() => api.decidePatch(id, p.id, d)))} />
              ))}
              {task.error && <ErrorText>{task.error}</ErrorText>}
            </>
          }
          render={(item) => {
            switch (item.kind) {
              case "user":
                return <UserMessage item={item} />
              case "agent":
                return <AgentMessage item={item} />
              case "tools":
                return <ToolRun items={item.items} ctx={ctx} />
              case "tool":
                return <ToolCall item={item} ctx={ctx} />
              case "approval":
                return <ApprovalCard item={item} patches={h.patches} onDecide={decide} />
              case "question":
                return <QuestionCard item={item} onAnswer={(a) => answer(item.id, a)} />
              case "notice":
                return <Notice item={item} />
            }
          }}
        />

        <div className="px-6">
          <ErrorText>{error}</ErrorText>
        </div>
        <Composer
          state={state}
          waitingOn={waitingOn}
          onSend={async (text) => (await act(() => api.sendMessage(id, text))) === null}
          onStop={() => void act(() => api.stopTurn(id))}
          onContinue={() => void act(() => api.continueTurn(id))}
        />
      </section>

      <aside className="flex w-[380px] shrink-0 flex-col border-l bg-card/30">
        <Tabs defaultValue="plan" className="min-h-0 flex-1 p-3">
          <TabsList className="w-full">
            <TabsTrigger value="plan">
              <ListTodo size={13} /> Plan
            </TabsTrigger>
            <TabsTrigger value="delegations">
              <Users size={13} /> Specialist
            </TabsTrigger>
            <TabsTrigger value="usage">
              <Wallet size={13} /> Usage
            </TabsTrigger>
            <TabsTrigger value="log">
              <ScrollText size={13} /> Log
            </TabsTrigger>
          </TabsList>
          <TabsContent value="plan" className="min-h-0">
            <ScrollArea className="h-full">
              <ol className="flex flex-col gap-1.5 text-sm">
                {todos.length === 0 && <li className="text-muted-foreground">No plan yet.</li>}
                {todos.map((s) => (
                  <li key={s.id} className="flex items-start gap-2">
                    <Badge variant={tone(s.state)} className="mt-0.5">
                      {s.state}
                    </Badge>
                    <span>{s.title}</span>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="delegations" className="min-h-0">
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-3">
                {delegations.length === 0 && <p className="text-sm text-muted-foreground">No delegation yet.</p>}
                {delegations.map((s) => (
                  <DelegationCard key={s.id} step={s} events={timeline.events} patches={h.patches} run={timeline.run(s.id)} />
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="usage">
            <div className="mb-2 flex items-baseline justify-between text-sm">
              <span className="font-semibold">Total</span>
              <Mono>{usd(task.costUsd + task.specialistCostUsd)}</Mono>
            </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1.5 text-left font-medium">Agent</th>
                  <th className="px-2 py-1.5 text-right font-medium">In</th>
                  <th className="px-2 py-1.5 text-right font-medium">Out</th>
                  <th className="py-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.agent} className="border-t">
                    <td className="py-1.5">
                      {u.agent} <span className="text-xs text-muted-foreground">×{u.calls}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs">{tokens(u.tokensIn)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs">{tokens(u.tokensOut)}</td>
                    <td className="py-1.5 text-right font-mono text-xs">
                      {usd(u.costUsd)}
                      {u.estimate && <span title="Claude Code's estimate against your plan, not a charge"> est.</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">The specialist's cost is Claude Code's estimate against your plan, not a charge.</p>
          </TabsContent>
          <TabsContent value="log" className="min-h-0">
            <EventLogPanel events={timeline.events} steps={h.steps} />
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  )
}
