import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { PathRejected, resolveRequested } from "./paths"

/*
  One delegation's directories under the app's data folder (specs/task-sandbox R1):

    workspace/<uuid>/   copies of the named files, mounted at /work
    runs/<uuid>/        the rendered system prompt, mounted read-only at /run/hfr
    snapshots/<uuid>/   pristine copies and manifest.json {path: sha256}, never mounted
*/

/** Largest total size copied into one workspace. */
export const WORKSPACE_CAP = 100 * 1024 * 1024

export interface CopiedFile {
  path: string
  sha256: string
  size: number
}

export interface Workspace {
  id: string
  workspace: string
  runDir: string
  snapshot: string
  files: CopiedFile[]
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export function workspaceDirs(dataDir: string, id: string) {
  return { workspace: join(dataDir, "workspace", id), runDir: join(dataDir, "runs", id), snapshot: join(dataDir, "snapshots", id) }
}

/**
  Resolve every requested file first, so a rejected path creates nothing, then copy each into the
  workspace and the snapshot and write the manifest.
*/
export function prepareWorkspace(dataDir: string, sourceRoot: string, requested: string[]): Workspace {
  const resolved = new Map<string, string>()
  let total = 0
  for (const r of requested) {
    const { rel, abs } = resolveRequested(sourceRoot, r)
    if (resolved.has(rel)) continue
    total += statSync(abs).size
    if (total > WORKSPACE_CAP) throw new PathRejected(r, `the files exceed the ${WORKSPACE_CAP / 1024 / 1024} MB workspace limit`)
    resolved.set(rel, abs)
  }
  const id = randomUUID()
  const dirs = workspaceDirs(dataDir, id)
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 })
  const files: CopiedFile[] = []
  try {
    for (const [rel, abs] of resolved) {
      const data = readFileSync(abs)
      for (const target of [join(dirs.workspace, rel), join(dirs.snapshot, "files", rel)]) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, data)
      }
      files.push({ path: rel, sha256: sha256(data), size: data.length })
    }
    writeFileSync(join(dirs.snapshot, "manifest.json"), JSON.stringify(Object.fromEntries(files.map((f) => [f.path, f.sha256])), null, 2))
  } catch (e) {
    discardWorkspace(dataDir, id)
    throw e
  }
  return { id, ...dirs, files }
}

export function readManifest(snapshot: string): Record<string, string> {
  return JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8")) as Record<string, string>
}

/** Write the run's rendered system prompt where the container reads it, outside /work. */
export function writeSystemPrompt(ws: Workspace, system: string): string {
  const file = join(ws.runDir, "system.md")
  writeFileSync(file, system, { encoding: "utf8", mode: 0o600 })
  return file
}

/** Delete the workspace, run directory and snapshot of a delegation (specs/task-sandbox R1.4). */
export function discardWorkspace(dataDir: string, id: string) {
  for (const d of Object.values(workspaceDirs(dataDir, id))) rmSync(d, { recursive: true, force: true })
}
