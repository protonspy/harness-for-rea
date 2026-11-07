import { TextAttributes } from "@opentui/core"
import { useCallback, useEffect, useState } from "react"
import { SPECIALIST_EFFORTS, type AnalysisSummary, type ProjectRow, type TaskRow, type UnknownRow } from "../../../src/shared/types"
import { getAvailableEffortsForModel } from "../../../src/shared/providers"
import { tone, usd, when } from "../../../src/renderer/src/lib/format"
import { goalCard, heldLabel } from "../../../src/renderer/src/lib/projects"
import { useApp, useKeys, usePush, useScreen } from "../app/context"
import { toneColor } from "../app/theme"
import { pickModel, pickOne } from "../app/pickers"
import { InputDialog } from "../components/dialogs"
import { List, safe } from "../components/ui"

/*
  A project's overview (specs/tui-panels R2.1, R2.2): its target, kind, goal, model and the app holding it, its tasks
  to open, its analyses and the unknowns they left open. A request typed in the prompt starts a task; deleting the
  project asks for its name typed.
*/

interface Data {
  project: ProjectRow
  tasks: TaskRow[]
  analyses: AnalysisSummary[]
  unknowns: UnknownRow[]
}

export function ProjectScreen({ id }: { id: string }) {
  const app = useApp()
  const { theme, api } = app
  const [data, setData] = useState<Data | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const { toast } = app
  const load = useCallback(() => void api.getProject(id).then(setData, (e: unknown) => toast((e as Error).message, "error")), [api, id, toast])
  useEffect(load, [load])
  // A task of the project that moves, or the project itself, changes what the overview shows.
  usePush((p) => {
    if (
      (p.type === "task" && p.task.projectId === id) ||
      p.type === "taskDeleted" ||
      (p.type === "project" && p.project.id === id) ||
      (p.type === "step" && p.step.kind === "delegation")
    )
      load()
    if (p.type === "projectDeleted" && p.id === id) app.go({ kind: "launch" })
  })

  const held = data ? heldLabel(data.project) : null
  const start = async (request: string) => {
    const t = await app.attempt(() => api.startTask({ projectId: id, request }))
    if (t) app.go({ kind: "task", id: t.id })
  }
  const remove = async () => {
    if (!data) return
    const name = data.project.name
    const typed = await app.dialog<string>((done) => (
      <InputDialog
        title="Delete the project"
        body={`This removes "${name}" with its tasks, sandboxes and files, for good. Type its name to confirm.`}
        check={(v) => (v.trim() === name ? null : "That is not the project's name.")}
        done={done}
      />
    ))
    if (typed === null) return
    if (await app.attempt(() => api.deleteProject(id), `Deleted "${name}".`)) app.go({ kind: "launch" })
  }

  useScreen({
    title: data ? data.project.name : "Project",
    status: held ?? undefined,
    placeholder: held ? `${held}: its tasks can be read, not started here` : "Say what you want: what to find, explain or build. Enter starts a task",
    onSubmit: held ? undefined : start,
    commands: [
      {
        name: "model",
        title: "Change the model the project's tasks run with, from their next turn",
        args: "[id]",
        run: async (typed) => {
          if (!data) return
          const model = await pickModel(app, data.project.provider, data.project.model, typed)
          if (model && (await app.attempt(() => api.updateProject(id, { model }), `Model: ${model}.`))) load()
        },
      },
      {
        name: "orchestrator-effort",
        title: "Change the orchestrator's effort",
        run: async () => {
          if (!data) return
          const v = await pickOne(
            app,
            "Orchestrator's effort",
            getAvailableEffortsForModel(data.project.provider, data.project.model),
            data.project.orchestratorEffort,
          )
          if (v && (await app.attempt(() => api.updateProject(id, { orchestratorEffort: v })))) load()
        },
      },
      {
        name: "specialist-effort",
        title: "Change the specialist's effort",
        run: async () => {
          if (!data) return
          const v = await pickOne(app, "Specialist's effort", SPECIALIST_EFFORTS, data.project.specialistEffort)
          if (v && (await app.attempt(() => api.updateProject(id, { specialistEffort: v })))) load()
        },
      },
      { name: "delete-project", title: "Delete this project, its tasks and files, after typing its name", run: remove },
      { name: "refresh", title: "Read the project again", run: load },
      ...(data?.tasks.length
        ? [{ name: "open", title: "Open the selected task", key: "return", run: () => void (selected && app.go({ kind: "task", id: selected })) }]
        : []),
    ],
    mentionRoot: data?.project.sourceRoot,
  })
  // Tab moves between the prompt and the list of tasks.
  useKeys("project", "Project", [{ key: "tab", label: "Prompt or tasks", hint: true, run: () => app.setPromptFocused(!app.promptFocused) }])

  if (!data) return <text fg={theme.mutedForeground}>Loading…</text>
  const { project, tasks, analyses, unknowns } = data
  const open = unknowns.filter((u) => !u.closedBy)
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text fg={theme.foreground} attributes={TextAttributes.BOLD}>
          {safe(project.name)}
          <span fg={theme.mutedForeground}>{`  ${goalCard(project.goal).title} · ${project.targetKind} · ${project.provider} ${project.model}`}</span>
        </text>
        <text fg={theme.mutedForeground}>{safe(project.targetPath)}</text>
        {held ? <text fg={theme.warning}>{safe(held)}</text> : null}
      </box>
      <box flexDirection="row" gap={2}>
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>{`Tasks (${tasks.length})`}</text>
          <List
            id="tasks"
            items={tasks.map((t) => ({
              id: t.id,
              label: t.request.replace(/\s+/g, " ").slice(0, 70),
              detail: `${t.state} · ${when(t.updatedAt)} · ${usd(t.costUsd + t.specialistCostUsd)}`,
              color: toneColor(theme, tone(t.state)),
            }))}
            selected={selected ?? tasks[0]?.id ?? null}
            onMove={setSelected}
            onPick={(tid) => app.go({ kind: "task", id: tid })}
            active={!app.promptFocused}
            height={12}
            empty="No task yet: type a request below."
          />
        </box>
        <box flexDirection="column" flexGrow={1} flexBasis={0}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>{`Analyses (${analyses.length})`}</text>
          {analyses.slice(0, 6).map((a) => (
            <text key={a.id} fg={toneColor(theme, tone(a.state))} wrapMode="none">
              {`${a.state.padEnd(11)} `}
              <span fg={theme.foreground}>{safe(a.objective.replace(/\s+/g, " ").slice(0, 70))}</span>
              <span fg={theme.mutedForeground}>{`  ${a.evidence} evidence`}</span>
            </text>
          ))}
          {!analyses.length && <text fg={theme.mutedForeground}>None yet.</text>}
          <text fg={theme.primary} attributes={TextAttributes.BOLD} marginTop={1}>{`Open unknowns (${open.length} of ${unknowns.length})`}</text>
          {open.slice(0, 6).map((u) => (
            <text key={u.id} fg={u.severity === "high" ? theme.destructive : u.severity === "medium" ? theme.warning : theme.mutedForeground}>
              {`${u.severity.padEnd(7)} `}
              <span fg={theme.foreground}>{safe(u.question)}</span>
            </text>
          ))}
          {!open.length && <text fg={theme.mutedForeground}>None open.</text>}
        </box>
      </box>
    </box>
  )
}
