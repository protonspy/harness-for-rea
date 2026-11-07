import type { AgentUsage, EventRow, PatchView, Push, StepRow, TaskHistory, TaskRow, TaskState } from "@shared/types"

/*
  The renderer's state, folded from pushed messages: the loaded task's history and the task list.
  Live updates and history go through the same reducer, so what renders live is what renders later.
*/

function upsert<T extends { id: string | number }>(list: T[], item: T, order: (a: T, b: T) => number): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  const next = i >= 0 ? list.map((x, k) => (k === i ? item : x)) : [...list, item]
  return next.sort(order)
}

/** One pushed message into the open task's history; messages for other tasks leave it unchanged. */
export function fold(h: TaskHistory | null, p: Push): TaskHistory | null {
  if (!h) return h
  switch (p.type) {
    case "task":
      // The stored state follows every change from here on; the turn read at load no longer speaks for it.
      return p.task.id === h.task.id ? { ...h, task: p.task, turn: undefined } : h
    case "step":
      return p.step.taskId === h.task.id ? { ...h, steps: upsert<StepRow>(h.steps, p.step, (a, b) => a.ord - b.ord) } : h
    case "event": {
      if (p.event.taskId !== h.task.id) return h
      const last = h.events.at(-1)?.id ?? 0
      return p.event.id > last ? { ...h, events: [...h.events, p.event] } : h
    }
    case "patch":
      return p.patch.taskId === h.task.id ? { ...h, patches: upsert<PatchView>(h.patches, p.patch, (a, b) => a.createdAt - b.createdAt) } : h
    default:
      return h
  }
}

/** The task list, newest first, with a pushed task added or replaced. */
export function foldTasks(list: TaskRow[], p: Push): TaskRow[] {
  if (p.type === "taskDeleted") return list.filter((t) => t.id !== p.id)
  if (p.type !== "task") return list
  return upsert(list, p.task, (a, b) => b.createdAt - a.createdAt)
}

/** One event's tokens and cost added to the per-agent usage, when it is a model call or a specialist's result. */
export function addUsage(usage: AgentUsage[], e: EventRow): AgentUsage[] {
  if (e.kind !== "model.call" && e.kind !== "specialist.result") return usage
  const cur = usage.find((u) => u.agent === e.agent) ?? {
    agent: e.agent,
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheTokens: 0,
    costUsd: 0,
    estimate: false,
    reportedCostUsd: 0,
    estimatedCostUsd: 0,
    hasUnknownCost: false,
  }

  const isEstimated = e.payload.costStatus === "estimated" || e.payload.estimate === true
  const isUnknown = e.payload.costStatus === "unknown" || (e.payload.costUsd === undefined && !isEstimated)
  const isReported = e.payload.costStatus === "reported" || (!isEstimated && !isUnknown && typeof e.payload.costUsd === "number")

  const callCost = typeof e.payload.costUsd === "number" ? e.payload.costUsd : 0
  const cacheIn = typeof e.payload.cacheTokens === "number" ? e.payload.cacheTokens : 0

  // prompt_tokens includes cache; do not add cacheTokens again if promptTokensIncludesCache or model.call
  const totalIn = e.payload.promptTokensIncludesCache || e.kind === "model.call" ? (e.payload.tokensIn ?? 0) : (e.payload.tokensIn ?? 0) + cacheIn

  const next: AgentUsage = {
    ...cur,
    calls: cur.calls + 1,
    tokensIn: cur.tokensIn + totalIn,
    tokensOut: cur.tokensOut + (e.payload.tokensOut ?? 0),
    cacheTokens: (cur.cacheTokens ?? 0) + cacheIn,
    costUsd: cur.costUsd + callCost,
    estimate: cur.estimate || isEstimated,
    costStatus: isUnknown && cur.calls === 0 ? "unknown" : isEstimated ? "estimated" : "reported",
    reportedCostUsd: (cur.reportedCostUsd ?? 0) + (isReported ? callCost : 0),
    estimatedCostUsd: (cur.estimatedCostUsd ?? 0) + (isEstimated ? callCost : 0),
    hasUnknownCost: cur.hasUnknownCost || isUnknown,
  }
  return usage.some((u) => u.agent === e.agent) ? usage.map((u) => (u.agent === e.agent ? next : u)) : [...usage, next]
}

/** Tokens and cost per agent, from the orchestrator's model calls and the specialist's results. */
export function usageByAgent(events: EventRow[]): AgentUsage[] {
  return events.reduce(addUsage, [] as AgentUsage[])
}

export interface FilesTouched {
  copy: string[]
  read: string[]
  write: string[]
  apply: string[]
}

/** Every file a delegation copied in, the specialist read or wrote, and a patch applied. */
export function filesOfStep(events: EventRow[], stepId: string): FilesTouched {
  const out: Record<keyof FilesTouched, Set<string>> = { copy: new Set(), read: new Set(), write: new Set(), apply: new Set() }
  for (const e of events) if (e.stepId === stepId) for (const f of e.payload.files ?? []) out[f.op]?.add(f.path)
  return { copy: [...out.copy], read: [...out.read], write: [...out.write], apply: [...out.apply] }
}

export const LIVE_STATES: TaskState[] = ["pending", "running", "waiting"]
export const RETRY_STATES: TaskState[] = ["interrupted", "failed", "cancelled"]

export function isLive(state: TaskState): boolean {
  return LIVE_STATES.includes(state)
}

export function canRetry(state: TaskState): boolean {
  return RETRY_STATES.includes(state)
}
