import { posix, win32 } from "node:path"
import type { ProjectRow } from "../../../src/shared/types"

/*
  The folder the TUI is run in as a project's target (specs/tui-launch R1): which projects already have it, whether it
  is too broad to mount without the user typing it, and what the TUI opens first. Pure: the paths, the platform and
  the data folder come in as arguments.
*/

export type Platform = "win32" | "darwin" | "linux"

export interface Where {
  platform: Platform
  home: string
  /** the app's data folder */
  dataDir: string
  env: Record<string, string | undefined>
}

export type Risk = { kind: "ok" } | { kind: "confirm"; why: string } | { kind: "refuse"; why: string }

const pathOf = (p: Platform) => (p === "win32" ? win32 : posix)

/** A path normalised for comparison: resolved, without a trailing separator, lower-cased on Windows. */
function norm(path: string, platform: Platform): string {
  const lib = pathOf(platform)
  let out = lib.resolve(platform === "win32" ? path.replace(/\//g, "\\") : path)
  const root = lib.parse(out).root
  if (out.length > root.length) out = out.replace(/[\\/]+$/, "")
  return platform === "win32" ? out.toLowerCase() : out
}

export function samePath(a: string, b: string, platform: Platform): boolean {
  return norm(a, platform) === norm(b, platform)
}

/** Whether `inner` is `outer` or inside it. */
function within(inner: string, outer: string, platform: Platform): boolean {
  const i = norm(inner, platform)
  const o = norm(outer, platform)
  const sep = platform === "win32" ? "\\" : "/"
  return i === o || i.startsWith(o.endsWith(sep) ? o : o + sep)
}

/**
  Why a folder is too broad to mount into a sandbox without the user typing it (R1.5), or that it is the app's data
  folder, which is refused (R1.6): every task's files, the database and the keys' records live there.
*/
export function riskOf(folder: string, w: Where): Risk {
  const { platform } = w
  const lib = pathOf(platform)
  if (within(folder, w.dataDir, platform)) return { kind: "refuse", why: "This is the app's own data folder, which no sandbox may mount." }
  const f = norm(folder, platform)
  if (f === norm(lib.parse(f).root, platform)) return { kind: "confirm", why: platform === "win32" ? "the root of a drive" : "the root of the file system" }
  if (f === norm(w.home, platform)) return { kind: "confirm", why: "your home folder" }
  if (lib.basename(f).toLowerCase() === "downloads" && norm(lib.dirname(f), platform) === norm(w.home, platform))
    return { kind: "confirm", why: "a Downloads folder" }
  if (within(w.dataDir, folder, platform)) return { kind: "confirm", why: "a folder holding the app's data" }
  return { kind: "ok" }
}

/** The projects whose target is the folder, newest first (R1.2, R1.3). */
export function matchProjects(projects: ProjectRow[], folder: string, platform: Platform): ProjectRow[] {
  return projects.filter((p) => samePath(p.targetPath, folder, platform)).sort((a, b) => b.createdAt - a.createdAt)
}

export type LaunchPlan =
  | { kind: "setup" }
  | { kind: "open"; projectId: string; then?: "continue" | "resume" }
  | { kind: "pick"; projectIds: string[] }
  | { kind: "create"; confirm: string | null }
  | { kind: "refuse"; why: string }

/** What the TUI opens first for the folder (R1.2–R1.6, R2.1–R2.3). */
export function launchPlan(o: {
  folder: string
  platform: Platform
  projects: ProjectRow[]
  risk: Risk
  setupCompleted: boolean
  continue: boolean
  resume: boolean
}): LaunchPlan {
  if (!o.setupCompleted) return { kind: "setup" }
  const matches = matchProjects(o.projects, o.folder, o.platform)
  if (matches.length === 1) {
    const then = o.continue ? "continue" : o.resume ? "resume" : undefined
    return then ? { kind: "open", projectId: matches[0].id, then } : { kind: "open", projectId: matches[0].id }
  }
  if (matches.length > 1) return { kind: "pick", projectIds: matches.map((p) => p.id) }
  if (o.risk.kind === "refuse") return { kind: "refuse", why: o.risk.why }
  return { kind: "create", confirm: o.risk.kind === "confirm" ? o.risk.why : null }
}
