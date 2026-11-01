import type { Vector } from "@shared/contract"

/*
  Replaying an analysis's test vectors against the orchestrator's reimplementation (specs/vector-replay R2):
  the shell line that runs one vector, and the comparison of what came back with what was observed.
*/

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

/** A value decoded inside the line: base64 has no character the shell reads in single quotes (R2.5). */
const decoded = (s: string) => `"$(printf %s '${b64(s)}' | base64 -d)"`

/**
  The line that runs `command` on one vector: its standard input piped in and each argument appended, both
  decoded from base64 inside the line, so nothing a vector holds is ever shell text (R2.5). Standard error is
  dropped so the output compared is standard output alone. A command substitution drops an argument's trailing
  newlines, which no recorded argument is expected to end with.
*/
export function replayCommand(command: string, v: Vector): string {
  const args = v.args.map(decoded).join(" ")
  return `printf %s '${b64(v.stdin)}' | base64 -d | ${command}${args ? ` ${args}` : ""} 2>/dev/null`
}

/** How much of an output a differing outcome shows. */
const SHOWN = 2000
const shown = (s: string) => (s.length > SHOWN ? `${s.slice(0, SHOWN)}…` : s)

export interface Outcome {
  name: string
  pass: boolean
  stdout?: { expected: string; got: string }
  exitCode?: { expected: number; got: number }
}

/** One vector's outcome: a pass when standard output and the exit code match byte for byte, else what differed (R2.2). */
export function compare(v: Vector, stdout: string, exitCode: number): Outcome {
  const out: Outcome = { name: v.name, pass: stdout === v.stdout && exitCode === v.exitCode }
  if (stdout !== v.stdout) out.stdout = { expected: shown(v.stdout), got: shown(stdout) }
  if (exitCode !== v.exitCode) out.exitCode = { expected: v.exitCode, got: exitCode }
  return out
}
