import type { IntegrationSettings } from "./integrations"
/* The records main and renderer share: tasks, their steps and events, patches, settings and status. */

import type { ModelProtocol, ProviderId, SpecialistProvider } from "./providers"
import type { CacheHypothesis, CostStatus, ModelRateSnapshot } from "./pricing"

/**
  `awaiting-user`: a turn ended and the conversation waits for the user's next message; `stopped`: the user stopped a turn
  (specs/chat R1.4, R3.1); `refused`: a delegation step the specialist declined under its usage policy (specs/specialist-lifecycle R2.1).
*/
export const TASK_STATES = ["pending", "running", "waiting", "awaiting-user", "stopped", "done", "failed", "cancelled", "interrupted", "refused"] as const
export type TaskState = (typeof TASK_STATES)[number]

export type Agent = "orchestrator" | "specialist" | "sandbox" | "app"

export interface TaskRow {
  id: string
  /** the project the task belongs to (specs/projects) */
  projectId: string | null
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
  cacheTokens?: number
  costUsd: number
  /** what Claude Code reported as `total_cost_usd`: an estimate against the user's plan, not a charge */
  specialistCostUsd: number
}

/** What the user means to do with a project's target (specs/projects R1.5). */
export const GOALS = ["understand", "reimplement", "integrate", "debug"] as const
export type Goal = (typeof GOALS)[number]

/** What a target is, as its extension and first bytes tell (specs/projects R1.4). */
export const TARGET_KINDS = ["android", "elf", "pe", "macho", "dotnet", "electron", "javascript", "archive", "firmware", "folder", "file"] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

export interface TargetInfo {
  path: string
  kind: TargetKind
  /** a file, copied into the project, or a folder read in place */
  isFile: boolean
  size: number
  /** a short name for the kind, for the user */
  label: string
  /** what the specialist works on it with */
  engines: string[]
}

/** One item of a project's unknowns ledger (specs/analysis-contract R2). */
export interface UnknownRow {
  id: string
  projectId: string
  question: string
  severity: "low" | "medium" | "high"
  /** what was tried */
  probes: string[]
  /** what would settle it */
  settle: string
  /** the analysis (delegation step) that raised it */
  raisedBy: string
  /** the analysis that closed it, or null while it is open */
  closedBy: string | null
  resolution: string
  createdAt: number
  updatedAt: number
}

export interface ProjectRow {
  id: string
  name: string
  goal: Goal
  targetPath: string
  targetKind: TargetKind
  /** what the project's tasks mount read-only: the target folder, or the folder its file was copied into */
  sourceRoot: string
  folder: string
  /** the app created `folder` and may remove it whole */
  ownsFolder: boolean
  provider: ProviderId
  model: string
  orchestratorEffort: OrchestratorEffort
  specialistEffort: SpecialistEffort
  orchestratorProtocol?: ModelProtocol
  specialistProtocol?: ModelProtocol
  createdAt: number
  updatedAt: number
  /** the other app running a task of this project, which holds it until its tasks close (specs/shared-data-folder R1.3) */
  heldBy?: { app: "desktop" | "tui"; pid: number } | null
}

/** An earlier delegation of a project's task, as the project view lists it (specs/projects R4.3). */
export interface AnalysisSummary {
  id: string
  taskId: string
  state: TaskState
  objective: string
  evidence: number
  createdAt: number
}

export type StepKind = "todo" | "delegation" | "patch"

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
  costStatus?: CostStatus
  rateSnapshot?: ModelRateSnapshot
  cacheHypothesis?: CacheHypothesis
  promptTokensIncludesCache?: boolean
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

export interface AgentUsage {
  agent: Agent | string
  calls: number
  tokensIn: number
  tokensOut: number
  cacheTokens?: number
  costUsd: number
  /** the cost is Claude Code's estimate against the plan, not a charge */
  estimate: boolean
  costStatus?: CostStatus
  reportedCostUsd?: number
  estimatedCostUsd?: number
  hasUnknownCost?: boolean
}

export interface TaskHistory {
  task: TaskRow
  steps: StepRow[]
  events: EventRow[]
  patches: PatchView[]
  /** more events exist after the last one returned */
  hasMore: boolean
  /** more events exist before the first one returned (specs/chat-timeline R2.1) */
  hasOlder: boolean
  /** each agent's usage over the whole task, not only the page (specs/chat-timeline R3.3) */
  usage: AgentUsage[]
  /** where the conversation stands, from the live run's checkpoint; absent when the task has no run in this process */
  turn?: TaskState
}

export interface Settings {
  /** which service the orchestrator's model runs on (adr:0014-add-openai-compatible-orchestrator-providers) */
  provider: ProviderId
  /** the chosen provider's OpenAI-compatible endpoint, used by the providers whose URL can be edited; ignored by OpenRouter */
  baseUrl: string
  /** each provider's own endpoint, so switching provider loses none (specs/orchestrator R1.10); only main writes it */
  baseUrls: Partial<Record<ProviderId, string>>
  model: string
  timeoutMinutes: number
  /** `reasoning.effort` for the orchestrator (OpenRouter's, or `reasoning_effort` on other providers); "default" sends none */
  orchestratorEffort: OrchestratorEffort
  /** Claude Code's `--effort` for the specialist; "default" passes none */
  specialistEffort: SpecialistEffort
  /** the Claude plan, or the orchestrator's provider the specialist runs on (adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent) */
  specialistProvider: SpecialistProvider
  /** the specialist's model on that provider; ignored on the Claude plan */
  specialistModel: string
  /** how long a gated tool call waits for a decision before it is rejected (specs/chat R4.5) */
  approvalTimeoutMinutes: number
  /** how long a question waits for an answer before its default is used (specs/chat R5.4) */
  questionTimeoutMinutes: number
  /** the user finished the first-run setup once (specs/onboarding R1.8) */
  setupCompleted: boolean
  /** each MCP integration the user touched, by id; one left out is off, at its defaults (specs/mcp-integrations R1.1) */
  integrations: Record<string, IntegrationSettings>
  orchestratorProtocol?: ModelProtocol
  specialistProtocol?: ModelProtocol
  orchestratorProtocols?: Partial<Record<ProviderId, ModelProtocol>>
  specialistProtocols?: Partial<Record<ProviderId, ModelProtocol>>
  protocols?: Partial<Record<ProviderId, ModelProtocol>>
}

export const ORCHESTRATOR_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type OrchestratorEffort = (typeof ORCHESTRATOR_EFFORTS)[number]
export const SPECIALIST_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type SpecialistEffort = (typeof SPECIALIST_EFFORTS)[number]

export type ProbeStatus = "ready" | "invalid_key" | "forbidden" | "quota_exceeded" | "model_not_found" | "rate_limited" | "truncated" | "unverified" | "error"

export interface ProbeResult {
  ok: boolean
  status: ProbeStatus
  reason: string
  hasReasoning?: boolean
  hasToolCalls?: boolean
  truncated?: boolean
  tokensOut?: number
  latencyMs?: number
}

export interface KeyStatus {
  set: boolean
  hint: string
  encryption: boolean
}

/** One step of the first-run setup: whether it is ready, and why not (specs/onboarding R1). */
export interface ReadinessStep {
  ready: boolean
  /** what is missing and what readies it; empty once ready */
  reason: string
}

export interface Readiness {
  sandbox: ReadinessStep & { building: boolean }
  /** the specialist: Claude Code's sign-in on the plan, or its provider's key, endpoint and model (specs/specialist-providers R1.3) */
  claude: ReadinessStep & { plan?: string; email?: string; provider?: ProviderId; model?: string }
  model: ReadinessStep & { provider: ProviderId; model: string }
  /** all three steps are ready */
  ready: boolean
  /** the user finished the setup once */
  completed: boolean
}

export interface SandboxStatus {
  docker: boolean
  dockerError: string
  images: boolean
  building: boolean
  buildLog: string
  claudeVersion: string
}

/** Signing in to Hopper through its agent registration (specs/specialist-providers R3). */
export interface HopperSignIn {
  /** waiting on the user to confirm the code on Hopper's page */
  inProgress: boolean
  /** the key came and is in the OS keychain */
  done: boolean
  /** the six-digit code the user confirms on Hopper's page */
  code: string
  /** Hopper's page, always on withhopper.com */
  url: string
  error: string
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
  | { type: "taskDeleted"; id: string }
  | { type: "project"; project: ProjectRow }
  | { type: "projectDeleted"; id: string }
  | { type: "patch"; patch: PatchView }
  | { type: "sandbox"; status: SandboxStatus }
  | { type: "login"; status: LoginStatus }

export interface ChatGPTAuthStatus {
  connected: boolean
  inProgress?: boolean
  accountEmail?: string
  planType?: string
  expiresAt?: number
  hasTokenSharingScope: boolean
  error?: string
  warning?: string
}

export interface ChatGPTModelOption {
  slug: string
  displayName: string
}
