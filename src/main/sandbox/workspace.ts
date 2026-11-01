import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { PathRejected, resolveRequested, UNSAFE_NAME } from "./paths"

/*
  One delegation's directories under the app's data folder (specs/task-sandbox R1):

    workspace/<uuid>/   copies of the named files, mounted at /work
    runs/<uuid>/        the rendered system prompt, mounted read-only at /run/hfr
    runs/<uuid>/ask/    the specialist's questions and the user's answers, mounted writable at /run/hfr-ask
    snapshots/<uuid>/   pristine copies and manifest.json {path: sha256}, never mounted
*/

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
  /** what the specialist extracts, builds or exports, mounted at /root/out (specs/rea-native R2.4) */
  out: string
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
  return {
    workspace: join(dataDir, "workspace", id),
    runDir: join(dataDir, "runs", id),
    snapshot: join(dataDir, "snapshots", id),
    out: join(dataDir, "outputs", id),
  }
}

interface Plan {
  /** source files by their path relative to the source folder */
  resolved: Map<string, string>
  prepared: PreparedFile[]
}

/**
  Resolve every requested file and check the total against the cap before anything is written, so a rejected
  path or a call past the cap copies nothing (specs/specialist-sandbox R2.2, R2.3).
*/
function planFiles(sourceRoot: string, requested: string[], prepared: PreparedFile[], cap: number, limit: string): Plan {
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
    if (total > cap) throw new PathRejected(r, `the files exceed the ${limit}`)
    resolved.set(rel, abs)
  }
  for (const p of prepared) {
    if (p.path.split("/").some((name) => !name || name === "." || name === ".." || UNSAFE_NAME.test(name)))
      throw new PathRejected(p.path, "is not a name the workspace may hold")
    total += p.content.length
    if (total > cap) throw new PathRejected(p.path, `the files exceed the ${limit}`)
  }
  return { resolved, prepared }
}

/**
  Refuse a target whose folders under the workspace include a link: a sandbox's root processes can plant one in
  /work after it starts, and the app must not write through it to the host.
*/
function assertNoLink(root: string, rel: string) {
  let dir = root
  for (const name of rel.split("/").slice(0, -1)) {
    dir = join(dir, name)
    let st
    try {
      st = lstatSync(dir)
    } catch {
      return
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PathRejected(rel, `cannot be written: ${name} in the workspace is not a folder`)
  }
  const target = join(root, rel)
  if (existsSync(target) && !lstatSync(target).isFile()) throw new PathRejected(rel, "cannot be written: it is not a file in the workspace")
}

/** Copy planned files into the workspace; source files also into the snapshot and its manifest. */
function writeFiles(ws: Workspace, plan: Plan): CopiedFile[] {
  for (const rel of [...plan.resolved.keys(), ...plan.prepared.map((p) => `${PREPARED}/${p.path}`)]) assertNoLink(ws.workspace, rel)
  const manifest = readManifest(ws.snapshot)
  const files: CopiedFile[] = []
  for (const [rel, abs] of plan.resolved) {
    const data = readFileSync(abs)
    for (const target of [join(ws.workspace, rel), join(ws.snapshot, "files", rel)]) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
    }
    manifest[rel] = sha256(data)
    files.push({ path: rel, sha256: manifest[rel], size: data.length })
  }
  writeManifest(ws.snapshot, manifest)
  // What the orchestrator prepared goes to the specialist only: no snapshot, no manifest, never a patch.
  for (const p of plan.prepared) {
    const rel = `${PREPARED}/${p.path}`
    const target = join(ws.workspace, ...rel.split("/"))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, p.content)
    files.push({ path: rel, sha256: sha256(p.content), size: p.content.length })
  }
  ws.files.push(...files)
  return files
}

function writeManifest(snapshot: string, manifest: Record<string, string>) {
  writeFileSync(join(snapshot, "manifest.json"), JSON.stringify(manifest, null, 2))
}

/** The directories of a workspace with an empty snapshot, under a fresh UUID unless one is given. */
export function createWorkspace(dataDir: string, id: string = randomUUID()): Workspace {
  const dirs = workspaceDirs(dataDir, id)
  for (const d of [...Object.values(dirs), askDir(dirs.runDir)]) mkdirSync(d, { recursive: true, mode: 0o700 })
  writeManifest(dirs.snapshot, {})
  return { id, ...dirs, files: [] }
}

/**
  Resolve every requested file first, so a rejected path creates nothing, then copy each into the
  workspace and the snapshot and write the manifest.
*/
export function prepareWorkspace(dataDir: string, sourceRoot: string, requested: string[], prepared: PreparedFile[] = []): Workspace {
  const plan = planFiles(sourceRoot, requested, prepared, Infinity, "")
  const ws = createWorkspace(dataDir)
  try {
    writeFiles(ws, plan)
  } catch (e) {
    discardWorkspace(dataDir, ws.id)
    throw e
  }
  return ws
}

/**
  Copy more files into an existing workspace, a sandbox's (specs/specialist-sandbox R2.1–R2.3): every path is
  resolved and the total checked against `cap` bytes before anything is written.
*/
export function addFiles(ws: Workspace, sourceRoot: string, requested: string[], prepared: PreparedFile[], cap: number, limit: string): CopiedFile[] {
  return writeFiles(ws, planFiles(sourceRoot, requested, prepared, cap, limit))
}

/**
  Take the workspace as it stands as the snapshot for the files a patch changed, so the next patch from the same
  sandbox is made against it (specs/specialist-sandbox R4.5).
*/
export function rebaseSnapshot(ws: Workspace, changes: { path: string; status: "added" | "modified" | "deleted" }[]) {
  const manifest = readManifest(ws.snapshot)
  for (const c of changes) {
    const target = join(ws.snapshot, "files", c.path)
    if (c.status === "deleted") {
      delete manifest[c.path]
      rmSync(target, { force: true })
      continue
    }
    // Only a regular file becomes the base: what the sandbox left in its place is dropped from the snapshot.
    const source = join(ws.workspace, c.path)
    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) {
      delete manifest[c.path]
      rmSync(target, { force: true })
      continue
    }
    const data = readFileSync(source)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    manifest[c.path] = sha256(data)
  }
  writeManifest(ws.snapshot, manifest)
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
