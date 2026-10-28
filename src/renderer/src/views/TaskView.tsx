import { CircleStop, RotateCcw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import Prose from "@/components/Prose"
import type { TaskHistory } from "@shared/types"
import { DelegationCard } from "@/components/DelegationCard"
import { EventLogPanel } from "@/components/EventLog"
import { PatchReview } from "@/components/PatchReview"
import { Badge, Button, Card, CardHeader, ErrorText, Mono } from "@/components/ui"
import { tokens, tone, usd, when } from "@/lib/format"
import { canRetry, fold, isLive, usageByAgent } from "@/lib/store"

/* One task, live: plan, delegations, patches waiting on the user, usage, the event log and the answer (specs/desktop-ui R2, R3.1). */

export function TaskView({ id, onOpen }: { id: string; onOpen(id: string): void }) {
  const [h, setH] = useState<TaskHistory | null>(null)
  const [error, setError] = useState("")
  const api = window.hfr.api

  useEffect(() => {
    let alive = true
    const queued: Parameters<Parameters<typeof window.hfr.onPush>[0]>[0][] = []
    let loaded = false
    const off = window.hfr.onPush((p) => (loaded ? setH((cur) => fold(cur, p)) : queued.push(p)))
    const load = async () => {
      let hist = await api.getTask(id, {})
      while (hist.hasMore) {
        const more = await api.getTask(id, { afterEvent: hist.events.at(-1)!.id })
        hist = { ...more, events: [...hist.events, ...more.events] }
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

  const usage = useMemo(() => usageByAgent(h?.events ?? []), [h?.events])
  if (!h) return null
  const { task } = h
  const todos = h.steps.filter((s) => s.kind === "todo")
  const delegations = h.steps.filter((s) => s.kind === "delegation")
  const waiting = h.patches.filter((p) => p.state === "proposed")

  const act = async (fn: () => Promise<unknown>) => {
    setError("")
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, ""))
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={tone(task.state)}>{task.state}</Badge>
            <span className="text-xs text-muted">{when(task.createdAt)}</span>
            <Mono className="text-muted">{task.model}</Mono>
          </div>
          <h1 className="mt-2 text-lg font-semibold whitespace-pre-wrap">{task.request}</h1>
          <Mono className="text-muted">{task.sourceRoot}</Mono>
        </div>
        <div className="flex shrink-0 gap-2">
          {isLive(task.state) && (
            <Button variant="bad" onClick={() => act(() => api.cancelTask(id))}>
              <CircleStop size={14} /> Cancel
            </Button>
          )}
          {canRetry(task.state) && (
            <Button onClick={() => act(async () => onOpen((await api.retryTask(id)).id))}>
              <RotateCcw size={14} /> Retry
            </Button>
          )}
        </div>
      </header>
      <ErrorText>{error || task.error}</ErrorText>

      {waiting.map((p) => (
        <PatchReview key={p.id} patch={p} onDecide={(d) => act(() => api.decidePatch(id, p.id, d))} />
      ))}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {task.result && (
            <Card>
              <CardHeader title="Consolidated answer" />
              <Prose text={task.result} className="p-4" />
            </Card>
          )}
          {delegations.map((s) => (
            <DelegationCard key={s.id} step={s} events={h.events} patches={h.patches} />
          ))}
          <EventLogPanel events={h.events} steps={h.steps} />
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Plan" />
            <ol className="flex flex-col gap-1.5 p-4 text-sm">
              {todos.length === 0 && <li className="text-muted">No plan yet.</li>}
              {todos.map((s) => (
                <li key={s.id} className="flex items-start gap-2">
                  <Badge tone={tone(s.state)} className="mt-0.5 shrink-0">
                    {s.state}
                  </Badge>
                  <span>{s.title}</span>
                </li>
              ))}
            </ol>
          </Card>
          <Card>
            <CardHeader title="Usage" actions={<Mono>{usd(task.costUsd + task.specialistCostUsd)}</Mono>} />
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Agent</th>
                  <th className="px-2 py-2 text-right font-medium">In</th>
                  <th className="px-2 py-2 text-right font-medium">Out</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.agent} className="border-t border-line">
                    <td className="px-4 py-2">
                      {u.agent} <span className="text-xs text-muted">×{u.calls}</span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{tokens(u.tokensIn)}</td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{tokens(u.tokensOut)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {usd(u.costUsd)}
                      {u.estimate && <span title="Claude Code's estimate against your plan, not a charge"> est.</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 pb-3 text-xs text-muted">The specialist's cost is Claude Code's estimate against your plan, not a charge.</p>
          </Card>
        </div>
      </div>
    </div>
  )
}
