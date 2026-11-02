import { TextAttributes } from "@opentui/core"
import { useState, type ReactNode } from "react"
import { terminalSafe } from "../lib/safe"
import { useApp, useKeys } from "../app/context"

/*
  The TUI's building blocks: a framed overlay, a keyboard list that keeps its selection by id (specs/tui-shell R1.5),
  and a one-line field. Every text drawn from the API goes through `terminalSafe` (R3.3).
*/

/** Text from the API, made safe to draw. */
export const safe = (s: string) => terminalSafe(s)

/** An overlay centred over the screen, with a title and a border. */
export function Frame({ title, children, width = 72, footer }: { title: string; children: ReactNode; width?: number | `${number}%`; footer?: string }) {
  const { theme } = useApp()
  return (
    <box position="absolute" top={2} left={0} width="100%" alignItems="center" zIndex={20}>
      <box
        width={width}
        maxWidth="96%"
        border
        borderStyle="rounded"
        borderColor={theme.primary}
        backgroundColor={theme.card}
        title={` ${safe(title)} `}
        titleAlignment="left"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        {children}
        {footer && (
          <text fg={theme.mutedForeground} attributes={TextAttributes.DIM}>
            {footer}
          </text>
        )}
      </box>
    </box>
  )
}

export interface Item {
  id: string
  label: string
  /** a second, dimmer part on the same line */
  detail?: string
  color?: string
}

/**
  A list moved with the arrows and picked with Enter. The selection is an id, so an item pushed above it does not move
  it (R1.5). `active` binds the keys; only one list on a screen takes them at a time.
*/
export function List({
  id,
  items,
  selected,
  onMove,
  onPick,
  active = true,
  height = 10,
  empty = "Nothing here.",
}: {
  id: string
  items: Item[]
  selected: string | null
  onMove(id: string): void
  onPick(id: string): void
  active?: boolean
  height?: number
  empty?: string
}) {
  const { theme } = useApp()
  const at = Math.max(
    0,
    items.findIndex((i) => i.id === selected),
  )
  const move = (by: number) => {
    if (!items.length) return
    const next = Math.min(items.length - 1, Math.max(0, at + by))
    onMove(items[next].id)
  }
  useKeys(
    `list:${id}`,
    "List",
    [
      { key: "up", label: "Previous", run: () => move(-1) },
      { key: "down", label: "Next", run: () => move(1) },
      { key: "pageup", label: "Page up", run: () => move(-height) },
      { key: "pagedown", label: "Page down", run: () => move(height) },
      { key: "home", label: "First", run: () => move(-items.length) },
      { key: "end", label: "Last", run: () => move(items.length) },
      { key: "return", label: "Open", run: () => items[at] && onPick(items[at].id) },
    ],
    { active },
  )
  if (!items.length)
    return (
      <text fg={theme.mutedForeground} attributes={TextAttributes.DIM}>
        {empty}
      </text>
    )
  const first = Math.min(Math.max(0, at - Math.floor(height / 2)), Math.max(0, items.length - height))
  const shown = items.slice(first, first + height)
  return (
    <box flexDirection="column">
      {shown.map((item) => {
        const on = item.id === items[at]?.id
        return (
          <box key={item.id} flexDirection="row" backgroundColor={on ? theme.selection : undefined}>
            <text fg={on ? theme.primary : theme.mutedForeground}>{on ? "› " : "  "}</text>
            <text fg={item.color ?? theme.foreground} wrapMode="none">
              {safe(item.label)}
              {item.detail ? <span fg={theme.mutedForeground}>{`  ${safe(item.detail)}`}</span> : null}
            </text>
          </box>
        )
      })}
      {items.length > height && <text fg={theme.mutedForeground} attributes={TextAttributes.DIM}>{`  ${at + 1}/${items.length}`}</text>}
    </box>
  )
}

/** A list with its own selection, for dialogs and screens that need no more. */
export function PickList(props: Omit<Parameters<typeof List>[0], "selected" | "onMove"> & { initial?: string | null }) {
  const [selected, setSelected] = useState<string | null>(props.initial ?? props.items[0]?.id ?? null)
  return <List {...props} selected={selected} onMove={setSelected} />
}

/** A labelled one-line field. */
export function Field({
  label,
  value,
  onInput,
  onSubmit,
  focused,
  placeholder,
  note,
  noteColor,
}: {
  label: string
  value: string
  onInput(v: string): void
  onSubmit?(v: string): void
  focused: boolean
  placeholder?: string
  note?: string
  noteColor?: string
}) {
  const { theme } = useApp()
  return (
    <box flexDirection="column" marginBottom={0}>
      <text fg={focused ? theme.primary : theme.mutedForeground}>{label}</text>
      <box border borderStyle="rounded" borderColor={focused ? theme.primary : theme.border} height={3}>
        <input
          value={value}
          onInput={onInput}
          onSubmit={(v: unknown) => onSubmit?.(typeof v === "string" ? v : value)}
          focused={focused}
          placeholder={placeholder}
          textColor={theme.foreground}
        />
      </box>
      {note ? <text fg={noteColor ?? theme.mutedForeground}>{safe(note)}</text> : null}
    </box>
  )
}

/** A choice among a few values, changed with Left and Right while focused. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  focused,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange(v: T): void
  focused: boolean
}) {
  const { theme } = useApp()
  const at = options.indexOf(value)
  useKeys(
    `choice:${label}`,
    label,
    [
      { key: "left", label: "Previous value", run: () => onChange(options[(at - 1 + options.length) % options.length]) },
      { key: "right", label: "Next value", run: () => onChange(options[(at + 1) % options.length]) },
    ],
    { active: focused },
  )
  return (
    <box flexDirection="column">
      <text fg={focused ? theme.primary : theme.mutedForeground}>{label}</text>
      <text>
        {options.map((o) => (
          <span
            key={o}
            fg={o === value ? theme.background : theme.mutedForeground}
            bg={o === value ? (focused ? theme.primary : theme.mutedForeground) : undefined}
          >
            {` ${o} `}
          </span>
        ))}
        {focused ? <span fg={theme.mutedForeground}>{"   ← →"}</span> : null}
      </text>
    </box>
  )
}
