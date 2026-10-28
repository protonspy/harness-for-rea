import { z } from "zod"

/*
  The context package: everything a delegation carries to the specialist, and nothing else.
  Paths are relative to the task's source folder; the sandbox resolves and copies them.
*/

export const DEFAULT_REPORT_FORMAT = [
  "Answer the questions in order, then list what you changed, if anything.",
  "End with a section titled `Evidence`, one line per claim, exactly in this form:",
  "- <path>:<start line>-<end line> — <the claim that range supports>",
].join("\n")

const relPath = z.string().trim().min(1).max(500)

export const ContextPackageSchema = z
  .object({
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

export interface Evidence {
  path: string
  startLine: number
  endLine: number
  claim: string
  /** the path is one of the package's files and the range is well formed */
  checked: boolean
}

/** The `Evidence` lines of a report, each checked against the files the delegation was given. */
export function parseEvidence(report: string, files: string[]): Evidence[] {
  const known = new Set(files.map((f) => f.replace(/\\/g, "/")))
  const out: Evidence[] = []
  for (const m of report.matchAll(/^\s*[-*]\s+`?([^\s`:]+(?:\/[^\s`:]+)*)`?:(\d+)(?:-(\d+))?`?\s+[—–-]+\s+(.+)$/gm)) {
    const path = m[1].replace(/^\/work\//, "")
    const startLine = Number(m[2])
    const endLine = m[3] ? Number(m[3]) : startLine
    out.push({ path, startLine, endLine, claim: m[4].trim(), checked: known.has(path) && endLine >= startLine })
  }
  return out
}
