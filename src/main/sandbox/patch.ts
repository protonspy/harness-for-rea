import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import type { PatchFile } from "@shared/types"
import { countChanges, unifiedDiff } from "./diff"
import { PathRejected, resolveTarget, UNSAFE_NAME } from "./paths"
import { PREPARED, readManifest, sha256, type Workspace } from "./workspace"

/*
  A modify-mode delegation's changes (specs/task-sandbox R4): the difference between the workspace and
  its snapshot, kept under patches/<id>/ with the new contents and each file's SHA-256 at copy time,
  so the workspace can be discarded while the patch waits for approval. Applying it checks every
  original against that SHA-256 first and changes nothing if any differs.
*/

export interface PatchChange {
  path: string
  status: PatchFile["status"]
  /** the original's SHA-256 when it was copied in; null for a file the specialist added */
  base: string | null
}

export interface ProposedPatch {
  id: string
  files: PatchFile[]
  diff: string
  changes: PatchChange[]
  /** links or other non-files the specialist left in the workspace, not part of the patch */
  skipped: string[]
}

/** Largest total size of the files a patch is built from. */
export const PATCH_CAP = 200 * 1024 * 1024

export class PatchConflict extends Error {
  readonly conflicts: string[]

  constructor(conflicts: string[]) {
    super(`The originals changed since they were copied, so the patch was not applied: ${conflicts.join(", ")}`)
    this.name = "PatchConflict"
    this.conflicts = conflicts
  }
}

export function patchDir(dataDir: string, id: string): string {
  return join(dataDir, "patches", id)
}

/**
  Where a written file could run later without anyone reading it: a `.git` folder at any depth, in any
  case (NTFS ignores it) or by its 8.3 short name.
*/
const GUARDED = /(?:^|\/)(?:\.git|git~\d+)(?:\/|$)/i

function walk(root: string, dir: string, files: string[], skipped: string[]) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = relative(root, abs).split("\\").join("/")
    if (rel.toLowerCase() === PREPARED) continue
    const st = lstatSync(abs)
    if (st.isSymbolicLink() || UNSAFE_NAME.test(name) || GUARDED.test(rel)) skipped.push(rel)
    else if (st.isDirectory()) walk(root, abs, files, skipped)
    else if (st.isFile()) files.push(rel)
    else skipped.push(rel)
  }
}

const isBinary = (b: Buffer) => b.includes(0)

/** Control and bidirectional characters shown as escapes, so the diff reviewed is the content applied. */
export function visible(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`,
  )
}

function textDiff(before: Buffer | null, after: Buffer | null, path: string, status: PatchFile["status"]): string {
  if ((before && isBinary(before)) || (after && isBinary(after))) {
    const size = after ? `${after.length} bytes, sha256 ${sha256(after)}` : "removed"
    return `--- a/${path}\n+++ b/${path}\nBinary file ${status}: ${size}`
  }
  return visible(unifiedDiff(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "", path, status))
}

/** The patch a completed modify-mode step proposes, or null when nothing changed. */
export function makePatch(dataDir: string, ws: Workspace): ProposedPatch | null {
  const manifest = readManifest(ws.snapshot)
  const present: string[] = []
  const skipped: string[] = []
  walk(ws.workspace, ws.workspace, present, skipped)
  const changes: PatchChange[] = []
  const contents = new Map<string, Buffer>()
  let total = 0
  for (const rel of present.sort()) {
    total += lstatSync(join(ws.workspace, rel)).size
    if (total > PATCH_CAP) throw new Error(`The workspace grew past ${PATCH_CAP / 1024 / 1024} MB, so no patch was proposed.`)
    const data = readFileSync(join(ws.workspace, rel))
    const base = manifest[rel]
    // A text original that came back with NUL bytes would hide its new content behind "binary".
    if (base !== undefined && isBinary(data) && !isBinary(readFileSync(join(ws.snapshot, "files", rel)))) {
      skipped.push(rel)
      continue
    }
    if (base === undefined) changes.push({ path: rel, status: "added", base: null })
    else if (sha256(data) !== base) changes.push({ path: rel, status: "modified", base })
    else continue
    contents.set(rel, data)
  }
  for (const rel of Object.keys(manifest).sort())
    if (!present.includes(rel) && !skipped.includes(rel)) changes.push({ path: rel, status: "deleted", base: manifest[rel] })
  if (!changes.length) return null
  return { ...writePatch(dataDir, changes, contents, (path) => readFileSync(join(ws.snapshot, "files", path))), skipped }
}

/**
  The patch the orchestrator proposes from the code it wrote (specs/chat R6.6): each file's new
  contents against the original as it is now, or added where none exists, or null when nothing differs.
  A target outside the source, through a link, or with an unsafe or guarded name is refused, and so
  is binary content, which the diff the user reviews could not show.
*/
export function makePatchFrom(dataDir: string, sourceRoot: string, files: { path: string; content: Buffer }[]): ProposedPatch | null {
  const changes: PatchChange[] = []
  const contents = new Map<string, Buffer>()
  const originals = new Map<string, Buffer>()
  // Windows paths are case-insensitive: `A.ts` and `a.ts` are one file.
  const named = new Set<string>()
  let total = 0
  for (const f of files) {
    const { rel, abs } = resolveTarget(sourceRoot, f.path)
    if (rel.split("/").some((name) => UNSAFE_NAME.test(name)) || GUARDED.test(rel) || rel.toLowerCase().startsWith(`${PREPARED}/`))
      throw new PathRejected(f.path, "is not a name a patch may write")
    if (named.has(rel.toLowerCase())) throw new PathRejected(f.path, "is named twice")
    named.add(rel.toLowerCase())
    if (isBinary(f.content)) throw new PathRejected(f.path, "is binary; only text the user can review in the diff can be proposed")
    total += f.content.length
    if (total > PATCH_CAP) throw new Error(`The files pass ${PATCH_CAP / 1024 / 1024} MB, so no patch was proposed.`)
    const before = existsSync(abs) ? readFileSync(abs) : null
    if (before && sha256(before) === sha256(f.content)) continue
    changes.push({ path: rel, status: before ? "modified" : "added", base: before ? sha256(before) : null })
    contents.set(rel, f.content)
    if (before) originals.set(rel, before)
  }
  if (!changes.length) return null
  return writePatch(dataDir, changes, contents, (path) => originals.get(path)!)
}

/** Keeps a patch's new contents and changes under patches/<id>/ and renders its diff. */
function writePatch(dataDir: string, changes: PatchChange[], contents: Map<string, Buffer>, original: (path: string) => Buffer): ProposedPatch {
  const id = randomUUID()
  const dir = patchDir(dataDir, id)
  const files: PatchFile[] = []
  const diffs: string[] = []
  for (const c of changes) {
    const after = contents.get(c.path) ?? null
    if (after) {
      const target = join(dir, "files", c.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, after)
    }
    const before = c.status === "added" ? null : original(c.path)
    const d = textDiff(before, after, c.path, c.status)
    diffs.push(d)
    files.push({ path: c.path, status: c.status, ...countChanges(d) })
  }
  writeFileSync(join(dir, "patch.json"), JSON.stringify({ changes }, null, 2))
  return { id, files, diff: diffs.join("\n"), changes, skipped: [] }
}

/** Originals whose content is not what was copied in (or, for an added file, that now exist). */
export function conflictsOf(dataDir: string, id: string, sourceRoot: string): string[] {
  const { changes } = JSON.parse(readFileSync(join(patchDir(dataDir, id), "patch.json"), "utf8")) as { changes: PatchChange[] }
  const out: string[] = []
  for (const c of changes) {
    const { abs } = resolveTarget(sourceRoot, c.path)
    const now = existsSync(abs) ? sha256(readFileSync(abs)) : null
    if (now !== c.base) out.push(c.path)
  }
  return out
}

/**
  Apply an approved patch to the originals (specs/task-sandbox R4.2, R4.3). Throws PatchConflict,
  touching nothing, when any original differs from its SHA-256 at copy time.
*/
export function applyPatch(dataDir: string, id: string, sourceRoot: string): string[] {
  const dir = patchDir(dataDir, id)
  const { changes } = JSON.parse(readFileSync(join(dir, "patch.json"), "utf8")) as { changes: PatchChange[] }
  const bad = conflictsOf(dataDir, id, sourceRoot)
  if (bad.length) throw new PatchConflict(bad)
  for (const c of changes) {
    const { abs } = resolveTarget(sourceRoot, c.path)
    if (c.status === "deleted") {
      rmSync(abs, { force: true })
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.hfr-${id.slice(0, 8)}.tmp`
    writeFileSync(tmp, readFileSync(join(dir, "files", c.path)))
    renameSync(tmp, abs)
  }
  return changes.map((c) => c.path)
}

export function discardPatch(dataDir: string, id: string) {
  rmSync(patchDir(dataDir, id), { recursive: true, force: true })
}
