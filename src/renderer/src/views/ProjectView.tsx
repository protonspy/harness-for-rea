import { Bug, Code2, FileSearch, Lightbulb, Map as MapIcon, Play, Plug, Trash2, type LucideIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { AnalysisSummary, Goal, ProjectRow, TaskRow } from "@shared/types"
import { ErrorText, Mono } from "@/components/common"
import { message } from "@/components/setup/panels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { tone, usd, when } from "@/lib/format"
import { goalCard } from "@/lib/projects"

/*
  A project (specs/projects R4.3): its target, kind, goal and model; a request to start a task from, with ideas that fit
  the goal; its tasks; and the analyses the specialist left for it, which every new task can read.
*/

const GOAL_ICONS: Record<Goal, LucideIcon> = { understand: MapIcon, reimplement: Code2, integrate: Plug, debug: Bug }

export function ProjectView({ id, onOpenTask, onDeleted }: { id: string; onOpenTask(taskId: string): void; onDeleted(): void }) {
  const api = window.hfr.api
  const [data, setData] = useState<{ project: ProjectRow; tasks: TaskRow[]; analyses: AnalysisSummary[] } | null>(null)
  const [request, setRequest] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => void api.getProject(id).then(setData, (e: unknown) => setError(message(e))), [api, id])
  useEffect(() => {
    load()
    // A task of the project that moves, or one that goes, changes what the view lists.
    return window.hfr.onPush((p) => {
      if ((p.type === "task" && p.task.projectId === id) || p.type === "taskDeleted" || (p.type === "step" && p.step.kind === "delegation")) load()
    })
  }, [load, id])

  const start = async () => {
    setBusy(true)
    setError("")
    try {
      const t = await api.startTask({ projectId: id, request })
      setRequest("")
      onOpenTask(t.id)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <ErrorText>{error}</ErrorText>
  const { project, tasks, analyses } = data
  const card = goalCard(project.goal)
  const GoalIcon = GOAL_ICONS[project.goal]
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 p-8">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{project.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="info">
              <FileSearch size={12} /> {project.targetKind}
            </Badge>
            <Badge variant="neutral">
              <GoalIcon size={12} /> {card.title}
            </Badge>
            <Mono className="text-muted-foreground">{project.model}</Mono>
          </div>
          <Mono className="mt-1.5 block truncate text-muted-foreground" title={project.targetPath}>
            {project.targetPath}
          </Mono>
        </div>
        <Button
          size="sm"
          variant="destructive"
          onClick={() =>
            // Deleting removes the project's tasks, sandboxes and folder for good (specs/projects R3.2).
            window.confirm(`Delete "${project.name}" with its tasks, sandboxes and files? This cannot be undone.`) &&
            void api.deleteProject(id).then(onDeleted, (e: unknown) => setError(message(e)))
          }
        >
          <Trash2 size={14} /> Delete project
        </Button>
      </header>

      <Card className="flex flex-col gap-3 p-5">
        <h2 className="font-semibold">New task</h2>
        <Textarea
          rows={4}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="Say what you want: what to find, explain or build."
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && request.trim() && !busy) void start()
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Lightbulb size={14} className="text-muted-foreground" />
          {card.ideas.map((idea) => (
            <Button key={idea} size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRequest(idea)}>
              {idea}
            </Button>
          ))}
          <Button className="ml-auto" disabled={!request.trim() || busy} onClick={start}>
            <Play size={14} /> Start
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      <div className="grid grid-cols-2 gap-5">
        <Card className="flex flex-col p-0">
          <h2 className="border-b border-border px-4 py-3 font-semibold">Tasks</h2>
          {tasks.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No task yet. Start one above.</p>}
          <ul className="flex flex-col">
            {tasks.map((t) => (
              <li key={t.id}>
                <button onClick={() => onOpenTask(t.id)} className="flex w-full flex-col gap-1 px-4 py-2.5 text-left hover:bg-accent">
                  <span className="line-clamp-2 text-sm">{t.request}</span>
                  <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant={tone(t.state)}>{t.state}</Badge>
                    {when(t.createdAt)}
                    <span className="ml-auto font-mono">{usd(t.costUsd + t.specialistCostUsd)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="flex flex-col p-0">
          <h2 className="border-b border-border px-4 py-3 font-semibold">What the specialist found</h2>
          {analyses.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">Each delegation's report lands here, and every new task can read it.</p>
          )}
          <ul className="flex flex-col">
            {analyses.map((a) => (
              <li key={a.id}>
                <button onClick={() => onOpenTask(a.taskId)} className="flex w-full flex-col gap-1 px-4 py-2.5 text-left hover:bg-accent">
                  <span className="line-clamp-2 text-sm">{a.objective}</span>
                  <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant={tone(a.state)}>{a.state}</Badge>
                    {a.evidence} evidence
                    <span className="ml-auto">{when(a.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
