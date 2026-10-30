import { ListTodo, RotateCcw, ScrollText, SquareX, Users, Wallet } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { Answer, ToolDecision } from "@shared/chat"
import type { Push, TaskHistory } from "@shared/types"
import { ApprovalCard } from "@/components/chat/ApprovalCard"
import { Composer } from "@/components/chat/Composer"
import { AgentMessage, Notice, ToolCall, ToolRun, UserMessage } from "@/components/chat/Messages"
import { QuestionCard } from "@/components/chat/QuestionCard"
import { ErrorText, Mono } from "@/components/common"
import { DelegationCard } from "@/components/DelegationCard"
import { EventLogPanel } from "@/components/EventLog"
import { PatchReview } from "@/components/PatchReview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { blocks, canClose, conversation, pendingCalls, pendingQuestions } from "@/lib/chat"
import { tokens, tone, usd, when } from "@/lib/format"
import { canRetry, fold, isLive, usageByAgent } from "@/lib/store"

/*
  One task as a conversation (specs/chat R7): the messages, tool calls, approvals and questions in
  order, the message box under them, and beside them the plan, delegations, usage and event log.
*/

export function TaskView({ id, onOpen }: { id: string; onOpen(id: string): void }) {
  const [h, setH] = useState<TaskHistory | null>(null)
  const [error, setError] = useState("")
  const api = window.hfr.api
  const viewport = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const queued: Push[] = []
    let loaded = false
    const off = window.hfr.onPush((p) => (loaded ? setH((cur) => fold(cur, p)) : queued.push(p)))
    const load = async () => {
      let hist = await api.getTask(id, {})
      while (hist.hasMore) {
        const more = await api.getTask(id, { afterEvent: hist.events.at(-1)!.id })
        hist = { ...more, turn: hist.turn, events: [...hist.events, ...more.events] }
      }
      if (!alive) return
      loaded = true
      setH(queued.reduce((cur, p) => fold(cur, p), hist as TaskHistory | null))
    }
    void load()
    return () => {
      alive = false
      off()
    }
  }, [api, id])

  const items = useMemo(() => conversation(h?.events ?? [], h?.steps ?? []), [h?.events, h?.steps])
  const usage = useMemo(() => usageByAgent(h?.events ?? []), [h?.events])

  // Follow the conversation while the user is at its end; leave them where they are when they scrolled up.
  useEffect(() => {
    const el = viewport.current
    if (items.length && el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [items.length])

  if (!h) return null
  const { task } = h
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
              <Button size="sm" onClick={() => act(async () => onOpen((await api.retryTask(id)).id))}>
                <RotateCcw size={14} /> Retry
              </Button>
            )}
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1" viewportRef={viewport}>
          <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
            {blocks(items).map((item) => {
              switch (item.kind) {
                case "user":
                  return <UserMessage key={item.id} item={item} />
                case "agent":
                  return <AgentMessage key={item.id} item={item} />
                case "tools":
                  return <ToolRun key={item.id} items={item.items} steps={h.steps} events={h.events} patches={h.patches} />
                case "tool":
                  return <ToolCall key={item.id} item={item} steps={h.steps} events={h.events} patches={h.patches} />
                case "approval":
                  return <ApprovalCard key={item.id} item={item} patches={h.patches} onDecide={decide} />
                case "question":
                  return <QuestionCard key={item.id} item={item} onAnswer={(a) => answer(item.id, a)} />
                case "notice":
                  return <Notice key={item.id} item={item} />
              }
            })}
            {orphans.map((p) => (
              <PatchReview key={p.id} patch={p} onDecide={async (d) => void (await act(() => api.decidePatch(id, p.id, d)))} />
            ))}
            {task.error && <ErrorText>{task.error}</ErrorText>}
          </div>
        </ScrollArea>

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
                  <DelegationCard key={s.id} step={s} events={h.events} patches={h.patches} />
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
            <EventLogPanel events={h.events} steps={h.steps} />
          </TabsContent>
        </Tabs>
      </aside>
    </div>
  )
}
