import { isAppPage } from "./ipc"

/* The window's hardening: what the renderer may do and where it may go. Its CSP is in csp.ts. */

/** The part of `webContents` the lock needs, so a test can pass a fake. */
export interface Contents {
  on(event: "will-navigate", listener: (e: { preventDefault(): void }, url: string) => void): void
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void
}

/** The renderer reaches neither Node nor the machine. */
export function webPreferences(preload: string) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
  } as const
}

/** The window never navigates away from the app's page and never opens another window. */
export function lockNavigation(contents: Contents, page: string): void {
  contents.on("will-navigate", (e, url) => {
    if (!isAppPage(url, page)) e.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
}
