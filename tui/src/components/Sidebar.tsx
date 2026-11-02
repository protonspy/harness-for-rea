import { TextAttributes } from "@opentui/core"
import type { EventRow, TaskHistory } from "../../../src/shared/types"
import { tokens, tone, usd } from "../../../src/renderer/src/lib/format"
import { filesOfStep } from "../../../src/renderer/src/lib/store"
import { useApp } from "../app/context"
import { toneColor } from "../app/theme"
import { safe } from "./ui"

/*
  The task's sidebar (specs/tui-panels R1.1): the plan, the delegations with their state, the usage per agent with the
  specialist's cost marked as an estimate, and the files the delegations touched. Toggled with Ctrl+B.
*/

export function Sidebar({ h, events }: { h: TaskHistory; events: EventRow[] }) {
  const { theme } = useApp()
  const todos = h.steps.filter((s) => s.kind === "todo")
  const delegations = h.steps.filter((s) => s.kind === "delegation")
  const files = new Set<string>()
  for (const d of delegations) {
    const f = filesOfStep(events, d.id)
    for (const p of [...f.read, ...f.write, ...f.apply]) files.add(p)
  }
  const title = (t: string) => (
    <text fg={theme.primary} attributes={TextAttributes.BOLD} marginTop={1}>
      {t}
    </text>
  )
  const mark = (state: string) => (state === "done" ? "✓" : state === "running" ? "▸" : state === "failed" || state === "cancelled" ? "✗" : "·")
  return (
    <box width={40} flexShrink={0} flexDirection="column" border={["left"]} borderColor={theme.border} paddingLeft={1}>
      {title("Plan")}
      {todos.length ? (
        todos.map((s) => (
          <text key={s.id} fg={toneColor(theme, tone(s.state))}>
            {`${mark(s.state)} `}
            <span fg={theme.foreground}>{safe(s.title)}</span>
          </text>
        ))
      ) : (
        <text fg={theme.mutedForeground}>No plan yet.</text>
      )}
      {title(`Specialist (${delegations.length})`)}
      {delegations.map((s) => (
        <text key={s.id} fg={toneColor(theme, tone(s.state))} wrapMode="none">
          {`${mark(s.state)} `}
          <span fg={theme.foreground}>{safe(s.title.slice(0, 34))}</span>
        </text>
      ))}
      {!delegations.length && <text fg={theme.mutedForeground}>No delegation yet.</text>}
      {title("Usage")}
      {h.usage.map((u) => (
        <text key={u.agent} fg={theme.foreground} wrapMode="none">
          {`${u.agent.padEnd(13)}`}
          <span fg={theme.mutedForeground}>{`${tokens(u.tokensIn)}↑ ${tokens(u.tokensOut)}↓ `}</span>
          {u.estimate ? `~${usd(u.costUsd)}` : usd(u.costUsd)}
        </text>
      ))}
      <text fg={theme.foreground}>
        {"Total        "}
        <span attributes={TextAttributes.BOLD}>{usd(h.task.costUsd + h.task.specialistCostUsd)}</span>
      </text>
      {h.usage.some((u) => u.estimate) && <text fg={theme.mutedForeground}>~ Claude Code's estimate against your plan, not a charge.</text>}
      {title(`Files (${files.size})`)}
      {[...files].slice(0, 12).map((f) => (
        <text key={f} fg={theme.mutedForeground} wrapMode="none">
          {safe(f)}
        </text>
      ))}
      {files.size > 12 && <text fg={theme.mutedForeground}>{`… ${files.size - 12} more`}</text>}
    </box>
  )
}
