import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import type { Api } from "../../../src/shared/api"
import type { Readiness } from "../../../src/shared/types"
import { InputDialog, SelectDialog } from "../components/dialogs"
import { Prompt } from "../components/Prompt"
import { Frame, safe } from "../components/ui"
import { EventLogScreen } from "../screens/EventLog"
import { LaunchScreen } from "../screens/Launch"
import { NewProjectScreen } from "../screens/NewProject"
import { ProjectScreen } from "../screens/Project"
import { SettingsScreen } from "../screens/Settings"
import { SetupScreen } from "../screens/Setup"
import { TaskScreen } from "../screens/Task"
import type { Command } from "./commands"
import {
  AppContext,
  KeyZ,
  specSignature,
  useApp,
  useKeys,
  useLayer,
  useScreen,
  type AppState,
  type Bus,
  type Route,
  type ScreenSpec,
  type ToastKind,
  type Where,
} from "./context"
import { keyLabel, Keymap } from "./keymap"
import type { Theme } from "./theme"
import { openProjects } from "./pickers"

/*
  The TUI's shell (specs/tui-shell R1, R2, R3): the status line, the screen, the working line, the prompt and a line of
  key hints; the help overlay, the command palette, dialogs and toasts over them. One key handler feeds the key map.
*/

export interface AppProps {
  api: Api
  bus: Bus
  theme: Theme
  where: Where
  args: { continue: boolean; resume: boolean }
  quit(): void
  /** lets the host's folder and target pickers open the TUI's browser (CoreHost.pickTarget) */
  onReady?(app: AppState): void
  /** the first screen; the launch when absent */
  start?: Route
}

interface Toast {
  id: number
  text: string
  kind: ToastKind
}

interface DialogEntry {
  id: number
  node: ReactNode
}

const EMPTY: ScreenSpec = { title: "", commands: [] }

/** What the shell keeps between renders without drawing it: the way back, ids, the latest screen spec, the prompt's text. */
class ShellMemory {
  private trail: Route[] = []
  private ids = 0
  private quitAt = 0
  private signed = ""
  private screen: ScreenSpec = EMPTY
  promptText = ""

  latest(): ScreenSpec {
    return this.screen
  }
  nextId() {
    return ++this.ids
  }
  leave(r: Route) {
    this.trail.push(r)
  }
  back(): Route | undefined {
    return this.trail.pop()
  }
  canGoBack() {
    return this.trail.length > 0
  }
  /** A second Ctrl+C within two seconds of the first quits (R2.5). */
  armQuit(now: number): boolean {
    const second = now - this.quitAt < 2000
    this.quitAt = now
    return second
  }
  typed(t: string) {
    this.promptText = t
  }
  /** Keeps the screen's latest spec; whether it changes what the shell draws. */
  track(s: ScreenSpec): boolean {
    this.screen = s
    const sig = specSignature(s)
    if (sig === this.signed) return false
    this.signed = sig
    return true
  }
}

export function App(props: AppProps) {
  const { api, bus, theme, where, args, quit } = props
  const keymap = useMemo(() => new Keymap(), [])
  const [route, setRoute] = useState<Route>(props.start ?? { kind: "launch" })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dialogs, setDialogs] = useState<DialogEntry[]>([])
  const [spec, setSpec] = useState<ScreenSpec>(EMPTY)
  const [sidebar, setSidebar] = useState(true)
  const [promptFocused, setPromptFocused] = useState(true)
  const [help, setHelp] = useState(false)
  const [, setTick] = useState(0)
  const mem = useMemo(() => new ShellMemory(), [])

  // The key map changes as layers come and go; the help and the hints redraw from it.
  useEffect(() => keymap.subscribe(() => setTick((t) => t + 1)), [keymap])

  const toast = useCallback(
    (text: string, kind: ToastKind = "info") => {
      const id = mem.nextId()
      setToasts((t) => [...t.slice(-3), { id, text, kind }])
      // An error stays longer than a success (R3.2).
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3500).unref?.()
    },
    [mem],
  )

  const app: AppState = useMemo(() => {
    const state: AppState = {
      api,
      bus,
      theme,
      keymap,
      where,
      args,
      route,
      // The launch only routes: going on from it replaces it, so Esc never lands back on it.
      go: (r) => {
        if (route.kind !== "launch") mem.leave(route)
        setRoute(r)
      },
      back: () => {
        const prev = mem.back()
        if (prev) setRoute(prev)
      },
      toast,
      attempt: async (fn, ok) => {
        try {
          const r = await fn()
          if (ok) toast(ok, "ok")
          return r
        } catch (e) {
          toast((e as Error).message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, ""), "error")
          return undefined
        }
      },
      dialog: <T,>(render: (done: (v: T | null) => void) => ReactNode) =>
        new Promise<T | null>((resolve) => {
          const id = mem.nextId()
          const done = (v: T | null) => {
            setDialogs((d) => d.filter((x) => x.id !== id))
            resolve(v)
          }
          setDialogs((d) => [...d, { id, node: render(done) }])
        }),
      track: (s) => {
        if (mem.track(s)) setSpec(s)
      },
      current: () => mem.latest(),
      sidebar,
      promptFocused,
      setPromptFocused,
      quit,
    }
    return state
  }, [api, bus, theme, keymap, where, args, route, toast, sidebar, promptFocused, quit, mem])

  const { onReady } = props
  useEffect(() => {
    onReady?.(app)
  }, [onReady, app])

  // One handler for every key: the key map decides, and a key it took never reaches the focused input (R2.1).
  useKeyboard((e) => {
    if (keymap.dispatch(e)) e.preventDefault()
  })

  const globals: Command[] = [
    { name: "help", title: "List every key", key: "?", run: () => setHelp(true) },
    { name: "projects", title: "Open any project", run: () => void openProjects(app) },
    { name: "new", title: "Create a project", run: () => app.go({ kind: "new-project" }) },
    { name: "settings", title: "Change the provider, model, efforts and timeouts", run: () => app.go({ kind: "settings" }) },
    { name: "setup", title: "Open the first-run setup again", run: () => app.go({ kind: "setup", then: route }) },
    { name: "sidebar", title: "Show or hide the sidebar", key: "ctrl+b", run: () => setSidebar((s) => !s) },
    { name: "quit", title: "Quit, stopping this app's running turns", run: () => quit() },
  ]
  const commands = [...spec.commands, ...globals.filter((g) => !spec.commands.some((c) => c.name === g.name))]

  const palette = async () => {
    const id = await app.dialog<string>((done) => (
      <SelectDialog
        title="Commands"
        items={commands.map((c) => ({
          id: c.name,
          label: `/${c.name}${c.args ? ` ${c.args}` : ""}`,
          detail: `${c.title}${c.key ? `  ${keyLabel(c.key)}` : ""}`,
        }))}
        done={done}
      />
    ))
    const cmd = commands.find((c) => c.name === id)
    if (!cmd) return
    let arg = ""
    if (cmd.args) {
      const v = await app.dialog<string>((done) => <InputDialog title={`/${cmd.name}`} placeholder={cmd.args} body={cmd.title} done={done} />)
      if (v === null) return
      arg = v
    }
    await Promise.resolve(cmd.run(arg)).catch((e: unknown) => toast((e as Error).message, "error"))
  }

  // Below every screen's layer, so a screen's Esc (stop the turn) wins over going back (R2.4).
  useLayer(
    keymap,
    "global",
    "Everywhere",
    [
      // `?` is a character in a typed message; it opens the help only when the prompt is empty (R2.1).
      { key: "?", label: "Keys", hint: true, run: () => ((promptFocused ? mem.promptText : app.current().typing) ? false : void setHelp(true)) },
      { key: "ctrl+p", label: "Commands", hint: true, run: () => void palette() },
      { key: "ctrl+b", label: "Sidebar", run: () => setSidebar((s) => !s) },
      { key: "escape", label: "Back", run: () => (mem.canGoBack() ? app.back() : false) },
      {
        key: "ctrl+c",
        label: "Quit (twice)",
        run: () => {
          // A second Ctrl+C within two seconds quits (R2.5).
          const now = Date.now()
          if (mem.armQuit(now)) return quit()
          toast("Press Ctrl+C again to quit.", "info")
        },
      },
    ],
    { z: -1 },
  )

  // The setup's banner: a step that stopped being ready once the setup was completed (specs/tui-panels R3.5).
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  useEffect(() => {
    let alive = true
    const check = () =>
      void api.readiness().then(
        (r) => alive && setReadiness(r),
        () => undefined,
      )
    check()
    const off = bus.on((p) => (p.type === "sandbox" || p.type === "login") && check())
    return () => {
      alive = false
      off()
    }
  }, [api, bus])
  const broken =
    readiness?.completed && !readiness.ready
      ? !readiness.sandbox.ready
        ? "the sandbox images"
        : !readiness.claude.ready
          ? "the Claude sign-in"
          : "the orchestrator's model"
      : null

  const { width } = useTerminalDimensions()
  const overlay = dialogs.length > 0 || help
  const hints = keymap
    .active()
    .flatMap((l) => l.bindings)
    .filter((b) => b.hint)
    .map((b) => `${keyLabel(b.key)} ${b.label.toLowerCase()}`)

  return (
    <AppContext.Provider value={app}>
      <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background}>
        <StatusLine spec={spec} />
        {broken && route.kind !== "setup" && (
          <text
            fg={theme.background}
            bg={theme.warning}
          >{` ${safe(`${broken[0].toUpperCase()}${broken.slice(1)} stopped being ready.`)} Type /setup to fix it. `}</text>
        )}
        <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
          <Screen route={route} />
        </box>
        {spec.working ? (
          <text fg={theme.primary} paddingLeft={1}>
            {`${spinner()} ${safe(spec.working)}`}
            <span fg={theme.mutedForeground}>{"  esc to stop"}</span>
          </text>
        ) : null}
        <Prompt spec={spec} commands={commands} focused={promptFocused && !overlay} onText={(t) => mem.typed(t)} />
        <text fg={theme.mutedForeground} attributes={TextAttributes.DIM} wrapMode="none" paddingLeft={1}>
          {[...hints, "/ commands"].join(" · ").slice(0, Math.max(0, width - 2))}
        </text>
        {help && (
          <KeyZ.Provider value={100}>
            <Help close={() => setHelp(false)} commands={commands} />
          </KeyZ.Provider>
        )}
        {dialogs.map((d, i) => (
          <KeyZ.Provider key={d.id} value={10 + i}>
            {d.node}
          </KeyZ.Provider>
        ))}
        <Toasts toasts={toasts} />
      </box>
    </AppContext.Provider>
  )
}

function spinner(): string {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  return frames[Math.floor(Date.now() / 120) % frames.length]
}

function Screen({ route }: { route: Route }) {
  switch (route.kind) {
    case "launch":
      return <LaunchScreen />
    case "setup":
      return <SetupScreen then={route.then} />
    case "project":
      return <ProjectScreen key={route.id} id={route.id} />
    case "task":
      return <TaskScreen key={route.id} id={route.id} />
    case "new-project":
      return <NewProjectScreen target={route.target} confirm={route.confirm ?? null} />
    case "settings":
      return <SettingsScreen />
    case "events":
      return <EventLogScreen key={route.taskId} taskId={route.taskId} />
    case "message":
      return <MessageScreen title={route.title} text={route.text} />
  }
}

function MessageScreen({ title, text }: { title: string; text: string }) {
  const { theme } = useApp()
  useScreenTitle(title)
  return <text fg={theme.foreground}>{safe(text)}</text>
}

function useScreenTitle(title: string) {
  useScreen({ title, commands: [] })
}

/** The status line (R1.2): where the user is, the task's state, and the key to the help. */
function StatusLine({ spec }: { spec: ScreenSpec }) {
  const { theme } = useApp()
  return (
    <box flexDirection="row" backgroundColor={theme.card} paddingLeft={1} paddingRight={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        Harness for REA
      </text>
      <text fg={theme.foreground} flexGrow={1} wrapMode="none">
        {spec.title ? <span fg={theme.mutedForeground}>{"  ›  "}</span> : null}
        {safe(spec.title)}
        {spec.status ? <span fg={theme.warning}>{`  [${safe(spec.status)}]`}</span> : null}
      </text>
      <text fg={theme.mutedForeground}>? keys · ctrl+p commands</text>
    </box>
  )
}

/** Every key reachable now, by layer, and the slash commands (R2.1). */
function Help({ close, commands }: { close(): void; commands: Command[] }) {
  const { theme, keymap } = useApp()
  useKeys(
    "help",
    "Help",
    [
      { key: "escape", label: "Close", run: close },
      { key: "?", label: "Close", run: close },
    ],
    { modal: true },
  )
  // The help's own layer is left out of what it lists.
  const groups = keymap.active().filter((g) => g.title !== "Help")
  return (
    <Frame title="Keys" width={80} footer="Esc or ? closes">
      {groups.map((g) => (
        <box key={g.title} flexDirection="column" marginBottom={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            {g.title}
          </text>
          {g.bindings.map((b) => (
            <text key={b.key} fg={theme.foreground}>
              <span fg={theme.warning}>{keyLabel(b.key).padEnd(12)}</span>
              {b.label}
            </text>
          ))}
        </box>
      ))}
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        Commands
      </text>
      <text fg={theme.mutedForeground}>{commands.map((c) => `/${c.name}`).join("  ")}</text>
    </Frame>
  )
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  const { theme } = useApp()
  if (!toasts.length) return null
  const color = { ok: theme.success, error: theme.destructive, info: theme.primary }
  return (
    <box position="absolute" bottom={4} right={1} flexDirection="column" zIndex={50} maxWidth="60%">
      {toasts.map((t) => (
        <box key={t.id} border borderStyle="rounded" borderColor={color[t.kind]} backgroundColor={theme.card} paddingLeft={1} paddingRight={1}>
          <text fg={color[t.kind]}>{safe(t.text)}</text>
        </box>
      ))}
    </box>
  )
}
