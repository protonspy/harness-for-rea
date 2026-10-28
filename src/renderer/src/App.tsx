import { History, Plus, Settings as SettingsIcon } from "lucide-react"
import { useEffect, useState } from "react"
import type { TaskRow } from "@shared/types"
import { Badge } from "@/components/ui"
import { cn } from "@/lib/cn"
import { tone, usd, when } from "@/lib/format"
import { foldTasks } from "@/lib/store"
import { NewTask } from "@/views/NewTask"
import { SettingsView } from "@/views/Settings"
import { TaskView } from "@/views/TaskView"

/* The shell: task list and history on the left, the selected view on the right. */

type View = { kind: "new" } | { kind: "settings" } | { kind: "task"; id: string }

export function App() {
  const [view, setView] = useState<View>({ kind: "new" })
  const [tasks, setTasks] = useState<TaskRow[]>([])

  useEffect(() => {
    void window.hfr.api.listTasks({ limit: 200 }).then(setTasks)
    return window.hfr.onPush((p) => setTasks((list) => foldTasks(list, p)))
  }, [])

  const open = (id: string) => setView({ kind: "task", id })

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-4 pt-4 pb-3">
          <div className="text-[15px] font-semibold tracking-tight">Harness for REA</div>
          <div className="text-xs text-muted">orchestrator · sandboxed specialist</div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          <NavButton active={view.kind === "new"} onClick={() => setView({ kind: "new" })} icon={<Plus size={15} />} label="New task" />
          <NavButton active={view.kind === "settings"} onClick={() => setView({ kind: "settings" })} icon={<SettingsIcon size={15} />} label="Settings" />
        </nav>
        <div className="mt-4 flex items-center gap-1.5 px-4 pb-2 text-xs font-medium tracking-wide text-muted uppercase">
          <History size={13} /> Tasks
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-3">
          {tasks.length === 0 && <li className="px-2 py-1 text-xs text-muted">No tasks yet.</li>}
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => open(t.id)}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-raised",
                  view.kind === "task" && view.id === t.id && "bg-raised",
                )}
              >
                <span className="line-clamp-2 text-[13px]">{t.request}</span>
                <span className="flex items-center gap-2 text-[11px] text-muted">
                  <Badge tone={tone(t.state)}>{t.state}</Badge>
                  <span>{when(t.createdAt)}</span>
                  <span className="ml-auto font-mono">{usd(t.costUsd + t.specialistCostUsd)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {view.kind === "new" && <NewTask onStarted={(t) => open(t.id)} onSettings={() => setView({ kind: "settings" })} />}
        {view.kind === "settings" && <SettingsView />}
        {view.kind === "task" && <TaskView key={view.id} id={view.id} onOpen={open} />}
      </main>
    </div>
  )
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised", active && "bg-raised text-accent")}>
      {icon}
      {label}
    </button>
  )
}
