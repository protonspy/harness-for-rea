import { dirname, join } from "node:path"

/*
  Where the CLI finds the sources it builds the specialist's image from (specs/release R1.3, R2.4): `sandbox/specialist`
  beside it however it was installed — named by the npm shim, next to a compiled binary, or in the repository when
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

export const USAGE = `Usage: harness-for-rea [--version | --help]

The terminal UI of Harness for REA: projects, tasks and their chat timeline in your terminal, on the same data
folder as the desktop app — which must not be open at the same time.

Environment:
  HFR_DATA_DIR      the data folder (default: the desktop app's)
  HFR_SANDBOX_DIR   the folder holding specialist/Dockerfile`

/** What a flag asks for, answered before anything starts; null to run the TUI. */
export function answerFlags(argv: string[], version: string): string | null {
  if (argv.includes("--version") || argv.includes("-v")) return `harness-for-rea ${version}`
  if (argv.includes("--help") || argv.includes("-h")) return USAGE
  return null
}
