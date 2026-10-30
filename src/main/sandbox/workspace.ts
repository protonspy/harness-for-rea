import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { PathRejected, resolveRequested, UNSAFE_NAME } from "./paths"

/*
  One delegation's directories under the app's data folder (specs/task-sandbox R1):

    workspace/<uuid>/   copies of the named files, mounted at /work
    runs/<uuid>/        the rendered system prompt, mounted read-only at /run/hfr
    runs/<uuid>/ask/    the specialist's questions and the user's answers, mounted writable at /run/hfr-ask
    snapshots/<uuid>/   pristine copies and manifest.json {path: sha256}, never mounted
*/

/** Largest total size copied into one workspace. */
export const WORKSPACE_CAP = 100 * 1024 * 1024

/** The workspace folder holding the files the orchestrator prepared in its scratch (specs/chat R6.7). */
export const PREPARED = ".orchestrator"

/** A file from the orchestrator's scratch, by its path under the scratch. */
export interface PreparedFile {
  path: string
  content: Buffer
}

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

/** The run's two-way question channel (adr:0008-ask-the-user-from-the-specialist-over-the-run-channel). */
export function askDir(runDir: string): string {
  return join(runDir, "ask")
}

export function workspaceDirs(dataDir: string, id: string) {
  return { workspace: join(dataDir, "workspace", id), runDir: join(dataDir, "runs", id), snapshot: join(dataDir, "snapshots", id) }
}

/**
  Resolve every requested file first, so a rejected path creates nothing, then copy each into the
  workspace and the snapshot and write the manifest.
*/
export function prepareWorkspace(dataDir: string, sourceRoot: string, requested: string[], prepared: PreparedFile[] = []): Workspace {
  const resolved = new Map<string, string>()
  // Windows paths are case-insensitive: `A.ts` and `a.ts` are one file and must be one copy.
  const seen = new Set<string>()
  let total = 0
  const preparedNames = new Set(prepared.map((p) => `${PREPARED}/${p.path}`))
  for (const r of requested) {
    if (preparedNames.has(r)) continue
    const { rel, abs } = resolveRequested(sourceRoot, r)
    // The folder belongs to the orchestrator's files, in any case, so no source file shares it.
    if (rel.toLowerCase().startsWith(`${PREPARED}/`)) throw new PathRejected(r, `is under ${PREPARED}/, which holds the files the orchestrator prepares`)
    const key = process.platform === "win32" ? rel.toLowerCase() : rel
    if (seen.has(key)) continue
    seen.add(key)
    total += statSync(abs).size
    if (total > WORKSPACE_CAP) throw new PathRejected(r, `the files exceed the ${WORKSPACE_CAP / 1024 / 1024} MB workspace limit`)
    resolved.set(rel, abs)
  }
  for (const p of prepared) {
    if (p.path.split("/").some((name) => !name || name === "." || name === ".." || UNSAFE_NAME.test(name)))
      throw new PathRejected(p.path, "is not a name the workspace may hold")
    total += p.content.length
    if (total > WORKSPACE_CAP) throw new PathRejected(p.path, `the files exceed the ${WORKSPACE_CAP / 1024 / 1024} MB workspace limit`)
  }
  const id = randomUUID()
  const dirs = workspaceDirs(dataDir, id)
  for (const d of [...Object.values(dirs), askDir(dirs.runDir)]) mkdirSync(d, { recursive: true, mode: 0o700 })
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
    // What the orchestrator prepared goes to the specialist only: no snapshot, no manifest, never a patch.
    for (const p of prepared) {
      const rel = `${PREPARED}/${p.path}`
      const target = join(dirs.workspace, ...rel.split("/"))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, p.content)
      files.push({ path: rel, sha256: sha256(p.content), size: p.content.length })
    }
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
