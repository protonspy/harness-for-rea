import { z } from "zod"
import { AnswerSchema, DecisionSchema } from "./chat"
import { IntegrationIdSchema, IntegrationSettingsSchema, type IntegrationActionResult, type IntegrationStatus, type IntegrationView } from "./integrations"
import { MODEL_PROTOCOLS, PROVIDER_IDS, SPECIALIST_PROVIDERS } from "./providers"
import { GOALS, ORCHESTRATOR_EFFORTS, SPECIALIST_EFFORTS } from "./types"
import type {
  AnalysisSummary,
  ChatGPTAuthStatus,
  ChatGPTModelOption,
  KeyStatus,
  HopperSignIn,
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
const Protocol = z.enum(MODEL_PROTOCOLS)

/** A model's name as a provider lists it: no control characters, which a hostile endpoint's list could carry. */
const ModelName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, "A model name has no control characters.")

const SettingsPatch = z
  .object({
    expectedProvider: Provider.optional(),
    expectedSpecialistProvider: z.enum(SPECIALIST_PROVIDERS).optional(),
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
    model: z.union([
      z.literal(""),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._\-/:]{3,120}$/),
    ]),
    timeoutMinutes: z.number().int().min(1).max(240),
    orchestratorEffort: z.enum(ORCHESTRATOR_EFFORTS),
    specialistEffort: z.enum(SPECIALIST_EFFORTS),
    specialistProvider: z.enum(SPECIALIST_PROVIDERS),
    // Empty until one is chosen; the readiness check asks for it (specs/specialist-providers R1.3).
    specialistModel: z.union([z.literal(""), ModelName]),
    orchestratorProtocol: Protocol,
    specialistProtocol: Protocol,
    orchestratorProtocols: z.record(Provider, Protocol.optional()),
    specialistProtocols: z.record(Provider, Protocol.optional()),
    protocols: z.record(Provider, Protocol.optional()),
    approvalTimeoutMinutes: z.number().int().min(1).max(1440),
    questionTimeoutMinutes: z.number().int().min(1).max(1440),
    // Each integration's whole settings; the main process holds them to the integration the app carries (specs/mcp-integrations R1.5).
    integrations: z.record(IntegrationIdSchema, IntegrationSettingsSchema),
  })
  .partial()
  .strict()

export const API_SCHEMAS = {
  getSettings: z.tuple([]),
  saveSettings: z.tuple([SettingsPatch]),
  keyStatus: z.tuple([Provider.optional()]),
  saveKey: z.tuple([z.string().trim().min(8).max(512), Provider.optional()]),
  clearKey: z.tuple([Provider.optional()]),
  listModels: z.tuple([Provider.optional()]),
  listChatGPTModels: z.tuple([]),
  sandboxStatus: z.tuple([]),
  readiness: z.tuple([]),
  completeSetup: z.tuple([]),
  buildSandbox: z.tuple([]),
  loginStatus: z.tuple([]),
  startLogin: z.tuple([]),
  sendLoginCode: z.tuple([z.string().trim().min(8).max(512)]),
  cancelLogin: z.tuple([]),
  openLoginUrl: z.tuple([]),
  // Only the address the provider's preset names is opened (specs/specialist-providers R1.5).
  openProviderSignup: z.tuple([Provider]),
  logout: z.tuple([]),
  // The email Hopper's registration is sent with, the account the user signs in or up with (specs/specialist-providers R3.1).
  startHopperSignIn: z.tuple([z.string().trim().email().max(254)]),
  hopperSignInStatus: z.tuple([]),
  cancelHopperSignIn: z.tuple([]),
  startChatGPTAuth: z.tuple([]),
  chatGPTAuthStatus: z.tuple([]),
  cancelChatGPTAuth: z.tuple([]),
  chatGPTLogout: z.tuple([]),
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
        orchestratorProtocol: Protocol.optional(),
        specialistProtocol: Protocol.optional(),
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
        model: ModelName,
        orchestratorEffort: z.enum(ORCHESTRATOR_EFFORTS),
        specialistEffort: z.enum(SPECIALIST_EFFORTS),
        orchestratorProtocol: Protocol,
        specialistProtocol: Protocol,
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
  setTaskModel: z.tuple([id, ModelName]),
  decideTool: z.tuple([id, id, DecisionSchema]),
  answerQuestion: z.tuple([id, id, AnswerSchema]),
  // The MCP integrations the app carries, each with its catalog; one's checks and connection; one of its actions (specs/mcp-integrations R1).
  integrations: z.tuple([]),
  integrationStatus: z.tuple([IntegrationIdSchema]),
  runIntegrationAction: z.tuple([IntegrationIdSchema, z.string().regex(/^[a-z][a-z0-9-]{0,40}$/)]),
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
  listChatGPTModels: ChatGPTModelOption[]
  sandboxStatus: SandboxStatus
  readiness: Readiness
  completeSetup: Readiness
  buildSandbox: SandboxStatus
  loginStatus: LoginStatus
  startLogin: LoginStatus
  sendLoginCode: LoginStatus
  cancelLogin: LoginStatus
  openLoginUrl: boolean
  openProviderSignup: boolean
  logout: LoginStatus
  startHopperSignIn: HopperSignIn
  hopperSignInStatus: HopperSignIn
  cancelHopperSignIn: HopperSignIn
  startChatGPTAuth: ChatGPTAuthStatus
  chatGPTAuthStatus: ChatGPTAuthStatus
  cancelChatGPTAuth: ChatGPTAuthStatus
  chatGPTLogout: ChatGPTAuthStatus
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
  integrations: IntegrationView[]
  integrationStatus: IntegrationStatus
  runIntegrationAction: IntegrationActionResult
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
