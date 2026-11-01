import { join } from "node:path"
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron"
import type { Push } from "@shared/types"
import { startCore } from "./core"
import { contentSecurityPolicy } from "./csp"
import { makeDispatcher } from "./ipc"
import { electronKeyStore } from "./keys-electron"
import { DataFolderBusy } from "./lock"
import { lockNavigation, webPreferences } from "./window"

/*
  The Electron shell around the core (src/main/core.ts): one hardened window, the validated IPC dispatcher carrying
  the core's handlers, pushes sent to the window, and the dialogs and browser only a desktop has.
*/

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
  const pick = async (properties: ("openFile" | "openDirectory")[]) => {
    const r = await dialog.showOpenDialog(win!, { properties })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  }
  let core: Awaited<ReturnType<typeof startCore>>
  try {
    core = await startCore({
      app: "desktop",
      dataDir: app.getPath("userData"),
      sandboxDir: sandboxDir(),
      push,
      keys: electronKeyStore(),
      pickFolder: () => pick(["openDirectory"]),
      pickTarget: (kind) => pick([kind === "file" ? "openFile" : "openDirectory"]),
      openExternal: (url) => shell.openExternal(url),
    })
  } catch (e) {
    // The terminal UI holds the data folder: say so, and leave it to it (plans/finish-the-harness 1.9).
    if (!(e instanceof DataFolderBusy)) throw e
    dialog.showErrorBox("Harness for REA", e.message)
    app.exit(1)
    return
  }
  const dispatch = makeDispatcher(core.handlers, page)
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
    void core.shutdown().finally(() => app.quit())
  })
})

app.on("window-all-closed", () => app.quit())
