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
import { TaskRunner } from "./orchestrator/runner"
import { authArgs, dockerExec, preflight, removeLegacy } from "./sandbox/docker"
import { dockerExecBuffer, SCRATCH, TaskBox, WORKSPACE } from "./sandbox/taskbox"
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

app.whenReady().then(async () => {
  const dataDir = app.getPath("userData")
  openDb(join(dataDir, "hfr.db"))
  onKey(registerSecret)
  initKey()

  const log = new EventLog(dataDir, push)
  log.recover()
  // Task containers a crash left running belong to tasks recover() just marked interrupted.
  void TaskBox.sweep(dockerExecBuffer).catch(() => undefined)
  const deps = { log, dataDir, launcher: dockerLauncher(), settings: getSettings }
  const runner = new TaskRunner({
    ...deps,
    apiKey: readKey,
    // The orchestrator's tools run in the task's own container (adr:0007-run-the-orchestrators-tools-in-a-task-container).
    workspace: async (task) => {
      const blocked = await preflight(dockerExec)
      if (blocked) throw new Error(blocked)
      const box = await TaskBox.start(dockerExecBuffer, task.id, task.sourceRoot, getSettings())
      return { backend: box, root: WORKSPACE, scratch: SCRATCH, dispose: () => box.dispose() }
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

  const handlers: Handlers = {
    getSettings: () => getSettings(),
    saveSettings: (patch) => saveSettings(patch),
    keyStatus: () => keyStatus(),
    saveKey: (key) => saveKey(key),
    clearKey: () => clearKey(),
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
    // Every task runs its tool calls without asking, patches included (specs/chat R4.1).
    startTask: (input) => runner.start({ ...input, auto: true }),
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
    continueTurn: (id) => runner.continueTurn(id),
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
