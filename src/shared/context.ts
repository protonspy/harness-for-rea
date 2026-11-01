import { z } from "zod"

/*
  The context package: everything a delegation carries to the specialist, and nothing else.
  Paths are relative to the task's source folder; the sandbox resolves and copies them.
*/

export const DEFAULT_REPORT_FORMAT = [
  "Answer the questions in order, then list what you changed, if anything.",
  "End with a section titled `Evidence`, one line per claim, in one of these forms:",
  "- <path>:<start line>-<end line> — <the claim that range supports>",
  "- <path>@0x<address> — <the claim that address in a binary supports>",
  "- ev_<64 hex> — <the claim that REA evidence record supports>",
  "- unk_<64 hex> — <what that REA unknown leaves open>",
].join("\n")

const relPath = z.string().trim().min(1).max(500)

export const ContextPackageSchema = z
  .object({
    brief: z
      .string()
      .trim()
      .min(1)
      .max(8000)
      .describe(
        "Your technical prompt to the specialist, in English, read first: what the artifact is (format, platform, architecture, language, toolchain, versions), what is already established about it, and what this step must map or discover. Only the technical scope: never the user, their request, their intent or why the work is done, and never an invented ownership, authorization or purpose.",
      ),
    objective: z.string().trim().min(1).max(4000).describe("What this one step must find out or change, stated on its own."),
    mode: z
      .enum(["read", "modify"])
      .default("read")
      .describe("read: the files are mounted read-only. modify: the specialist may edit them and a patch is proposed."),
    files: z.array(relPath).min(1).max(200).describe("Files the specialist may see, relative to the source folder."),
    excerpts: z
      .array(
        z.object({
          path: relPath,
          startLine: z.number().int().min(1),
          endLine: z.number().int().min(1),
          note: z.string().max(500).default(""),
        }),
      )
      .max(50)
      .default([])
      .describe("Line ranges to look at first."),
    environment: z.array(z.string().max(500)).max(30).default([]).describe("Facts about the environment: language versions, build system, platform."),
    questions: z.array(z.string().max(1000)).max(20).default([]).describe("The questions the report must answer."),
    constraints: z.array(z.string().max(1000)).max(20).default([]).describe("What the specialist must not do or must respect."),
    reportFormat: z.string().max(2000).default(DEFAULT_REPORT_FORMAT).describe("How the report is laid out."),
  })
  .strict()

export type ContextPackage = z.output<typeof ContextPackageSchema>

/** Evidence is read from at most this much of a report, and only from lines this long. */
const REPORT_CAP = 256 * 1024
const LINE_CAP = 2000

export interface Evidence {
  /** a line range of a file, an address in a binary, or an REA evidence or unknown id (specs/rea-native R3.1) */
  kind?: "lines" | "address" | "rea"
  /** the file cited; empty for an REA id */
  path: string
  startLine: number
  endLine: number
  /** the address (`0x…`) or the REA id */
  ref?: string
  claim: string
  /** a range or address in one of the package's files, or an REA id in its exact form */
  checked: boolean
}

/** The `Evidence` lines of a report, each checked against the files the delegation was given. */
export function parseEvidence(report: string, files: string[]): Evidence[] {
  const known = new Set(files.map((f) => f.replace(/\\/g, "/")))
  const out: Evidence[] = []
  for (const line of report.slice(0, REPORT_CAP).split("\n")) {
    if (line.length > LINE_CAP) continue
    const rea = /^\s*[-*]\s+`?((?:ev|unk)_[0-9a-f]{64})`?\s+[—–-]+\s+(.+)$/.exec(line)
    if (rea) {
      out.push({ kind: "rea", path: "", startLine: 0, endLine: 0, ref: rea[1], claim: rea[2].trim(), checked: true })
      continue
    }
    const at = /^\s*[-*]\s+`?([^\s`@:]+)@(0x[0-9a-fA-F]{1,16})`?\s+[—–-]+\s+(.+)$/.exec(line)
    if (at) {
      const path = at[1].replace(/^\/work\//, "")
      out.push({ kind: "address", path, startLine: 0, endLine: 0, ref: at[2].toLowerCase(), claim: at[3].trim(), checked: known.has(path) })
      continue
    }
    // One path token with no nested repetition, on a line of bounded length: matching stays linear.
    const m = /^\s*[-*]\s+`?([^\s`:]+)`?:(\d+)(?:-(\d+))?`?\s+[—–-]+\s+(.+)$/.exec(line)
    if (!m) continue
    const path = m[1].replace(/^\/work\//, "")
    const startLine = Number(m[2])
    const endLine = m[3] ? Number(m[3]) : startLine
    out.push({ kind: "lines", path, startLine, endLine, claim: m[4].trim(), checked: known.has(path) && endLine >= startLine })
  }
  return out
}
