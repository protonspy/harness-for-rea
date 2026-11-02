import { AlertTriangle, ChevronDown, ChevronRight, FolderKanban, Lock, Plus, Settings as SettingsIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { ProjectRow, Readiness, TaskRow } from "@shared/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"
import { tone } from "@/lib/format"
import { foldProjects, heldLabel, tasksOf } from "@/lib/projects"
import { foldTasks } from "@/lib/store"
import { NewProject } from "@/views/NewProject"
import { ProjectView } from "@/views/ProjectView"
import { SettingsView } from "@/views/Settings"
import { SetupView } from "@/views/Setup"
import { TaskView } from "@/views/TaskView"

/*
  The shell: the first-run setup until it is completed (specs/onboarding R1.1); then the projects on the left, each with
  its tasks (specs/projects R4.1), the selected view on the right, and a banner naming a setup step that stopped being
  ready (specs/onboarding R2.1).
*/

type View = { kind: "new" } | { kind: "settings" } | { kind: "setup" } | { kind: "project"; id: string } | { kind: "task"; id: string }

export function App() {
  const api = window.hfr.api
  const [view, setView] = useState<View>({ kind: "new" })
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [completed, setCompleted] = useState<boolean | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)

  useEffect(() => {
    void api.getSettings().then((s) => setCompleted(s.setupCompleted))
    void api.listTasks({ limit: 200 }).then(setTasks)
    void api.listProjects().then((list) => {
      setProjects(list)
      if (list[0]) setView((v) => (v.kind === "new" ? { kind: "project", id: list[0].id } : v))
    })
    return window.hfr.onPush((p) => {
      setTasks((list) => foldTasks(list, p))
      setProjects((list) => foldProjects(list, p))
    })
  }, [api])

  // Once the setup is completed, its steps are checked again whenever the sandbox or the sign-in moves.
  const check = useCallback(() => void api.readiness().then(setReadiness, () => undefined), [api])
  useEffect(() => {
    if (!completed) return
    check()
    return window.hfr.onPush((p) => (p.type === "sandbox" || p.type === "login") && check())
  }, [completed, check])

  const openTask = (id: string) => setView({ kind: "task", id })
  const openProject = (id: string) => {
    setOpen((o) => ({ ...o, [id]: true }))
    setView({ kind: "project", id })
  }

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
  const current = view.kind === "task" ? tasks.find((t) => t.id === view.id)?.projectId : view.kind === "project" ? view.id : null
  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <img src="./icon.png" alt="" className="size-8 rounded-lg" />
          <div>
            <div className="text-[15px] font-semibold tracking-tight">Harness for REA</div>
            <div className="text-xs text-muted-foreground">orchestrator · sandboxed specialist</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          <NavButton active={view.kind === "new"} onClick={() => setView({ kind: "new" })} icon={<Plus size={15} />} label="New project" />
        </nav>
        <div className="mt-4 flex items-center gap-1.5 px-4 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <FolderKanban size={13} /> Projects
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-3">
          {projects.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">No project yet. What you create shows up here.</li>}
          {projects.map((p) => {
            const expanded = open[p.id] ?? p.id === current
            const own = tasksOf(tasks, p.id)
            return (
              <li key={p.id} className="mb-0.5">
                <div className={cn("flex items-center rounded-md hover:bg-accent", view.kind === "project" && view.id === p.id && "bg-muted")}>
                  <button
                    aria-label={expanded ? "Collapse" : "Expand"}
                    onClick={() => setOpen((o) => ({ ...o, [p.id]: !expanded }))}
                    className="p-1.5 text-muted-foreground hover:text-foreground"
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button onClick={() => openProject(p.id)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-[13px]">
                    <span className="truncate font-medium">{p.name}</span>
                    {heldLabel(p) && (
                      <span title={heldLabel(p)!} aria-label={heldLabel(p)!} className="shrink-0 text-muted-foreground">
                        <Lock size={11} />
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{own.length}</span>
                  </button>
                </div>
                {expanded && (
                  <ul className="ml-5 border-l border-border pl-1.5">
                    {own.length === 0 && <li className="px-2 py-1 text-[11px] text-muted-foreground">No task yet.</li>}
                    {own.map((t) => (
                      <li key={t.id}>
                        <button
                          onClick={() => openTask(t.id)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent",
                            view.kind === "task" && view.id === t.id && "bg-muted",
                          )}
                        >
                          <span className="line-clamp-1 flex-1 text-[12px]">{t.request}</span>
                          <Badge variant={tone(t.state)} className="shrink-0 px-1.5 text-[10px]">
                            {t.state}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
        <div className="border-t border-border p-2">
          <NavButton active={view.kind === "settings"} onClick={() => setView({ kind: "settings" })} icon={<SettingsIcon size={15} />} label="Settings" />
        </div>
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
        {view.kind === "new" && <NewProject onCreated={(p) => openProject(p.id)} />}
        {view.kind === "project" && <ProjectView key={view.id} id={view.id} onOpenTask={openTask} onDeleted={() => setView({ kind: "new" })} />}
        {view.kind === "settings" && <SettingsView onSetup={() => setView({ kind: "setup" })} />}
        {view.kind === "task" && (
          <TaskView key={view.id} id={view.id} onOpen={openTask} onDeleted={() => setView(current ? { kind: "project", id: current } : { kind: "new" })} />
        )}
      </main>
    </div>
  )
}

function NavButton({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent", active && "bg-muted text-primary")}
    >
      {icon}
      {label}
    </button>
  )
}
