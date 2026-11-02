import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import type { Api } from "../../../src/shared/api"
import type { Push } from "../../../src/shared/types"
import type { Platform } from "../lib/launch"
import type { Command } from "./commands"
import type { Binding, Keymap } from "./keymap"
import type { Theme } from "./theme"

/*
  What every screen and component of the TUI reaches (specs/tui-shell): the API, the pushes, the theme, the key map,
  the router, toasts, dialogs, and the screen's own prompt and commands, which the shell's prompt and palette read.
*/

/** The core's pushes, as the TUI subscribes to them. */
export interface Bus {
  on(fn: (p: Push) => void): () => void
}

export type Route =
  | { kind: "launch" }
  | { kind: "setup"; then?: Route }
  | { kind: "project"; id: string }
  | { kind: "task"; id: string }
  | { kind: "new-project"; target?: string; confirm?: string | null }
  | { kind: "settings" }
  | { kind: "events"; taskId: string }
  | { kind: "message"; title: string; text: string }

export type ToastKind = "ok" | "error" | "info"

/** What a screen tells the shell: its title and state, its commands, and what the prompt does on it. */
export interface ScreenSpec {
  /** what the status line names: the project, the task */
  title: string
  /** the state shown beside it, `running` */
  status?: string
  commands: Command[]
  /** a line typed that is not a command; absent, the prompt only takes commands */
  onSubmit?(text: string): void | Promise<void>
  placeholder?: string
  /** the line above the prompt while a turn runs */
  working?: string
  /** the folder `@` completes from */
  mentionRoot?: string
  /** the screen's body has text fields, so a typed `?` is a character there rather than the help */
  typing?: boolean
}

export interface Where {
  /** the folder the TUI was run in, or the path it was given */
  folder: string
  platform: Platform
  home: string
  dataDir: string
  env: Record<string, string | undefined>
}

export interface AppState {
  api: Api
  bus: Bus
  theme: Theme
  keymap: Keymap
  where: Where
  args: { continue: boolean; resume: boolean }
  route: Route
  go(r: Route): void
  /** the screen before this one, or the launch */
  back(): void
  toast(text: string, kind?: ToastKind): void
  /** runs an API call, its failure said in a toast; returns its result or undefined */
  attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined>
  /** opens a dialog over the screen; resolves with what it gave `done`, or null when closed */
  dialog<T>(render: (done: (v: T | null) => void) => ReactNode): Promise<T | null>
  /** the screen on show hands its spec over after each render; the shell redraws when what it draws changed */
  track(spec: ScreenSpec): void
  /** the latest spec, with fresh callbacks */
  current(): ScreenSpec
  sidebar: boolean
  /** whether the prompt has the keys: false while a screen's body or a dialog has them */
  promptFocused: boolean
  setPromptFocused(v: boolean): void
  quit(): void
}

export const AppContext = createContext<AppState | null>(null)

/** The height of the overlay a component is drawn in; its key layers take it (see Keymap). */
export const KeyZ = createContext(0)

export function useApp(): AppState {
  const a = useContext(AppContext)
  if (!a) throw new Error("useApp outside the app")
  return a
}

/** Calls `fn` with each push while mounted. */
export function usePush(fn: (p: Push) => void): void {
  const { bus } = useApp()
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  useEffect(() => bus.on((p) => ref.current(p)), [bus])
}

/**
  Adds a layer of bindings to the key map while mounted (specs/tui-shell R2.1). The bindings' handlers are read fresh
  at each key, so a layer is pushed again only when its keys change, not at every render.
*/
export function useKeys(id: string, title: string, bindings: Binding[], o: { modal?: boolean; active?: boolean; z?: number } = {}): void {
  const { keymap } = useApp()
  const inherited = useContext(KeyZ)
  useLayer(keymap, id, title, bindings, { ...o, z: o.z ?? inherited })
}

/** The same, on a key map given rather than read from the app: the shell's own layer, set up before its provider. */
export function useLayer(keymap: Keymap, id: string, title: string, bindings: Binding[], o: { modal?: boolean; active?: boolean; z?: number } = {}): void {
  const ref = useRef(bindings)
  useEffect(() => {
    ref.current = bindings
  })
  const signature = JSON.stringify(bindings.map((b) => [b.key, b.label, !!b.hint]))
  const active = o.active !== false
  const modal = o.modal
  const z = o.z ?? 0
  useEffect(() => {
    if (!active) return
    const keys = JSON.parse(signature) as [string, string, boolean][]
    return keymap.push({
      id,
      title,
      modal,
      z,
      signature,
      bindings: keys.map(([key, label, hint], i) => ({ key, label, hint, run: () => ref.current[i]?.run() })),
    })
  }, [keymap, id, title, signature, active, modal, z])
}

/** What the shell draws from a screen's spec, to tell whether a new one changes anything (specs/tui-shell R1.2). */
export function specSignature(spec: ScreenSpec): string {
  return JSON.stringify([
    spec.title,
    spec.status,
    spec.placeholder,
    spec.working,
    spec.mentionRoot,
    spec.typing,
    !!spec.onSubmit,
    spec.commands.map((c) => c.name),
  ])
}

/** Hands the screen's spec to the shell after each render. */
export function useScreen(spec: ScreenSpec): void {
  const { track } = useApp()
  useEffect(() => {
    track(spec)
  })
}
