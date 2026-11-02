import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { search } from "../app/commands"
import { useApp, useKeys } from "../app/context"
import { Frame, List, safe, type Item } from "./ui"

/*
  The dialogs the TUI asks with (specs/tui-shell R3.1): a confirmation, a typed value, a choice with a filter. Each is
  a modal layer of the key map while open, so the screen under it sees no key; Esc closes it with no answer.
*/

export function ConfirmDialog({ title, body, yes = "Yes", done }: { title: string; body: string; yes?: string; done(v: boolean | null): void }) {
  const { theme } = useApp()
  useKeys(
    "dialog:confirm",
    title,
    [
      { key: "y", label: yes, run: () => done(true) },
      { key: "return", label: yes, run: () => done(true) },
      { key: "n", label: "No", run: () => done(false) },
      { key: "escape", label: "Cancel", run: () => done(null) },
    ],
    { modal: true },
  )
  return (
    <Frame title={title} footer={`Enter or y: ${yes.toLowerCase()} · n or Esc: no`}>
      <text fg={theme.foreground}>{safe(body)}</text>
    </Frame>
  )
}

/** A value typed: `check` returns why it does not fit, shown under the field, or null to accept it. */
export function InputDialog({
  title,
  body,
  initial = "",
  placeholder,
  check,
  done,
}: {
  title: string
  body?: string
  initial?: string
  placeholder?: string
  check?(v: string): string | null
  done(v: string | null): void
}) {
  const { theme } = useApp()
  const [value, setValue] = useState(initial)
  const [error, setError] = useState("")
  const submit = (v: string) => {
    const why = check?.(v) ?? null
    if (why) setError(why)
    else done(v)
  }
  useKeys("dialog:input", title, [{ key: "escape", label: "Cancel", run: () => done(null) }], { modal: true })
  return (
    <Frame title={title} footer="Enter: accept · Esc: cancel">
      {body ? <text fg={theme.foreground}>{safe(body)}</text> : null}
      <box border borderStyle="rounded" borderColor={theme.primary} height={3} marginTop={body ? 1 : 0}>
        <input
          value={value}
          focused
          placeholder={placeholder}
          textColor={theme.foreground}
          onInput={(v: string) => {
            setValue(v)
            setError("")
          }}
          onSubmit={(v: unknown) => submit(typeof v === "string" ? v : value)}
        />
      </box>
      {error ? <text fg={theme.destructive}>{safe(error)}</text> : null}
    </Frame>
  )
}

/** A choice among items, narrowed by typing (specs/tui-shell R2.3 for the palette, and every picker). */
export function SelectDialog({
  title,
  items,
  initial,
  body,
  filter = true,
  done,
  height = 12,
}: {
  title: string
  items: Item[]
  initial?: string | null
  body?: string
  filter?: boolean
  done(id: string | null): void
  height?: number
}) {
  const { theme } = useApp()
  const [query, setQuery] = useState("")
  const shown = query
    ? search(
        items.map((i) => ({ name: i.id, title: `${i.label} ${i.detail ?? ""}`, run: () => undefined })),
        query,
      ).map((c) => items.find((i) => i.id === c.name)!)
    : items
  const [selected, setSelected] = useState<string | null>(initial ?? items[0]?.id ?? null)
  const sel = shown.some((i) => i.id === selected) ? selected : (shown[0]?.id ?? null)
  useKeys("dialog:select", title, [{ key: "escape", label: "Cancel", run: () => done(null) }], { modal: true })
  return (
    <Frame title={title} footer={`↑ ↓ choose · Enter pick · Esc cancel${filter ? " · type to filter" : ""}`}>
      {body ? <text fg={theme.foreground}>{safe(body)}</text> : null}
      {filter && (
        <box border borderStyle="rounded" borderColor={theme.border} height={3}>
          <input value={query} focused placeholder="Filter…" textColor={theme.foreground} onInput={setQuery} onSubmit={() => void (sel && done(sel))} />
        </box>
      )}
      <List id="dialog" items={shown} selected={sel} onMove={setSelected} onPick={(id) => done(id)} height={height} empty="Nothing matches." />
      {!filter && <text attributes={TextAttributes.DIM}> </text>}
    </Frame>
  )
}
