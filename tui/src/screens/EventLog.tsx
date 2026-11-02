import { useEffect, useMemo, useState } from "react"
import type { EventRow } from "../../../src/shared/types"
import { clock, tone } from "../../../src/renderer/src/lib/format"
import { useApp, useKeys, usePush, useScreen } from "../app/context"
import { toneColor } from "../app/theme"
import { Frame, List, safe } from "../components/ui"

/*
  A task's event log (specs/tui-panels R1.2): its events newest last, filtered by agent with Tab, each event's payload
  in a dialog on Enter.
*/

const AGENTS = ["all", "orchestrator", "specialist", "sandbox", "app"] as const

export function EventLogScreen({ taskId }: { taskId: string }) {
  const app = useApp()
  const { api, theme, toast } = app
  const [events, setEvents] = useState<EventRow[]>([])
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>("all")
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    void api.getTask(taskId, { limit: 2000 }).then(
      (h) => setEvents(h.events),
      (e: unknown) => toast((e as Error).message, "error"),
    )
  }, [api, taskId, toast])
  usePush((p) => p.type === "event" && p.event.taskId === taskId && setEvents((list) => (list.some((e) => e.id === p.event.id) ? list : [...list, p.event])))

  const shown = useMemo(() => (agent === "all" ? events : events.filter((e) => e.agent === agent)), [events, agent])
  const open = (id: string) => {
    const e = events.find((x) => `${x.id}` === id)
    if (!e) return
    void app.dialog<null>((done) => <Payload event={e} done={done} />)
  }
  useScreen({ title: "Event log", status: agent, commands: [{ name: "back", title: "Back to the task", run: () => app.back() }] })
  const { setPromptFocused } = app
  useEffect(() => {
    setPromptFocused(false)
    return () => setPromptFocused(true)
  }, [setPromptFocused])
  useKeys(
    "events",
    "Event log",
    [{ key: "tab", label: "Next agent filter", hint: true, run: () => setAgent((a) => AGENTS[(AGENTS.indexOf(a) + 1) % AGENTS.length]) }],
    { active: !app.promptFocused },
  )

  return (
    <box flexDirection="column">
      <text
        fg={theme.mutedForeground}
      >{`Filter: ${AGENTS.map((a) => (a === agent ? `[${a}]` : a)).join("  ")}   ${shown.length} of ${events.length} events`}</text>
      <List
        id="events"
        items={shown.map((e) => ({
          id: String(e.id),
          label: `${clock(e.at)}  ${e.agent.padEnd(12)} ${e.kind.padEnd(22)}`,
          detail: e.summary.replace(/\s+/g, " ").slice(0, 100),
          color: toneColor(theme, tone(e.state)),
        }))}
        selected={selected ?? (shown.at(-1) ? String(shown.at(-1)!.id) : null)}
        onMove={setSelected}
        onPick={open}
        active={!app.promptFocused}
        height={30}
        empty="No event yet."
      />
    </box>
  )
}

function Payload({ event, done }: { event: EventRow; done(v: null): void }) {
  const { theme } = useApp()
  useKeys(
    "dialog:payload",
    "Event",
    [
      { key: "escape", label: "Close", run: () => done(null) },
      { key: "return", label: "Close", run: () => done(null) },
    ],
    { modal: true },
  )
  return (
    <Frame title={`${event.agent} · ${event.kind}`} width={110} footer="Esc closes">
      <text fg={theme.foreground}>{safe(event.summary)}</text>
      <scrollbox height={24}>
        <text fg={theme.mutedForeground}>{safe(JSON.stringify(event.payload, null, 2).slice(0, 20_000))}</text>
      </scrollbox>
    </Frame>
  )
}
