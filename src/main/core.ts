import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Handlers } from "@shared/api"
import { BRIDGE_FILE } from "@shared/cheatengine"
import { integrationSettings } from "@shared/integrations"
import { PROVIDERS, validateReasoningEffort, type ProviderId } from "@shared/providers"
import type { ChatGPTModelOption, ProjectRow, Push } from "@shared/types"
import { cheatEngine } from "./cheatengine/integration"
import { idaPro } from "./idapro/integration"
import { clearKey, initKey, keyStatus, moveKeys, onKey, readKey, refreshKeyAvailability, saveKey, useKeyStore, type KeyStore } from "./credentials"
import { closeDb, exclusive, getDb, getSetting, openDb, setSetting } from "./db"
import { hopperPage, HopperSignInService } from "./hopper"
import { ChatGPTAuthService, createHostId, isValidHostId, type ChatGPTSession } from "./chatgpt"
import { setChatGPTAuthService } from "./orchestrator/model"
import { approvePatch, dockerLauncher, rejectPatch } from "./delegation"
import { EventLog, eventRow, patchRow, stepRow } from "./events/log"
import { registerSecret } from "./events/redact"
import { IntegrationGate } from "./integrations/gate"
import { IntegrationRegistry } from "./integrations/registry"
import { integrationStatus, saveIntegrations } from "./integrations/settings"
import { APP_LABEL, LockHeld, Locks, projectLockName, type AppName, type Holder } from "./lock"
import { ProcessRegistry } from "./processes"
import { listChatGPTModels, listModels, probeModel } from "./orchestrator/models"
import { TaskRunner } from "./orchestrator/runner"
import { deleteProject, ProjectStore } from "./projects"
import { baseUrlFor, blocking, clearProbeCache, protocolFor, readiness } from "./readiness"
import { authArgs, dockerExec, preflight, removeLegacy } from "./sandbox/docker"
import { SandboxRegistry, SpecialistBoxes } from "./sandbox/specialistbox"
import { dockerExecBuffer, SCRATCH, TaskBox, WORKSPACE } from "./sandbox/taskbox"
import { getSettings, saveSettings } from "./settings"
import { isAnthropicUrl, spawnStart } from "./specialist/account"
import { authId, LoginService, SandboxService } from "./status"
import { detectTarget } from "./target"
import { UnknownsLedger } from "./unknowns"
import { ChangeWatcher } from "./watch"

/*
  The core both apps run (plans/finish-the-harness 1.8, adr:0022-run-the-tui-on-bun-with-opentui): the database,
  the event log, the projects, the sandboxes, the task runner and the services behind them, wired into the
  handlers of the API. What only a host can do — keep keys, carry pushes to its view, open a dialog or a browser —
  comes in through `CoreHost`.
*/

/** What the app the core runs in provides. */
export interface CoreHost {
  /** which app this is, named to another app when it holds a project (specs/shared-data-folder R1.2) */
  app: AppName
  /** the app's version, recorded with its process and with each migration it runs (R3.3) */
  version: string
  /** the app's data folder: the database, the projects and their tasks */
  dataDir: string
  /** where the specialist's image sources are: `sandbox/` in the repository or the packaged resources */
  sandboxDir: string
  /** carries a change to the view */
  push(p: Push): void
  keys: KeyStore
  /** where this host kept keys before the shared store, moved into it at start (R5.2) */
  formerKeys?: KeyStore
  /** a folder the user picks; a host without a picker leaves it out and the handler answers null */
  pickFolder?(): Promise<string | null>
  /** a file or folder the user picks as a project's target */
  pickTarget?(kind: "file" | "folder"): Promise<string | null>
  /** opens a URL in the user's browser */
  openExternal?(url: string): Promise<void>
}

export interface Core {
  handlers: Handlers
  runner: TaskRunner
  log: EventLog
  /** removes every task container, then closes the database */
  shutdown(): Promise<void>
}

/** A project another live app is running a task of (specs/shared-data-folder R1.2). */
export class ProjectBusy extends Error {
  constructor(name: string, h: Holder) {
    super(`"${name}" is running a task in ${APP_LABEL[h.app]} (process ${h.pid}). Its tasks can be read here, and run here once that app closes them.`)
    this.name = "ProjectBusy"
  }
}

/**
  Starts the core on a data folder other apps may be running on (adr:0024-share-the-data-folder-between-processes);
  throws `SchemaTooNew` when a newer app migrated the database, before anything is written.
*/
export async function startCore(host: CoreHost): Promise<Core> {
  const { dataDir } = host
  mkdirSync(dataDir, { recursive: true })
  openDb(join(dataDir, "hfr.db"), { app: host.app, version: host.version })
  const me = new ProcessRegistry(host.app, host.version)
  me.start()
  me.prune()
  const locks = new Locks(dataDir, me.me, me.holds)
  let watcher: ChangeWatcher | null = null
  const push = (p: Push) => {
    watcher?.saw(p)
    host.push(p)
  }
  useKeyStore(host.keys)
  onKey(registerSecret)
  if (host.formerKeys) await moveKeys(host.formerKeys, host.keys)
  await initKey()

  const log = new EventLog(dataDir, push)
  log.owner = me.key
  // Only what a gone process left running: a live app's tasks are its own (specs/shared-data-folder R2.2).
  log.recover((owner) => me.isLive(owner))
  // Task containers of the tasks recover() just interrupted, never those of a live app's task (R2.3).
  // A container of a task this database does not know belongs to another data folder, and is left alone.
  void TaskBox.sweep(dockerExecBuffer, (taskId) => !log.hasTask(taskId) || me.isLive(log.taskOwner(taskId))).catch(() => undefined)
  // So the specialist's sandboxes (specs/specialist-sandbox R2.7), but those of a project a live app holds, and those
  // another data folder recorded.
  void SpecialistBoxes.sweep(dockerExecBuffer, (sandboxId) => {
    const r = getDb().prepare("SELECT project_id FROM sandboxes WHERE id = ?").get(sandboxId) as { project_id: string | null } | undefined
    // Held by a live app: another, or this one, which may already have opened a task of it at start.
    return !r || (!!r.project_id && (claims.has(r.project_id) || locks.holder(projectLockName(r.project_id)) !== null))
  }).catch(() => undefined)
  // Projects: tasks from before them are given one each, once across apps starting together (specs/projects R3.3, R4.1).
  const projects = new ProjectStore(dataDir, push)
  const unknowns = new UnknownsLedger()
  {
    const s = getSettings()
    exclusive(() =>
      projects.adopt({
        provider: s.provider,
        model: s.model,
        orchestratorEffort: s.orchestratorEffort,
        specialistEffort: s.specialistEffort,
        orchestratorProtocol: protocolFor(s.provider, "orchestrator", s),
        specialistProtocol: protocolFor(s.specialistProvider === "claude" ? s.provider : (s.specialistProvider as ProviderId), "specialist", s),
      }),
    )
  }

  const withHolder = (p: ProjectRow): ProjectRow => {
    const h = locks.holder(projectLockName(p.id))
    return { ...p, heldBy: h ? { app: h.app, pid: h.pid } : null }
  }
  // A project's lock, held by this app while any of its tasks is open here (specs/shared-data-folder R1.1).
  const claims = new Map<string, { refs: number; release: () => void }>()
  const claim = (projectId: string): (() => void) => {
    let c = claims.get(projectId)
    if (!c) {
      const name = projects.get(projectId).name
      c = { refs: 0, release: locks.take(projectLockName(projectId), (h) => new ProjectBusy(name, h).message) }
      claims.set(projectId, c)
    }
    c.refs++
    const held = c
    let done = false
    return () => {
      if (done) return
      done = true
      held.refs--
      if (held.refs > 0 || claims.get(projectId) !== held) return
      claims.delete(projectId)
      held.release()
    }
  }
  /** Refuse to act on a project another live app holds (R1.2). */
  const free = (projectId: string | null | undefined) => {
    if (!projectId) return
    const h = locks.holder(projectLockName(projectId))
    if (h) throw new ProjectBusy(projects.get(projectId).name, h)
  }
  const freeTask = (taskId: string) => free(log.getTask(taskId).projectId)
  // One set of sandboxes per project while any of its tasks is open (specs/projects R2.3).
  const registry = new SandboxRegistry(
    (p, after) =>
      new SpecialistBoxes({
        exec: dockerExecBuffer,
        log,
        dir: p.folder,
        sourceRoot: p.sourceRoot,
        projectId: p.id,
        after,
        // The plan's token only where Claude Code may run (specs/specialist-providers R2.3).
        login: () => getSettings().specialistProvider === "claude",
      }),
  )
  // The MCP integrations the app carries, Cheat Engine and IDA Pro, and the gate every call passes (specs/mcp-integrations R1.1).
  const integrationRegistry = new IntegrationRegistry([
    cheatEngine({ script: join(host.sandboxDir, "cheat-engine", BRIDGE_FILE) }),
    idaPro({ pluginDir: join(host.sandboxDir, "ida-pro") }),
  ])
  const integrations = {
    registry: integrationRegistry,
    gate: new IntegrationGate({ registry: integrationRegistry, settings: getSettings, log }),
    serverScript: join(host.sandboxDir, "mcp", "server.mjs"),
  }
  const deps = { log, dataDir, launcher: dockerLauncher(), settings: getSettings, integrations }
  const runner = new TaskRunner({
    ...deps,
    projects,
    apiKey: (provider) => readKey(provider),
    listChatGPTModels: async () => handlers.listChatGPTModels(),
    // The orchestrator's tools run in the task's own container (adr:0007-run-the-orchestrators-tools-in-a-task-container).
    workspace: async (task) => {
      // The project is this app's while the task is open; another app holding it refuses the task (specs/shared-data-folder R1).
      const unclaim = task.projectId ? claim(task.projectId) : () => undefined
      // The task is this process's before its container exists, so another app's sweep never takes it for an orphan.
      log.claim(task.id)
      try {
        const blocked = await preflight(dockerExec)
        if (blocked) throw new Error(blocked)
        const box = await TaskBox.start(dockerExecBuffer, task.id, task.sourceRoot, join(log.taskDir(task.id), "scratch"))
        // The project's sandboxes, shared by its tasks; those earlier runs recorded included (specs/projects R2.3).
        const held = task.projectId ? registry.acquire(projects.get(task.projectId)) : null
        return {
          backend: box,
          root: WORKSPACE,
          scratch: SCRATCH,
          sandboxes: held?.boxes.forTask(task.id),
          created: box.created,
          // Stopped and kept for when the task reopens (specs/task-persistence R3.4); the sandboxes once no task of the project is open.
          dispose: async (o) => {
            await Promise.allSettled([box.dispose(o), held?.release(o)])
            unclaim()
          },
        }
      } catch (e) {
        unclaim()
        throw e
      }
    },
    // Deleting a task removes its own container; the sandboxes are the project's (specs/projects R3.2).
    removeContainers: (task) => TaskBox.remove(dockerExecBuffer, task.id),
  })
  // The image build and the sign-in, done once across the apps on this data folder (specs/shared-data-folder R4.2, R4.3).
  const once = (name: string) => ({
    take: () => {
      try {
        return locks.take(name, () => name)
      } catch (e) {
        if (!(e instanceof LockHeld)) throw e
        return { heldBy: `${APP_LABEL[e.holder.app]} (process ${e.holder.pid})` }
      }
    },
  })
  const sandbox = new SandboxService(dockerExec, host.sandboxDir, (status) => push({ type: "sandbox", status }), once("images"))
  // The first round's proxy goes, then the image is prepared if it is missing or stale (specs/sandbox-images R3.1, R4.2).
  void removeLegacy(dockerExec)
    .catch(() => undefined)
    .then(() => sandbox.status())
  const login = new LoginService(
    spawnStart("docker", (sub) => {
      const id = authId()
      return { args: authArgs(sub, id), stop: () => void dockerExec(["kill", `hfr-auth-${id}`]) }
    }),
    (status) => push({ type: "login", status }),
    once("login"),
  )
  // Hopper's key without pasting it: its page opened in the browser, the key kept as a saved one is (specs/specialist-providers R3).
  const hopper = new HopperSignInService({
    open: async (url) => {
      const page = hopperPage(url)
      if (!page || !host.openExternal) return false
      await host.openExternal(page)
      return true
    },
    save: async (key) => void (await saveKey(key, "hopper")),
  })

  let chatgptHostId = getSetting<string>("chatgpt.host_id", "")
  if (!isValidHostId(chatgptHostId)) {
    chatgptHostId = createHostId()
    setSetting("chatgpt.host_id", chatgptHostId)
  }

  const chatgpt = new ChatGPTAuthService({
    openUrl: async (url) => {
      if (!host.openExternal) return false
      await host.openExternal(url)
      return true
    },
    saveSession: async (session) => {
      if (!session) {
        await clearKey("chatgpt")
      } else {
        await saveKey(JSON.stringify(session), "chatgpt")
      }
      setSetting("keys.rev", Date.now())
    },
    loadSession: async () => {
      const raw = readKey("chatgpt")
      if (!raw) return null
      try {
        return JSON.parse(raw) as ChatGPTSession
      } catch {
        return null
      }
    },
    hostId: chatgptHostId,
  })

  setChatGPTAuthService(chatgpt)

  // Keep the ChatGPT session alive while the app runs: rotate the access token
  // ahead of expiry instead of forcing a manual reconnect every ~1h (issue #21).
  chatgpt.startAutoRefresh()

  let chatgptSessionGen = 0
  let chatgptModelsCache: { gen: number; fingerprint: string; models: ChatGPTModelOption[]; timestamp: number } | null = null

  function getChatGPTFingerprint(): string {
    const raw = readKey("chatgpt")
    if (!raw) return ""
    return createHash("sha256").update(raw).digest("hex")
  }

  function invalidateChatGPTCache() {
    chatgptSessionGen++
    chatgptModelsCache = null
  }

  // The first-run setup's three steps, read from the services Settings already uses (specs/onboarding R1).
  const ready = (o?: Parameters<typeof readiness>[1]) =>
    readiness(
      {
        sandbox: () => sandbox.status(),
        login: () => login.refresh(),
        settings: getSettings,
        keySet: (provider) => keyStatus(provider).set,
        listModels: async (run) =>
          run.provider === "chatgpt"
            ? (await handlers.listChatGPTModels()).map((m) => m.slug)
            : listModels({ provider: run.provider, baseUrl: run.baseUrl, apiKey: readKey(run.provider) }),
        probeModel: async (run) => {
          await probeModel({ provider: run.provider, baseUrl: run.baseUrl, apiKey: readKey(run.provider), model: run.model, protocol: run.protocol })
        },
        keyHint: (provider) => keyStatus(provider).hint,
      },
      o,
    )

  const handlers: Handlers = {
    getSettings: () => getSettings(),
    readiness: () => ready(),
    // Finishing records the setup only once every step is ready (specs/onboarding R1.8).
    completeSetup: async () => {
      const r = await ready()
      const blocked = blocking(r)
      if (blocked) throw new Error(blocked)
      saveSettings({ setupCompleted: true })
      return { ...r, completed: true }
    },
    testConnection: async (o) => {
      const current = getSettings()
      const provider = o?.provider ?? current.provider
      const model = o?.model ?? (provider === current.provider ? current.model : (PROVIDERS[provider]?.defaultModel ?? ""))
      const baseUrl = o?.baseUrl ?? baseUrlFor(provider, current)
      const protocol = o?.protocol ?? protocolFor(provider, "orchestrator", current)
      const key = readKey(provider)
      clearProbeCache()
      return probeModel({
        provider,
        baseUrl,
        apiKey: key,
        model,
        protocol,
      })
    },
    saveSettings: async ({ integrations: wanted, expectedProvider, expectedSpecialistProvider, ...patch }) => {
      const current = getSettings()
      if (expectedProvider && current.provider !== expectedProvider) {
        return current
      }
      if (expectedSpecialistProvider && current.specialistProvider !== expectedSpecialistProvider) {
        return current
      }
      const targetProvider = patch.provider ?? current.provider
      const targetSpecialistProvider = patch.specialistProvider ?? current.specialistProvider
      if (patch.model !== undefined) {
        const m = patch.model.trim()
        if (targetProvider === "chatgpt") {
          if (m) {
            const available = await handlers.listChatGPTModels()
            if (!available.some((opt) => opt.slug === m)) {
              throw new Error(`The model "${m}" is not available for the connected ChatGPT account.`)
            }
          }
        } else {
          if (!m) {
            throw new Error(`A model must be provided for ${PROVIDERS[targetProvider].label}.`)
          }
        }
      }
      if (patch.specialistModel !== undefined) {
        const sm = patch.specialistModel.trim()
        if (targetSpecialistProvider === "chatgpt") {
          if (sm) {
            const available = await handlers.listChatGPTModels()
            if (!available.some((opt) => opt.slug === sm)) {
              throw new Error(`The model "${sm}" is not available for the connected ChatGPT account.`)
            }
          }
        } else if (targetSpecialistProvider !== "claude") {
          if (!sm) {
            throw new Error(`A model must be provided for ${PROVIDERS[targetSpecialistProvider].label}.`)
          }
        }
      }
      if (patch.orchestratorEffort !== undefined) {
        validateReasoningEffort(targetProvider, patch.model ?? current.model, patch.orchestratorEffort)
      }
      if (patch.specialistEffort !== undefined && targetSpecialistProvider !== "claude") {
        validateReasoningEffort(targetSpecialistProvider, patch.specialistModel ?? current.specialistModel, patch.specialistEffort)
      }
      const savedIntegrations = wanted ? await saveIntegrations(integrationRegistry, getSettings(), wanted) : undefined
      const latest = getSettings()
      if (expectedProvider && latest.provider !== expectedProvider) {
        return latest
      }
      if (expectedSpecialistProvider && latest.specialistProvider !== expectedSpecialistProvider) {
        return latest
      }
      if (patch.provider === undefined && patch.model !== undefined && targetProvider !== latest.provider) {
        return latest
      }
      if (patch.specialistProvider === undefined && patch.specialistModel !== undefined && targetSpecialistProvider !== latest.specialistProvider) {
        return latest
      }
      return saveSettings({
        ...patch,
        ...(savedIntegrations !== undefined ? { integrations: savedIntegrations } : {}),
      })
    },
    keyStatus: async (provider) => {
      await refreshKeyAvailability()
      return keyStatus(provider)
    },
    // Saved in the shared keychain; the other apps read it again when they see the bump (specs/shared-data-folder R5.1).
    saveKey: async (key, provider) => {
      if (provider === "chatgpt" && !key.startsWith("{")) {
        throw new Error("ChatGPT provider uses OAuth token sharing. Use Sign in with ChatGPT to connect your account.")
      }
      const s = await saveKey(key, provider)
      setSetting("keys.rev", Date.now())
      return s
    },
    clearKey: async (provider) => {
      if (provider === "chatgpt") {
        invalidateChatGPTCache()
        const current = getSettings()
        if (current.specialistProvider === "chatgpt") {
          saveSettings({ specialistModel: "" })
        }
        if (current.provider === "chatgpt") {
          saveSettings({ model: "" })
        }
        await chatgpt.signOut()
      }
      const s = await clearKey(provider)
      setSetting("keys.rev", Date.now())
      return s
    },
    listModels: (provider) => {
      const settings = getSettings()
      const target = provider ?? settings.provider
      const baseUrl = baseUrlFor(target, settings)
      return listModels({ provider: target, baseUrl, apiKey: readKey(target) })
    },
    listChatGPTModels: async () => {
      const callGen = chatgptSessionGen
      const st = await chatgpt.status()
      if (callGen !== chatgptSessionGen) {
        throw new Error("ChatGPT session changed during model discovery.")
      }
      if (!st.connected) {
        throw new Error("Connect your ChatGPT account to list available models.")
      }
      const fingerprint = getChatGPTFingerprint()
      if (!fingerprint) {
        throw new Error("Connect your ChatGPT account to list available models.")
      }
      if (
        chatgptModelsCache &&
        chatgptModelsCache.gen === callGen &&
        chatgptModelsCache.fingerprint === fingerprint &&
        Date.now() - chatgptModelsCache.timestamp < 60_000
      ) {
        return chatgptModelsCache.models
      }
      const rawKey = readKey("chatgpt")
      const models = await listChatGPTModels({ apiKey: rawKey })
      if (callGen !== chatgptSessionGen) {
        throw new Error("ChatGPT session changed during model discovery.")
      }
      const currentFingerprint = getChatGPTFingerprint()
      if (currentFingerprint !== fingerprint) {
        throw new Error("ChatGPT session changed during model discovery.")
      }
      chatgptModelsCache = { gen: callGen, fingerprint, models, timestamp: Date.now() }
      return models
    },
    sandboxStatus: () => sandbox.status(),
    buildSandbox: () => sandbox.build().status,
    loginStatus: async () => ((await sandbox.status()).images ? login.refresh() : login.current()),
    startLogin: () => login.start().status,
    sendLoginCode: (code) => login.sendCode(code),
    cancelLogin: () => login.cancel(),
    openLoginUrl: async () => {
      const url = login.url()
      if (!url || !isAnthropicUrl(url) || !host.openExternal) return false
      await host.openExternal(url)
      return true
    },
    openProviderSignup: async (provider) => {
      const url = PROVIDERS[provider].signupUrl
      if (!url?.startsWith("https://") || !host.openExternal) return false
      await host.openExternal(url)
      return true
    },
    logout: () => login.logout(),
    startHopperSignIn: (email) => hopper.start(email),
    hopperSignInStatus: () => hopper.status(),
    cancelHopperSignIn: () => hopper.cancel(),
    startChatGPTAuth: () => {
      invalidateChatGPTCache()
      return chatgpt.startSignIn().then((s) => ({
        connected: true,
        accountEmail: s.accountEmail,
        planType: s.planType,
        expiresAt: s.expiresAt,
        hasTokenSharingScope: true,
      }))
    },
    chatGPTAuthStatus: () => chatgpt.status(),
    cancelChatGPTAuth: async () => {
      chatgpt.cancelSignIn()
      return chatgpt.status()
    },
    chatGPTLogout: async () => {
      invalidateChatGPTCache()
      const current = getSettings()
      if (current.specialistProvider === "chatgpt") {
        saveSettings({ specialistModel: "" })
      }
      if (current.provider === "chatgpt") {
        saveSettings({ model: "" })
      }
      const res = await chatgpt.signOut()
      const st = await chatgpt.status()
      return { ...st, warning: res.warning }
    },
    pickFolder: async () => (host.pickFolder ? host.pickFolder() : null),
    // Every project, one another app is running a task of shown as taken by it (specs/shared-data-folder R1.3).
    listProjects: () => projects.list().map(withHolder),
    getProject: (id) => ({
      project: withHolder(projects.get(id)),
      tasks: log.projectTasks(id),
      analyses: log
        .projectAnalyses(id)
        .map(({ id: a, taskId, state, objective, evidence, createdAt }) => ({ id: a, taskId, state, objective, evidence, createdAt })),
      // What its analyses left open, and what closed it (specs/analysis-contract R2.5).
      unknowns: unknowns.list(id),
    }),
    // A project is created only once the setup is completed (specs/projects R4.4).
    createProject: async (input) => {
      if (!getSettings().setupCompleted) throw new Error("Finish the setup before creating a project.")
      const s = getSettings()
      validateReasoningEffort(input.provider, input.model, input.orchestratorEffort)
      if (input.specialistEffort && s.specialistProvider !== "claude") {
        validateReasoningEffort(s.specialistProvider, s.specialistModel, input.specialistEffort)
      }
      const orchestratorProtocol = input.orchestratorProtocol ?? protocolFor(input.provider, "orchestrator", s)
      const sp = s.specialistProvider === "claude" ? input.provider : (s.specialistProvider as ProviderId)
      const specialistProtocol = input.specialistProtocol ?? protocolFor(sp, "specialist", s)
      return projects.create({
        ...input,
        orchestratorProtocol,
        specialistProtocol,
      })
    },
    // Refused while a task of it runs; then its tasks, its sandboxes and the folder the app made for it (R3.1, R3.2).
    deleteProject: async (id) => (free(id), await deleteProject({ store: projects, log, runner, sandboxes: registry }, id), true),
    // The project's tasks follow its new model, each from its next turn; refused while one of them runs (R1.8).
    updateProject: (id, patch) => {
      free(id)
      const running = log.projectTasks(id).filter((t) => ["pending", "running", "waiting"].includes(t.state))
      if (running.length) throw new Error("A task of the project is running; stop it before changing the project's model.")
      const cur = projects.get(id)
      if (patch.orchestratorEffort !== undefined) {
        validateReasoningEffort(patch.provider ?? cur.provider, patch.model ?? cur.model, patch.orchestratorEffort)
      }
      if (patch.specialistEffort !== undefined) {
        const s = getSettings()
        if (s.specialistProvider !== "claude") {
          validateReasoningEffort(s.specialistProvider, s.specialistModel, patch.specialistEffort)
        }
      }
      const p = projects.update(id, patch)
      if (patch.model || patch.provider) for (const t of log.projectTasks(id)) runner.setModel(t.id, p.model)
      return withHolder(p)
    },
    pickTarget: async (kind) => (host.pickTarget ? host.pickTarget(kind) : null),
    detectTarget: (path) => detectTarget(path),
    // Every task runs its tool calls without asking, patches included (specs/chat R4.1); none starts while a
    // setup step is not ready (specs/onboarding R2.1).
    startTask: async (input) => {
      // Checked against the provider and model the project runs with, without listing the provider's models again.
      const project = input.projectId ? projects.get(input.projectId) : null
      if (project && projects.deleting.has(project.id)) throw new Error("The project is being deleted.")
      free(project?.id)
      const run = project ? { provider: project.provider, model: project.model, protocol: project.orchestratorProtocol } : undefined
      const blocked = blocking(await ready({ run, list: false }))
      if (blocked) throw new Error(blocked)
      return runner.start({ ...input, auto: true })
    },
    listTasks: ({ limit }) => log.listTasks(limit),
    getTask: async (id, o) => ({ ...log.history(id, o), turn: await runner.turn(id) }),
    // Acting on a task needs its project free of other apps; reading it does not (specs/shared-data-folder R1.2).
    cancelTask: (id) => (freeTask(id), runner.cancel(id)),
    retryTask: (id) => (freeTask(id), runner.retry(id)),
    decidePatch: (taskId, patchId, decision) => {
      freeTask(taskId)
      const p = log.getPatch(patchId)
      if (p.taskId !== taskId) throw new Error("That patch belongs to another task.")
      const { state, sourceRoot } = log.getTask(taskId)
      if (runner.waitsOn(taskId, patchId)) return runner.decide(taskId, patchId, decision)
      if (state === "running" || state === "pending") throw new Error("The turn is running; decide the patch when the agent asks to apply it.")
      // No paused turn waits on it — the agent never applied it, or the app restarted: the user decides by hand.
      return decision === "approve" ? approvePatch(deps, patchId, sourceRoot) : rejectPatch(deps, patchId)
    },
    sendMessage: (id, message) => (freeTask(id), runner.sendMessage(id, message)),
    closeTask: (id) => (freeTask(id), runner.close(id)),
    stopTurn: (id) => (freeTask(id), runner.stopTurn(id)),
    // A stopped turn, or a task that ended, continued from where it stopped (specs/task-persistence R2.1).
    continueTurn: async (id) => {
      freeTask(id)
      const task = log.getTask(id)
      const project = task.projectId ? projects.get(task.projectId) : null
      const run = project
        ? { provider: project.provider, model: project.model, protocol: project.orchestratorProtocol }
        : { provider: getSettings().provider, model: getSettings().model, protocol: getSettings().orchestratorProtocol }
      const blocked = blocking(await ready({ run, list: false }))
      if (blocked) throw new Error(blocked)
      return runner.continueTask(id)
    },
    deleteTask: async (id) => (freeTask(id), await runner.remove(id), true),
    setTaskModel: (id, model) => (freeTask(id), runner.setModel(id, model)),
    decideTool: (id, callId, decision) => (freeTask(id), runner.decideTool(id, callId, decision)),
    answerQuestion: (id, questionId, answer) => (freeTask(id), runner.answerQuestion(id, questionId, answer)),
    integrations: () => integrationRegistry.views((id) => integrationSettings(integrationRegistry.get(id)!.info, getSettings().integrations).config),
    integrationStatus: (id) => integrationStatus(integrationRegistry, getSettings(), id),
    runIntegrationAction: (id, action) => {
      const i = integrationRegistry.get(id)
      if (!i) throw new Error(`There is no integration ${id}.`)
      return i.runAction(integrationSettings(i.info, getSettings().integrations).config, action)
    },
  }

  // What other processes change reaches the view as pushes, within a second (specs/shared-data-folder R5.3).
  watcher = new ChangeWatcher({
    push: host.push,
    task: (id) => log.getTask(id),
    step: stepRow,
    event: eventRow,
    patch: patchRow,
    project: (id) => withHolder(projects.get(id)),
    holders: () =>
      [...locks.held()]
        .filter(([name]) => name.startsWith("project-"))
        .map(([name, h]) => `${name}=${h.pid}:${h.since}`)
        .sort()
        .join(","),
    keysChanged: () => void initKey(),
  })
  watcher.start()

  return {
    handlers,
    runner,
    log,
    shutdown: async () => {
      watcher?.stop()
      chatgpt.stopAutoRefresh()
      try {
        await runner.stopAll()
      } finally {
        for (const c of claims.values()) c.release()
        claims.clear()
        me.stop()
        closeDb()
      }
    },
  }
}
