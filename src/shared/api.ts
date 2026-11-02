import { z } from "zod"
import { AnswerSchema, DecisionSchema } from "./chat"
import { PROVIDER_IDS } from "./providers"
import { GOALS, ORCHESTRATOR_EFFORTS, SPECIALIST_EFFORTS } from "./types"
import type {
  AnalysisSummary,
  KeyStatus,
  LoginStatus,
  PatchView,
  ProjectRow,
  Push,
  Readiness,
  SandboxStatus,
  Settings,
  TargetInfo,
  TaskHistory,
  UnknownRow,
  TaskRow,
} from "./types"

/*
  The whole renderer ⇄ main contract. Each method's arguments have a schema here, the main process
  parses them before a handler runs, and the preload builds the bridge from these names only.
*/

const id = z.string().uuid()

const Provider = z.enum(PROVIDER_IDS)

const SettingsPatch = z
  .object({
    provider: Provider,
    // Empty clears it; otherwise an http(s) URL with no credentials in it.
    baseUrl: z
      .string()
      .trim()
      .max(300)
      .refine((v) => {
        if (!v) return true
        try {
          const u = new URL(v)
          return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password
        } catch {
          return false
        }
      }, "Enter a full http(s) URL"),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._\-/:]{3,120}$/),
    timeoutMinutes: z.number().int().min(1).max(240),
    orchestratorEffort: z.enum(ORCHESTRATOR_EFFORTS),
    specialistEffort: z.enum(SPECIALIST_EFFORTS),
    approvalTimeoutMinutes: z.number().int().min(1).max(1440),
    questionTimeoutMinutes: z.number().int().min(1).max(1440),
  })
  .partial()
  .strict()

export const API_SCHEMAS = {
  getSettings: z.tuple([]),
  saveSettings: z.tuple([SettingsPatch]),
  keyStatus: z.tuple([Provider.optional()]),
  saveKey: z.tuple([z.string().trim().min(8).max(512), Provider.optional()]),
  clearKey: z.tuple([Provider.optional()]),
  listModels: z.tuple([]),
  sandboxStatus: z.tuple([]),
  readiness: z.tuple([]),
  completeSetup: z.tuple([]),
  buildSandbox: z.tuple([]),
  loginStatus: z.tuple([]),
  startLogin: z.tuple([]),
  sendLoginCode: z.tuple([z.string().trim().min(8).max(512)]),
  cancelLogin: z.tuple([]),
  openLoginUrl: z.tuple([]),
  logout: z.tuple([]),
  pickFolder: z.tuple([]),
  startTask: z.tuple([
    z
      .object({
        request: z.string().trim().min(1).max(20_000),
        // A task runs in a project (specs/projects R2.1); a bare source folder is the form from before projects.
        projectId: id.optional(),
        sourceRoot: z.string().trim().min(1).max(1000).optional(),
      })
      .strict()
      .refine((t) => t.projectId || t.sourceRoot, "Name a project or a source folder."),
  ]),
  listProjects: z.tuple([]),
  getProject: z.tuple([id]),
  createProject: z.tuple([
    z
      .object({
        name: z.string().trim().min(1).max(80),
        goal: z.enum(GOALS),
        target: z.string().trim().min(1).max(1000),
        provider: Provider,
        model: z.string().trim().min(1).max(200),
        orchestratorEffort: z.enum(ORCHESTRATOR_EFFORTS),
        specialistEffort: z.enum(SPECIALIST_EFFORTS),
        parentFolder: z.string().trim().min(1).max(1000).nullable().optional(),
      })
      .strict(),
  ]),
  deleteProject: z.tuple([id]),
  // The provider, model and efforts a project's tasks run with, changed at any time (specs/projects R1.8).
  updateProject: z.tuple([
    id,
    z
      .object({
        provider: Provider,
        model: z.string().trim().min(1).max(200),
        orchestratorEffort: z.enum(ORCHESTRATOR_EFFORTS),
        specialistEffort: z.enum(SPECIALIST_EFFORTS),
      })
      .partial()
      .strict(),
  ]),
  pickTarget: z.tuple([z.enum(["file", "folder"])]),
  detectTarget: z.tuple([z.string().trim().min(1).max(1000)]),
  listTasks: z.tuple([z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict()]),
  getTask: z.tuple([
    id,
    z
      .object({
        afterEvent: z.number().int().min(0).optional(),
        beforeEvent: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(5000).default(2000),
      })
      .strict()
      .refine((o) => o.afterEvent === undefined || o.beforeEvent === undefined, "Give afterEvent or beforeEvent, not both."),
  ]),
  cancelTask: z.tuple([id]),
  retryTask: z.tuple([id]),
  decidePatch: z.tuple([id, id, z.enum(["approve", "reject"])]),
  sendMessage: z.tuple([id, z.string().trim().min(1).max(20_000)]),
  stopTurn: z.tuple([id]),
  continueTurn: z.tuple([id]),
  closeTask: z.tuple([id]),
  deleteTask: z.tuple([id]),
  // One task's model, from its next turn (specs/projects R2.6).
  setTaskModel: z.tuple([id, z.string().trim().min(1).max(200)]),
  decideTool: z.tuple([id, id, DecisionSchema]),
  answerQuestion: z.tuple([id, id, AnswerSchema]),
} as const

export type ApiMethod = keyof typeof API_SCHEMAS
export const API_METHODS = Object.keys(API_SCHEMAS) as ApiMethod[]

export interface ApiResults {
  getSettings: Settings
  saveSettings: Settings
  keyStatus: KeyStatus
  saveKey: KeyStatus
  clearKey: KeyStatus
  listModels: string[]
  sandboxStatus: SandboxStatus
  readiness: Readiness
  completeSetup: Readiness
  buildSandbox: SandboxStatus
  loginStatus: LoginStatus
  startLogin: LoginStatus
  sendLoginCode: LoginStatus
  cancelLogin: LoginStatus
  openLoginUrl: boolean
  logout: LoginStatus
  pickFolder: string | null
  startTask: TaskRow
  listProjects: ProjectRow[]
  getProject: { project: ProjectRow; tasks: TaskRow[]; analyses: AnalysisSummary[]; unknowns: UnknownRow[] }
  createProject: ProjectRow
  deleteProject: boolean
  updateProject: ProjectRow
  pickTarget: string | null
  detectTarget: TargetInfo
  listTasks: TaskRow[]
  getTask: TaskHistory
  cancelTask: TaskRow
  retryTask: TaskRow
  decidePatch: PatchView
  sendMessage: TaskRow
  stopTurn: TaskRow
  continueTurn: TaskRow
  closeTask: TaskRow
  deleteTask: boolean
  setTaskModel: TaskRow
  decideTool: TaskRow
  answerQuestion: TaskRow
}

/** What the renderer passes: the schema's input, so defaulted fields may be left out. */
export type ApiArgs<M extends ApiMethod> = z.input<(typeof API_SCHEMAS)[M]>
/** What a handler receives: the parsed arguments, defaults filled. */
export type ApiParsed<M extends ApiMethod> = z.output<(typeof API_SCHEMAS)[M]>

export type Api = { [M in ApiMethod]: (...args: ApiArgs<M>) => Promise<ApiResults[M]> }
export type Handlers = { [M in ApiMethod]: (...args: ApiParsed<M>) => Promise<ApiResults[M]> | ApiResults[M] }

export interface Bridge {
  api: Api
  onPush(fn: (p: Push) => void): () => void
}
