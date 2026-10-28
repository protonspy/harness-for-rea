import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

/*
  A requested path is relative to the source root and stays under it: no `..`, no absolute,
  drive-relative or UNC form, and no symbolic link or junction anywhere along it (specs/task-sandbox R1.3).
*/

export class PathRejected extends Error {
  readonly path: string

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`)
    this.name = "PathRejected"
    this.path = path
  }
}

export interface Resolved {
  /** relative to the root, with forward slashes */
  rel: string
  abs: string
}

function segments(requested: string): string[] {
  if (!requested || requested.includes("\0")) throw new PathRejected(requested, "empty or contains a NUL character")
  if (isAbsolute(requested) || /^[A-Za-z]:/.test(requested) || /^[\\/]/.test(requested)) throw new PathRejected(requested, "absolute paths are not allowed")
  const parts = requested.split(/[\\/]+/).filter((p) => p && p !== ".")
  if (parts.includes("..")) throw new PathRejected(requested, "`..` is not allowed")
  if (!parts.length) throw new PathRejected(requested, "names no file")
  return parts
}

function inside(root: string, abs: string): boolean {
  const r = relative(root, abs)
  return r !== "" && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)
}

/** Walk each existing component under the root: none may be a link. Returns how many exist. */
function walk(root: string, parts: string[], requested: string): number {
  let cur = root
  let n = 0
  for (const p of parts) {
    cur = join(cur, p)
    let st
    try {
      st = lstatSync(cur)
    } catch {
      return n
    }
    if (st.isSymbolicLink()) throw new PathRejected(requested, "goes through a symbolic link or junction")
    n++
  }
  return n
}

function realRoot(root: string): string {
  return realpathSync.native(resolve(root))
}

/** An existing regular file under the root, to be copied in. */
export function resolveRequested(root: string, requested: string): Resolved {
  const parts = segments(requested)
  const base = realRoot(root)
  const abs = join(base, ...parts)
  if (!inside(base, abs)) throw new PathRejected(requested, "resolves outside the source root")
  if (walk(base, parts, requested) !== parts.length) throw new PathRejected(requested, "does not exist")
  if (!lstatSync(abs).isFile()) throw new PathRejected(requested, "is not a regular file")
  if (!inside(base, realpathSync.native(abs))) throw new PathRejected(requested, "resolves outside the source root")
  return { rel: parts.join("/"), abs }
}

/** A file under the root that may not exist yet, to be written by an approved patch. */
export function resolveTarget(root: string, requested: string): Resolved {
  const parts = segments(requested)
  const base = realRoot(root)
  const abs = join(base, ...parts)
  if (!inside(base, abs)) throw new PathRejected(requested, "resolves outside the source root")
  const existing = walk(base, parts, requested)
  if (existing === parts.length && !lstatSync(abs).isFile()) throw new PathRejected(requested, "is not a regular file")
  return { rel: parts.join("/"), abs }
}
