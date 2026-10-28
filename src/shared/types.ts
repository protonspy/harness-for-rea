/* The records main and renderer share: tasks, their steps and events, patches, settings and status. */

export const TASK_STATES = ["pending", "running", "waiting", "done", "failed", "cancelled", "interrupted"] as const
export type TaskState = (typeof TASK_STATES)[number]

export type Agent = "orchestrator" | "specialist" | "sandbox" | "app"

export interface TaskRow {
  id: string
  request: string
  sourceRoot: string
  model: string
  state: TaskState
  result: string
  error: string
  createdAt: number
  updatedAt: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** what Claude Code reported as `total_cost_usd`: an estimate against the user's plan, not a charge */
  specialistCostUsd: number
}

export type StepKind = "todo" | "delegation"

export interface StepRow {
  id: string
  taskId: string
  ord: number
  kind: StepKind
  title: string
  agent: Agent
  state: TaskState
  data: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export type FileOp = "copy" | "read" | "write" | "apply"

export interface FileTouch {
  path: string
  op: FileOp
}

/** What an event carries besides its summary. Every field is optional; writers fill what they know. */
export interface EventPayload {
  input?: unknown
  output?: unknown
  tool?: string
  files?: FileTouch[]
  error?: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  cacheTokens?: number
  costUsd?: number
  /** the cost is Claude Code's estimate, not an OpenRouter charge */
  estimate?: boolean
  [key: string]: unknown
}

export interface EventRow {
  id: number
  taskId: string
  stepId: string | null
  agent: Agent
  at: number
  kind: string
  state: TaskState | ""
  summary: string
  payload: EventPayload
  truncated: boolean
}

export type PatchState = "proposed" | "approved" | "rejected" | "applied" | "conflict"

export interface PatchFile {
  path: string
  status: "added" | "modified" | "deleted"
  added: number
  removed: number
}

export interface PatchView {
  id: string
  taskId: string
  stepId: string
  state: PatchState
  files: PatchFile[]
  diff: string
  conflicts: string[]
  createdAt: number
}

export interface TaskHistory {
  task: TaskRow
  steps: StepRow[]
  events: EventRow[]
  patches: PatchView[]
  /** more events exist after the last one returned */
  hasMore: boolean
}

export interface Settings {
  model: string
  timeoutMinutes: number
  memoryMb: number
  cpus: number
  pidsLimit: number
  discardOnCompletion: boolean
}

export interface KeyStatus {
  set: boolean
  hint: string
  encryption: boolean
}

export interface SandboxStatus {
  docker: boolean
  dockerError: string
  images: boolean
  building: boolean
  buildLog: string
  claudeVersion: string
}

export interface LoginStatus {
  loggedIn: boolean
  method: string
  plan?: string
  email?: string
  inProgress: boolean
  /** the Anthropic page the login printed, only while it runs */
  url: string | null
  text: string
  error: string
}

export type Push =
  | { type: "event"; event: EventRow }
  | { type: "step"; step: StepRow }
  | { type: "task"; task: TaskRow }
  | { type: "patch"; patch: PatchView }
  | { type: "sandbox"; status: SandboxStatus }
  | { type: "login"; status: LoginStatus }
