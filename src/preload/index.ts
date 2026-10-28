import { contextBridge, ipcRenderer } from "electron"
import { API_METHODS, type Api, type Bridge } from "@shared/api"
import type { Push } from "@shared/types"

const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke("api", m, ...args)])) as unknown as Api

const bridge: Bridge = {
  api,
  onPush(fn) {
    const listener = (_: unknown, p: Push) => fn(p)
    ipcRenderer.on("push", listener)
    return () => {
      ipcRenderer.removeListener("push", listener)
    }
  },
}

contextBridge.exposeInMainWorld("hfr", bridge)
