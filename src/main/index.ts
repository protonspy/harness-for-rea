import { join } from "node:path"
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron"
import type { Handlers } from "@shared/api"
import type { Push } from "@shared/types"
import { clearKey, initKey, keyStatus, onKey, readKey, saveKey } from "./credentials"
import { closeDb, openDb } from "./db"
import { approvePatch, dockerLauncher, rejectPatch } from "./delegation"
import { EventLog } from "./events/log"
import { registerSecret } from "./events/redact"
import { makeDispatcher } from "./ipc"
import { listModels } from "./orchestrator/models"
import { blocking, readiness } from "./readiness"
import { TaskRunner } from "./orchestrator/runner"
import { authArgs, dockerExec, preflight, removeLegacy } from "./sandbox/docker"
import { dockerExecBuffer, SCRATCH, TaskBox, WORKSPACE } from "./sandbox/taskbox"
import { SpecialistBoxes } from "./sandbox/specialistbox"
import { getSettings, saveSettings } from "./settings"
import { isAnthropicUrl, spawnStart } from "./specialist/account"
import { authId, LoginService, SandboxService } from "./status"
import { contentSecurityPolicy } from "./csp"
import { lockNavigation, webPreferences } from "./window"

/* The Electron entry point: one hardened window, the validated IPC dispatcher, and the services behind it. */

let win: BrowserWindow | null = null
const DEV = process.env.ELECTRON_RENDERER_URL

function page(): string {
  return DEV ?? new URL(`file:///${join(__dirname, "../renderer/index.html").replace(/\\/g, "/")}`).href
}

function push(p: Push) {
  win?.webContents.send("push", p)
}

function sandboxDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "sandbox") : join(app.getAppPath(), "sandbox")
}

// One instance at a time: a second would sweep the first's task containers as orphans at start.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore()
  win?.focus()
})

app.whenReady().then(async () => {
  if (!primary) return
  const dataDir = app.getPath("userData")
  openDb(join(dataDir, "hfr.db"))
  onKey(registerSecret)
  initKey()

  const log = new EventLog(dataDir, push)
  log.recover()
  // Task containers a crash left running belong to tasks recover() just marked interrupted.
  void TaskBox.sweep(dockerExecBuffer).catch(() => undefined)
  // So do the specialist's sandboxes (specs/specialist-sandbox R2.7).
  void SpecialistBoxes.sweep(dockerExecBuffer).catch(() => undefined)
  const deps = { log, dataDir, launcher: dockerLauncher(), settings: getSettings }
  const runner = new TaskRunner({
    ...deps,
    apiKey: (provider) => readKey(provider),
    // The orchestrator's tools run in the task's own container (adr:0007-run-the-orchestrators-tools-in-a-task-container).
    workspace: async (task) => {
      const blocked = await preflight(dockerExec)
      if (blocked) throw new Error(blocked)
      const box = await TaskBox.start(dockerExecBuffer, task.id, task.sourceRoot, join(log.taskDir(task.id), "scratch"))
      // The specialist's sandboxes the orchestrator creates, those an earlier run recorded included (specs/task-persistence R3.6).
      const sandboxes = new SpecialistBoxes({ exec: dockerExecBuffer, log, taskDir: log.taskDir(task.id), sourceRoot: task.sourceRoot, taskId: task.id })
      return {
        backend: box,
        root: WORKSPACE,
        scratch: SCRATCH,
        sandboxes,
        created: box.created,
        // Stopped and kept for when the task reopens (specs/task-persistence R3.4).
        dispose: async () => void (await Promise.allSettled([box.dispose(), sandboxes.stopAll()])),
      }
    },
    // Only deleting the task removes its containers (specs/task-persistence R4.1).
    removeContainers: async (task) => {
      await TaskBox.remove(dockerExecBuffer, task.id)
      await new SpecialistBoxes({ exec: dockerExecBuffer, log, taskDir: log.taskDir(task.id), sourceRoot: task.sourceRoot, taskId: task.id }).removeAll()
    },
  })
  const sandbox = new SandboxService(dockerExec, sandboxDir(), (status) => push({ type: "sandbox", status }))
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
  )

  // The first-run setup's three steps, read from the services Settings already uses (specs/onboarding R1).
  const ready = () =>
    readiness({
      sandbox: () => sandbox.status(),
      login: () => login.refresh(),
      settings: getSettings,
      keySet: (provider) => keyStatus(provider).set,
      listModels: () => {
        const { provider, baseUrl } = getSettings()
        return listModels({ provider, baseUrl, apiKey: readKey(provider) })
      },
    })

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
    saveSettings: (patch) => saveSettings(patch),
    keyStatus: (provider) => keyStatus(provider),
    saveKey: (key, provider) => saveKey(key, provider),
    clearKey: (provider) => clearKey(provider),
    listModels: () => {
      const { provider, baseUrl } = getSettings()
      return listModels({ provider, baseUrl, apiKey: readKey(provider) })
    },
    sandboxStatus: () => sandbox.status(),
    buildSandbox: () => sandbox.build().status,
    loginStatus: async () => ((await sandbox.status()).images ? login.refresh() : login.current()),
    startLogin: () => login.start().status,
    sendLoginCode: (code) => login.sendCode(code),
    cancelLogin: () => login.cancel(),
    openLoginUrl: async () => {
      const url = login.url()
      if (!url || !isAnthropicUrl(url)) return false
      await shell.openExternal(url)
      return true
    },
    logout: () => login.logout(),
    pickFolder: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    // Every task runs its tool calls without asking, patches included (specs/chat R4.1); none starts while a
    // setup step is not ready (specs/onboarding R2.1).
    startTask: async (input) => {
      const blocked = blocking(await ready())
      if (blocked) throw new Error(blocked)
      return runner.start({ ...input, auto: true })
    },
    listTasks: ({ limit }) => log.listTasks(limit),
    getTask: async (id, o) => ({ ...log.history(id, o), turn: await runner.turn(id) }),
    cancelTask: (id) => runner.cancel(id),
    retryTask: (id) => runner.retry(id),
    decidePatch: (taskId, patchId, decision) => {
      const p = log.getPatch(patchId)
      if (p.taskId !== taskId) throw new Error("That patch belongs to another task.")
      const { state, sourceRoot } = log.getTask(taskId)
      if (runner.waitsOn(taskId, patchId)) return runner.decide(taskId, patchId, decision)
      if (state === "running" || state === "pending") throw new Error("The turn is running; decide the patch when the agent asks to apply it.")
      // No paused turn waits on it — the agent never applied it, or the app restarted: the user decides by hand.
      return decision === "approve" ? approvePatch(deps, patchId, sourceRoot) : rejectPatch(deps, patchId)
    },
    sendMessage: (id, message) => runner.sendMessage(id, message),
    closeTask: (id) => runner.close(id),
    stopTurn: (id) => runner.stopTurn(id),
    // A stopped turn, or a task that ended, continued from where it stopped (specs/task-persistence R2.1).
    continueTurn: (id) => runner.continueTask(id),
    deleteTask: async (id) => (await runner.remove(id), true),
    decideTool: (id, callId, decision) => runner.decideTool(id, callId, decision),
    answerQuestion: (id, questionId, answer) => runner.answerQuestion(id, questionId, answer),
  }
  const dispatch = makeDispatcher(handlers, page)
  ipcMain.handle("api", (e, method: unknown, ...args: unknown[]) => dispatch(e.senderFrame?.url ?? "", method, args))

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [contentSecurityPolicy(DEV ? new URL(DEV).origin : undefined)] } })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Harness for REA",
    // The app icon, shipped with the page (plans/projects-and-onboarding.md 1.1); the installer takes resources/icon.ico.
    icon: join(__dirname, "../renderer/icon.png"),
    backgroundColor: "#0b0d10",
    show: false,
    webPreferences: webPreferences(join(__dirname, "../preload/index.js")),
  })
  lockNavigation(win.webContents, page())
  win.webContents.on("will-attach-webview", (e) => e.preventDefault())
  win.once("ready-to-show", () => win?.show())
  win.on("closed", () => (win = null))
  if (DEV) await win.loadURL(DEV)
  else await win.loadFile(join(__dirname, "../renderer/index.html"))

  let quitting = false
  app.on("before-quit", (e) => {
    if (quitting) return
    // Hold the quit until every task container is removed, then quit for real.
    e.preventDefault()
    quitting = true
    void runner.stopAll().finally(() => {
      closeDb()
      app.quit()
    })
  })
})

app.on("window-all-closed", () => app.quit())
