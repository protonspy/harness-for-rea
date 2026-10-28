import { z } from "zod"
import type { KeyStatus, LoginStatus, PatchView, Push, SandboxStatus, Settings, TaskHistory, TaskRow } from "./types"

/*
  The whole renderer ⇄ main contract. Each method's arguments have a schema here, the main process
  parses them before a handler runs, and the preload builds the bridge from these names only.
*/

const id = z.string().uuid()

const SettingsPatch = z
  .object({
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._\-/:]{3,120}$/),
    timeoutMinutes: z.number().int().min(1).max(240),
    memoryMb: z.number().int().min(256).max(65_536),
    cpus: z.number().min(0.5).max(64),
    pidsLimit: z.number().int().min(32).max(32_768),
    discardOnCompletion: z.boolean(),
  })
  .partial()
  .strict()

export const API_SCHEMAS = {
  getSettings: z.tuple([]),
  saveSettings: z.tuple([SettingsPatch]),
  keyStatus: z.tuple([]),
  saveKey: z.tuple([z.string().trim().min(8).max(512)]),
  clearKey: z.tuple([]),
  sandboxStatus: z.tuple([]),
  buildSandbox: z.tuple([]),
  loginStatus: z.tuple([]),
  startLogin: z.tuple([]),
  sendLoginCode: z.tuple([z.string().trim().min(8).max(512)]),
  cancelLogin: z.tuple([]),
  openLoginUrl: z.tuple([]),
  logout: z.tuple([]),
  pickFolder: z.tuple([]),
  startTask: z.tuple([z.object({ request: z.string().trim().min(1).max(20_000), sourceRoot: z.string().trim().min(1).max(1000) }).strict()]),
  listTasks: z.tuple([z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict()]),
  getTask: z.tuple([id, z.object({ afterEvent: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(5000).default(2000) }).strict()]),
  cancelTask: z.tuple([id]),
  retryTask: z.tuple([id]),
  decidePatch: z.tuple([id, id, z.enum(["approve", "reject"])]),
} as const

export type ApiMethod = keyof typeof API_SCHEMAS
export const API_METHODS = Object.keys(API_SCHEMAS) as ApiMethod[]

export interface ApiResults {
  getSettings: Settings
  saveSettings: Settings
  keyStatus: KeyStatus
  saveKey: KeyStatus
  clearKey: KeyStatus
  sandboxStatus: SandboxStatus
  buildSandbox: SandboxStatus
  loginStatus: LoginStatus
  startLogin: LoginStatus
  sendLoginCode: LoginStatus
  cancelLogin: LoginStatus
  openLoginUrl: boolean
  logout: LoginStatus
  pickFolder: string | null
  startTask: TaskRow
  listTasks: TaskRow[]
  getTask: TaskHistory
  cancelTask: TaskRow
  retryTask: TaskRow
  decidePatch: PatchView
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
