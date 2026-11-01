import { AlertTriangle, History, Plus, Settings as SettingsIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { Readiness, TaskRow } from "@shared/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/cn"
import { tone, usd, when } from "@/lib/format"
import { foldTasks } from "@/lib/store"
import { NewTask } from "@/views/NewTask"
import { SettingsView } from "@/views/Settings"
import { SetupView } from "@/views/Setup"
import { TaskView } from "@/views/TaskView"

/*
  The shell: the first-run setup until it is completed (specs/onboarding R1.1); then the task list and history on
  the left, the selected view on the right, and a banner naming a setup step that stopped being ready (R2.1).
*/

type View = { kind: "new" } | { kind: "settings" } | { kind: "setup" } | { kind: "task"; id: string }

export function App() {
  const api = window.hfr.api
  const [view, setView] = useState<View>({ kind: "new" })
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [completed, setCompleted] = useState<boolean | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)

  useEffect(() => {
    void api.getSettings().then((s) => setCompleted(s.setupCompleted))
    void api.listTasks({ limit: 200 }).then(setTasks)
    return window.hfr.onPush((p) => setTasks((list) => foldTasks(list, p)))
  }, [api])

  // Once the setup is completed, its steps are checked again whenever the sandbox or the sign-in moves.
  const check = useCallback(() => void api.readiness().then(setReadiness, () => undefined), [api])
  useEffect(() => {
    if (!completed) return
    check()
    return window.hfr.onPush((p) => (p.type === "sandbox" || p.type === "login") && check())
  }, [completed, check])

  const open = (id: string) => setView({ kind: "task", id })

  if (completed === null) return null
  if (!completed)
    return (
      <main className="h-full overflow-y-auto">
        <SetupView
          onDone={() => {
            setCompleted(true)
            setView({ kind: "new" })
          }}
        />
      </main>
    )

  const blocked = readiness && !readiness.ready ? [readiness.sandbox, readiness.claude, readiness.model].find((s) => !s.ready) : undefined
  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div className="px-4 pt-4 pb-3">
          <div className="text-[15px] font-semibold tracking-tight">Harness for REA</div>
          <div className="text-xs text-muted-foreground">orchestrator · sandboxed specialist</div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          <NavButton active={view.kind === "new"} onClick={() => setView({ kind: "new" })} icon={<Plus size={15} />} label="New task" />
          <NavButton active={view.kind === "settings"} onClick={() => setView({ kind: "settings" })} icon={<SettingsIcon size={15} />} label="Settings" />
        </nav>
        <div className="mt-4 flex items-center gap-1.5 px-4 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <History size={13} /> Tasks
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-3">
          {tasks.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">No tasks yet.</li>}
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => open(t.id)}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-accent",
                  view.kind === "task" && view.id === t.id && "bg-muted",
                )}
              >
                <span className="line-clamp-2 text-[13px]">{t.request}</span>
                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge variant={tone(t.state)}>{t.state}</Badge>
                  <span>{when(t.createdAt)}</span>
                  <span className="ml-auto font-mono">{usd(t.costUsd + t.specialistCostUsd)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {blocked && view.kind !== "setup" && (
          <div role="alert" className="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-6 py-2.5 text-sm text-warning">
            <AlertTriangle size={15} className="shrink-0" />
            <span className="flex-1">{blocked.reason} No task starts until it is fixed.</span>
            <Button size="sm" variant="outline" onClick={() => setView({ kind: "setup" })}>
              Fix it
            </Button>
          </div>
        )}
        {view.kind === "setup" && (
          <SetupView
            again
            onDone={() => {
              check()
              setView({ kind: "new" })
            }}
          />
        )}
        {view.kind === "new" && <NewTask onStarted={(t) => open(t.id)} onSettings={() => setView({ kind: "settings" })} />}
        {view.kind === "settings" && <SettingsView onSetup={() => setView({ kind: "setup" })} />}
        {view.kind === "task" && <TaskView key={view.id} id={view.id} onOpen={open} onDeleted={() => setView({ kind: "new" })} />}
      </main>
    </div>
  )
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent", active && "bg-muted text-primary")}>
      {icon}
      {label}
    </button>
  )
}
