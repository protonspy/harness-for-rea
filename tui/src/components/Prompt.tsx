import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useEffect, useMemo, useRef, useState } from "react"
import { completions, readCommand, type Command } from "../app/commands"
import { useApp, useKeys, type ScreenSpec } from "../app/context"
import { PromptHistory } from "../lib/history"
import { insertMention, mentionAt, suggestPaths } from "../lib/mentions"
import { safe } from "./ui"

/*
  The prompt (specs/tui-shell R2.2, specs/tui-conversation R4): a multi-line textarea where Enter sends and Shift+Enter
  or Ctrl+J starts a new line, the session's history on Up and Down at its edges, slash commands completed from the
  screen's list, and `@` paths completed from the project's target folder.
*/

/** Enter sends; Shift+Enter, Alt+Enter and Ctrl+J start a new line (R4.1). */
const KEYS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "j", ctrl: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
]

const history = new PromptHistory()

type Popup = { kind: "cmd"; items: Command[] } | { kind: "path"; items: string[]; mention: { start: number; query: string } }

export function Prompt({
  spec,
  commands,
  resolve,
  focused,
  keys = focused,
  onText,
}: {
  spec: ScreenSpec
  commands: Command[]
  /** the command by name as the screen has it now, run in place of the listed one */
  resolve(name: string): Command | undefined
  focused: boolean
  /** its keys stay in the map while the prompt has the focus, an overlay open or not, so the help lists them */
  keys?: boolean
  onText?(text: string): void
}) {
  const app = useApp()
  const { theme } = app
  const ta = useRef<TextareaRenderable>(null)
  const [text, setText] = useState("")
  const [cursor, setCursor] = useState(0)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(() => {
    onText?.(text)
  }, [onText, text])

  const root = spec.mentionRoot
  const mention = useMemo(() => (root ? mentionAt(text, cursor) : null), [root, text, cursor])
  const paths = useMemo(() => (mention && root ? suggestPaths(root, mention.query).slice(0, 8) : []), [mention, root])
  const cmds = completions(commands, text)
  let popup: Popup | null = null
  if (cmds.length) popup = { kind: "cmd", items: cmds.slice(0, 12) }
  else if (mention && paths.length) popup = { kind: "path", items: paths, mention }
  if (dismissed === text) popup = null
  const count = popup?.items.length ?? 0
  const at = count ? Math.min(pick, count - 1) : 0

  const set = (v: string, to = v.length) => {
    ta.current?.setText(v)
    if (ta.current) ta.current.cursorOffset = to
    setText(v)
    setCursor(to)
    setPick(0)
  }
  const sync = () => {
    const t = ta.current
    if (!t) return
    setText(t.plainText)
    setCursor(t.cursorOffset)
  }

  const runCommand = async (cmd: Command, arg: string) => {
    try {
      await cmd.run(arg)
    } catch (e) {
      app.toast((e as Error).message, "error")
    }
  }

  const choose = (i: number) => {
    if (!popup) return
    if (popup.kind === "cmd") {
      const c = popup.items[i]
      // A required argument (`<key>`) is typed after the name; a command with none, or an optional one (`[id]`), runs.
      if (c.args?.startsWith("<")) set(`/${c.name} `)
      else {
        set("")
        void runCommand(resolve(c.name) ?? c, "")
      }
    } else {
      const r = insertMention(text, popup.mention, popup.items[i])
      set(r.text, r.cursor)
    }
  }

  const submit = () => {
    if (popup) return choose(at)
    const value = ta.current?.plainText ?? text
    if (!value.trim()) return
    const c = readCommand(value)
    if (c) {
      const cmd = resolve(c.name)
      if (!cmd) return app.toast(`No command /${c.name} here. Type / to see them.`, "error")
      history.add(value)
      set("")
      void runCommand(cmd, c.arg)
      return
    }
    const send = app.current().onSubmit
    if (!send) return app.toast("Type / for this screen's commands.", "info")
    history.add(value)
    set("")
    void Promise.resolve(send(value.trim())).catch((e: unknown) => app.toast((e as Error).message, "error"))
  }

  const row = () => ta.current?.logicalCursor.row ?? 0
  const lastRow = () => (ta.current?.lineCount ?? 1) - 1
  useKeys(
    "prompt",
    "Prompt",
    [
      { key: "tab", label: "Complete", run: () => (popup ? choose(at) : false) },
      {
        key: "up",
        label: "Previous message",
        run: () => {
          if (popup) return void setPick((p) => (p - 1 + count) % count)
          if (row() > 0) return false
          const prev = history.prev(text)
          if (prev === null) return false
          set(prev)
        },
      },
      {
        key: "down",
        label: "Next message",
        run: () => {
          if (popup) return void setPick((p) => (p + 1) % count)
          if (row() < lastRow()) return false
          const next = history.next()
          if (next === null) return false
          set(next)
        },
      },
      { key: "escape", label: "Close the list", run: () => (popup ? void setDismissed(text) : false) },
      { key: "ctrl+c", label: "Clear the prompt", run: () => (text ? set("") : false) },
      // `?` in a message being typed is a character; with the prompt empty it opens the help (specs/tui-shell R2.1).
      { key: "?", label: "Keys (prompt empty)", run: () => ((ta.current?.plainText ?? text) ? "input" : false) },
      { key: "return", label: "Send", run: () => "input" },
      { key: "shift+return", label: "New line", run: () => "input" },
      { key: "ctrl+j", label: "New line", run: () => "input" },
    ],
    { active: keys },
  )

  const lines = Math.min(8, Math.max(1, text.split("\n").length))
  return (
    <box flexDirection="column" flexShrink={0}>
      {popup && (
        <box flexDirection="column" flexShrink={0} border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.card}>
          {popup.kind === "cmd"
            ? popup.items.map((c, i) => (
                <text key={c.name} bg={i === at ? theme.selection : undefined} wrapMode="none">
                  <span fg={theme.primary}>{`/${c.name}`}</span>
                  {c.args ? <span fg={theme.mutedForeground}>{` ${c.args}`}</span> : null}
                  <span fg={theme.mutedForeground}>{`  ${c.title}`}</span>
                </text>
              ))
            : popup.items.map((p, i) => (
                <text key={p} bg={i === at ? theme.selection : undefined} fg={theme.foreground} wrapMode="none">
                  {`@${safe(p)}`}
                </text>
              ))}
          <text fg={theme.mutedForeground} attributes={TextAttributes.DIM}>
            Tab or Enter picks · ↑ ↓ move · Esc closes
          </text>
        </box>
      )}
      <box border borderStyle="rounded" borderColor={focused ? theme.primary : theme.border} height={lines + 2} flexDirection="row">
        <text fg={theme.primary}>{"› "}</text>
        <textarea
          ref={ta}
          flexGrow={1}
          focused={focused}
          keyBindings={KEYS}
          placeholder={spec.placeholder ?? "Type / for commands"}
          placeholderColor={theme.mutedForeground}
          textColor={theme.foreground}
          focusedTextColor={theme.foreground}
          onSubmit={submit}
          onContentChange={sync}
          onCursorChange={sync}
        />
      </box>
    </box>
  )
}
