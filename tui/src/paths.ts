import { dirname, join } from "node:path"

/*
  Where the CLI finds its `sandbox/` (specs/release R1.3, R2.4) — `specialist/` it builds the specialist's image from,
  the integrations' `mcp/` server and Cheat Engine's `cheat-engine/` bridge — beside it however it was installed — named by the npm shim, next to a compiled binary, or in the repository when
  run from source — and what it answers before the core starts.
*/

export interface Where {
  env: NodeJS.ProcessEnv
  /** the running executable: a compiled binary, or Bun itself */
  execPath: string
  /** this module's directory: `tui/src` from source, a virtual folder inside a compiled binary */
  moduleDir: string
  exists(path: string): boolean
}

/** The folder holding `specialist/`, or null when none of the places has it. */
export function sandboxDirFor(w: Where): string | null {
  const candidates = [w.env.HFR_SANDBOX_DIR, join(dirname(w.execPath), "sandbox"), join(w.moduleDir, "..", "sandbox"), join(w.moduleDir, "..", "..", "sandbox")]
  return candidates.find((c): c is string => !!c && w.exists(join(c, "specialist", "Dockerfile"))) ?? null
}

export const USAGE = `Usage: harness-for-rea [path] [--continue | --resume] [--theme dark|light]
       harness-for-rea --version | --help

The terminal UI of Harness for REA. Opens the folder it is run in, or the path given, as a project's target:
the project on it, a choice among several, or a new one to create. Runs beside the desktop app and other
terminal UIs on the same data folder.

  --continue   open the folder's project's most recent task
  --resume     pick one of the folder's project's tasks to open
  --theme      dark (the default) or light; also HFR_THEME

Environment:
  HFR_DATA_DIR      the data folder (default: the desktop app's)
  HFR_SANDBOX_DIR   the folder holding specialist/, mcp/ and cheat-engine/`

export interface Args {
  /** the target folder as given, or null for the folder it is run in */
  path: string | null
  continue: boolean
  resume: boolean
  theme: "dark" | "light" | null
}

/**
  What the command line asks for (specs/tui-launch R1.1, R2.2, R2.3, R2.5): `print` is answered before anything starts
  and exits with `code`; otherwise the TUI runs with `args`.
*/
export function parseArgs(argv: string[], version: string): { print: string; code: number } | { args: Args } {
  if (argv.includes("--version") || argv.includes("-v")) return { print: `harness-for-rea ${version}`, code: 0 }
  if (argv.includes("--help") || argv.includes("-h")) return { print: USAGE, code: 0 }
  const bad = (why: string) => ({ print: `${why}\n\n${USAGE}`, code: 2 })
  const args: Args = { path: null, continue: false, resume: false, theme: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--continue" || a === "-c") args.continue = true
    else if (a === "--resume" || a === "-r") args.resume = true
    else if (a === "--theme" || a.startsWith("--theme=")) {
      const v = a.includes("=") ? a.slice("--theme=".length) : argv[++i]
      if (v !== "dark" && v !== "light") return bad("--theme takes dark or light.")
      args.theme = v
    } else if (a.startsWith("-")) return bad(`Unknown option ${a}.`)
    else if (args.path === null) args.path = a
    else return bad(`Give one folder, not ${args.path} and ${a}.`)
  }
  if (args.continue && args.resume) return bad("Give --continue or --resume, not both.")
  return { args }
}
