import { readdirSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import { useState } from "react"
import { tone, when } from "../../../src/renderer/src/lib/format"
import { heldLabel } from "../../../src/renderer/src/lib/projects"
import { SelectDialog } from "../components/dialogs"
import { Frame, List, safe } from "../components/ui"
import { useApp, useKeys, type AppState } from "./context"
import { toneColor } from "./theme"

/*
  The pickers the TUI opens over a screen: every project, with the app holding one (specs/tui-launch R2.4); a
  project's tasks (R2.3); and a file browser that stands in for the desktop app's folder and file dialogs, so
  `pickFolder` and `pickTarget` reach a picker in the terminal too (specs/tui-panels R2.3).
*/

export async function openProjects(app: AppState): Promise<void> {
  const projects = await app.attempt(() => app.api.listProjects())
  if (!projects) return
  const id = await app.dialog<string>((done) => (
    <SelectDialog
      title="Projects"
      items={[
        ...projects.map((p) => ({ id: p.id, label: p.name, detail: [p.targetPath, heldLabel(p)].filter(Boolean).join(" · ") })),
        { id: "+new", label: "+ Create a project", detail: "" },
      ]}
      done={done}
    />
  ))
  if (id === "+new") app.go({ kind: "new-project" })
  else if (id) app.go({ kind: "project", id })
}

/** The most recent tasks of every project, to open one (the desktop app's sidebar list). */
export async function openRecentTasks(app: AppState): Promise<void> {
  const tasks = await app.attempt(() => app.api.listTasks({ limit: 50 }))
  if (!tasks) return
  if (!tasks.length) return app.toast("No task yet.", "info")
  const id = await app.dialog<string>((done) => (
    <SelectDialog
      title="Recent tasks"
      items={tasks.map((t) => ({
        id: t.id,
        label: t.request.replace(/\s+/g, " ").slice(0, 80),
        detail: `${t.state} · ${when(t.updatedAt)}`,
        color: toneColor(app.theme, tone(t.state)),
      }))}
      done={done}
    />
  ))
  if (id) app.go({ kind: "task", id })
}

/** One of a project's tasks, newest first; null when none was picked. */
export async function pickTask(app: AppState, projectId: string): Promise<string | null> {
  const p = await app.attempt(() => app.api.getProject(projectId))
  if (!p) return null
  if (!p.tasks.length) {
    app.toast("This project has no task yet.", "info")
    return null
  }
  return app.dialog<string>((done) => (
    <SelectDialog
      title={`Tasks of ${p.project.name}`}
      items={p.tasks.map((t) => ({
        id: t.id,
        label: t.request.replace(/\s+/g, " ").slice(0, 90),
        detail: `${t.state} · ${when(t.updatedAt)}`,
        color: toneColor(app.theme, tone(t.state)),
      }))}
      done={done}
    />
  ))
}

/** A file or folder chosen by walking the disk from `start`, or null. */
export function browse(app: AppState, kind: "file" | "folder", start: string): Promise<string | null> {
  return app.dialog<string>((done) => <Browser kind={kind} start={start} done={done} />)
}

function Browser({ kind, start, done }: { kind: "file" | "folder"; start: string; done(p: string | null): void }) {
  const { theme } = useApp()
  const [dir, setDir] = useState(start)
  const [selected, setSelected] = useState<string | null>(null)
  let entries: { id: string; label: string; folder: boolean }[] = []
  let error = ""
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({ id: join(dir, e.name), label: e.isDirectory() ? `${e.name}/` : e.name, folder: e.isDirectory() }))
      .filter((e) => kind === "file" || e.folder)
      .sort((a, b) => Number(b.folder) - Number(a.folder) || a.label.localeCompare(b.label))
  } catch (e) {
    error = (e as Error).message
  }
  const up = parse(dir).root === dir ? null : dirname(dir)
  const items = [...(kind === "folder" ? [{ id: ".", label: "[ choose this folder ]" }] : []), ...(up ? [{ id: "..", label: "../" }] : []), ...entries]
  const pick = (id: string) => {
    if (id === ".") return done(dir)
    if (id === "..") return up && (setDir(up), setSelected(null))
    const e = entries.find((x) => x.id === id)
    if (e?.folder) {
      setDir(e.id)
      setSelected(null)
    } else if (e) done(e.id)
  }
  useKeys(
    "dialog:browse",
    "Browse",
    [
      { key: "escape", label: "Cancel", run: () => done(null) },
      { key: "backspace", label: "Up a folder", run: () => void (up && setDir(up)) },
    ],
    { modal: true },
  )
  return (
    <Frame title={kind === "folder" ? "Choose a folder" : "Choose a file or folder"} footer="Enter opens or picks · Backspace goes up · Esc cancels">
      <text fg={theme.mutedForeground}>{safe(dir)}</text>
      {error ? <text fg={theme.destructive}>{safe(error)}</text> : null}
      <List id="browse" items={items} selected={selected ?? items[0]?.id ?? null} onMove={setSelected} onPick={pick} height={14} />
    </Frame>
  )
}
