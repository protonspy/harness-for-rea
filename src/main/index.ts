import { join } from "node:path"
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron"
import type { Handlers } from "@shared/api"
import type { Push } from "@shared/types"
import { clearKey, initKey, keyStatus, onKey, readKey, saveKey } from "./credentials"
import { closeDb, openDb } from "./db"
import { approvePatch, dockerLauncher } from "./delegation"
import { EventLog } from "./events/log"
import { registerSecret } from "./events/redact"
import { makeDispatcher } from "./ipc"
import { TaskRunner } from "./orchestrator/runner"
import { authArgs, dockerExec, ensureNetwork } from "./sandbox/docker"
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
  const deps = { log, dataDir, launcher: dockerLauncher(), settings: getSettings }
  const runner = new TaskRunner({ ...deps, apiKey: readKey })
  const sandbox = new SandboxService(dockerExec, sandboxDir(), (status) => push({ type: "sandbox", status }))
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
    startLogin: async () => {
      const blocked = await ensureNetwork(dockerExec)
      if (blocked) throw new Error(blocked)
      return login.start().status
    },
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
    startTask: (input) => runner.start(input),
    listTasks: ({ limit }) => log.listTasks(limit),
    getTask: (id, o) => log.history(id, o),
    cancelTask: (id) => runner.cancel(id),
    retryTask: (id) => runner.retry(id),
    decidePatch: (taskId, patchId, decision) => {
      const p = log.getPatch(patchId)
      if (p.taskId !== taskId) throw new Error("That patch belongs to another task.")
      // A patch whose run is gone (the app restarted) can still be applied or rejected by hand.
      try {
        return runner.decide(taskId, patchId, decision)
      } catch {
        if (decision === "approve") return approvePatch(deps, patchId, log.getTask(taskId).sourceRoot)
        throw new Error("That patch is not waiting for a decision.")
      }
    },
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

  app.on("before-quit", () => {
    runner.stopAll()
    closeDb()
  })
})

app.on("window-all-closed", () => app.quit())
