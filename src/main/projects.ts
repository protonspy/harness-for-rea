import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { copyFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative } from "node:path"
import { GOALS, type Goal, type OrchestratorEffort, type ProjectRow, type Push, type SpecialistEffort, type TargetKind } from "@shared/types"
import type { ModelProtocol } from "@shared/providers"
import type { ProviderId } from "@shared/providers"
import { getDb } from "./db"
import type { EventLog } from "./events/log"
import { removeTree } from "./sandbox/paths"
import { detectTarget, localPath } from "./target"

/*
  Projects (specs/projects, adr:0020-group-tasks-into-projects-that-share-their-analyses): one target each, with a
  UUID, a folder, a goal and the model its tasks run with. A file target is copied into the project's `target/`
  folder, which its tasks mount read-only; a folder target is read in place.
*/

type Row = Record<string, unknown>

export interface NewProject {
  name: string
  goal: Goal
  target: string
  provider: ProviderId
  model: string
  orchestratorEffort: OrchestratorEffort
  specialistEffort: SpecialistEffort
  orchestratorProtocol?: ModelProtocol
  specialistProtocol?: ModelProtocol
  /** a folder the user chose to keep the project under; the app's data folder when absent */
  parentFolder?: string | null
}

function projectRow(r: Row): ProjectRow {
  return {
    id: String(r.id),
    name: String(r.name),
    goal: r.goal as Goal,
    targetPath: String(r.target_path),
    targetKind: r.target_kind as TargetKind,
    sourceRoot: String(r.source_root),
    folder: String(r.folder),
    ownsFolder: Number(r.owns_folder) === 1,
    provider: r.provider as ProviderId,
    model: String(r.model),
    orchestratorEffort: r.orchestrator_effort as OrchestratorEffort,
    specialistEffort: r.specialist_effort as SpecialistEffort,
    orchestratorProtocol: (r.orchestrator_protocol as ModelProtocol) ?? "chat_completions",
    specialistProtocol: (r.specialist_protocol as ModelProtocol) ?? "chat_completions",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

/** A folder name from a project's name: letters, digits and dashes. */
export function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .toLowerCase()
      .slice(0, 40) || "project"
  )
}

export class ProjectStore {
  /** projects being deleted: no task of theirs starts meanwhile */
  readonly deleting = new Set<string>()

  constructor(
    private readonly dataDir: string,
    private readonly push: (p: Push) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /**
    Create a project: its folder, the copy of a file target, and its record (R1.1–R1.3); refuses a target that cannot
    be read or a folder that cannot be written, keeping nothing (R1.7).
  */
  async create(p: NewProject): Promise<ProjectRow> {
    const name = p.name.trim()
    if (!name) throw new Error("Name the project.")
    if (!(GOALS as readonly string[]).includes(p.goal)) throw new Error(`Unknown goal ${p.goal}.`)
    let target
    try {
      target = detectTarget(p.target)
    } catch (e) {
      throw new Error(`The target cannot be read: ${(e as Error).message}`, { cause: e })
    }
    // The app's own data — keys' neighbours, every project's files — is never a target the sandboxes mount.
    const inData = relative(this.dataDir, target.path)
    if (!inData.startsWith("..") && !isAbsolute(inData)) throw new Error("The target cannot be the app's data folder or anything inside it.")
    const id = randomUUID()
    const folder = p.parentFolder ? join(localPath(p.parentFolder), `${slug(name)}-${id}`) : join(this.dataDir, "projects", id)
    try {
      mkdirSync(folder, { recursive: true })
    } catch (e) {
      throw new Error(`The project's folder cannot be written: ${(e as Error).message}`, { cause: e })
    }
    // A copy or a record that fails leaves nothing behind (R1.7).
    try {
      let sourceRoot = target.path
      if (target.isFile) {
        sourceRoot = join(folder, "target")
        mkdirSync(sourceRoot, { recursive: true })
        await copyFile(target.path, join(sourceRoot, basename(target.path)))
      }
      const at = this.now()
      getDb()
        .prepare(
          `INSERT INTO projects (id, name, goal, target_path, target_kind, source_root, folder, owns_folder, provider, model,
            orchestrator_effort, specialist_effort, orchestrator_protocol, specialist_protocol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          p.goal,
          target.path,
          target.kind,
          sourceRoot,
          folder,
          p.provider,
          p.model,
          p.orchestratorEffort,
          p.specialistEffort,
          p.orchestratorProtocol ?? "chat_completions",
          p.specialistProtocol ?? "chat_completions",
          at,
          at,
        )
    } catch (e) {
      removeTree(folder)
      throw new Error(`The project could not be created: ${(e as Error).message}`, { cause: e })
    }
    return this.emit(id)
  }

  get(id: string): ProjectRow {
    const r = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined
    if (!r) throw new Error(`No project ${id}.`)
    return projectRow(r)
  }

  /** Change the provider, model or efforts a project's tasks run with (R1.8). */
  update(
    id: string,
    patch: {
      provider?: ProviderId
      model?: string
      orchestratorEffort?: OrchestratorEffort
      specialistEffort?: SpecialistEffort
      orchestratorProtocol?: ModelProtocol
      specialistProtocol?: ModelProtocol
    },
  ): ProjectRow {
    const cur = this.get(id)
    getDb()
      .prepare(
        "UPDATE projects SET provider = ?, model = ?, orchestrator_effort = ?, specialist_effort = ?, orchestrator_protocol = ?, specialist_protocol = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.provider ?? cur.provider,
        patch.model ?? cur.model,
        patch.orchestratorEffort ?? cur.orchestratorEffort,
        patch.specialistEffort ?? cur.specialistEffort,
        patch.orchestratorProtocol ?? cur.orchestratorProtocol ?? "chat_completions",
        patch.specialistProtocol ?? cur.specialistProtocol ?? "chat_completions",
        this.now(),
        id,
      )
    return this.emit(id)
  }

  /** Every project, the most recently created first. */
  list(): ProjectRow[] {
    return (getDb().prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Row[]).map(projectRow)
  }

  /** Forget a project's record; its tasks and sandboxes go with it. Its files are the caller's to remove first. */
  forget(id: string) {
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(id)
    this.push({ type: "projectDeleted", id })
  }

  /**
    Give every task that belongs to no project a project, one per source folder, named after that folder, with the app's
    data folder as its folder so the tasks' files stay where they are (R3.3). Their sandboxes follow their tasks.
  */
  adopt(defaults: {
    provider: ProviderId
    model: string
    orchestratorEffort: OrchestratorEffort
    specialistEffort: SpecialistEffort
    orchestratorProtocol?: ModelProtocol
    specialistProtocol?: ModelProtocol
  }): number {
    const roots = (getDb().prepare("SELECT source_root, MIN(created_at) AS at FROM tasks WHERE project_id IS NULL GROUP BY source_root").all() as Row[]).map(
      (r) => ({
        root: String(r.source_root),
        at: Number(r.at),
      }),
    )
    for (const { root, at } of roots) {
      const id = randomUUID()
      getDb()
        .prepare(
          `INSERT INTO projects (id, name, goal, target_path, target_kind, source_root, folder, owns_folder, provider, model,
            orchestrator_effort, specialist_effort, orchestrator_protocol, specialist_protocol, created_at, updated_at) VALUES (?, ?, 'understand', ?, 'folder', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          basename(root) || root,
          root,
          root,
          this.dataDir,
          defaults.provider,
          defaults.model,
          defaults.orchestratorEffort,
          defaults.specialistEffort,
          defaults.orchestratorProtocol ?? "chat_completions",
          defaults.specialistProtocol ?? "chat_completions",
          at,
          this.now(),
        )
      getDb().prepare("UPDATE tasks SET project_id = ? WHERE project_id IS NULL AND source_root = ?").run(id, root)
    }
    getDb().prepare("UPDATE sandboxes SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = sandboxes.created_by) WHERE project_id IS NULL").run()
    return roots.length
  }

  private emit(id: string): ProjectRow {
    const p = this.get(id)
    this.push({ type: "project", project: p })
    return p
  }
}

/**
  Delete a project (specs/projects R3.1, R3.2): refused while one of its tasks has a turn running; otherwise each task
  is deleted as a task is, then the project's sandboxes and their containers, then the folder the app created for it,
  then its record.
*/
export async function deleteProject(
  d: { store: ProjectStore; log: EventLog; runner: { remove(taskId: string): Promise<void> }; sandboxes: { remove(project: ProjectRow): Promise<void> } },
  id: string,
): Promise<void> {
  const project = d.store.get(id)
  if (d.store.deleting.has(id)) throw new Error("The project is already being deleted.")
  const tasks = d.log.projectTasks(id)
  if (tasks.some((t) => ["pending", "running", "waiting"].includes(t.state)))
    throw new Error("A task of this project is running; cancel it before deleting the project.")
  d.store.deleting.add(id)
  try {
    for (const t of tasks) await d.runner.remove(t.id)
    await d.sandboxes.remove(project)
    if (project.ownsFolder) removeTree(project.folder)
    d.store.forget(id)
  } finally {
    d.store.deleting.delete(id)
  }
}
