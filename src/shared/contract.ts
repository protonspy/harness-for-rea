import { z } from "zod"

/*
  The analysis contract (specs/analysis-contract R1): the JSON block that ends a specialist's report —
  the functions mapped, the constants found, each tied to a source or marked estimated, and the
  unknowns opened or closed. Read by the app, never trusted as prose.
*/

/** What a claim rests on: `path:12-30`, `path@0x401000`, or an REA `ev_…` / `unk_…` id. */
const Source = z.string().trim().min(1).max(300)
const Text = z.string().trim().min(1).max(2000)
const List = z.array(z.string().trim().max(500)).max(50).default([])

export const ContractSchema = z
  .object({
    functions: z
      .array(z.object({ name: z.string().trim().min(1).max(300), inputs: List, outputs: List, sideEffects: List, source: Source.optional() }).strict())
      .max(300)
      .default([]),
    constants: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(300),
            value: z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
            source: Source.optional(),
            estimated: z.boolean().optional(),
          })
          .strict()
          .refine((c) => c.source !== undefined || c.estimated === true, "needs a source, or estimated: true after looking for one"),
      )
      .max(500)
      .default([]),
    unknowns: z
      .array(
        z
          .object({
            question: Text,
            severity: z.enum(["low", "medium", "high"]),
            probes: List,
            settle: z.string().trim().max(2000).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    closes: z
      .array(z.object({ id: z.string().trim().min(1).max(100), resolution: Text, source: Source.optional() }).strict())
      .max(100)
      .default([]),
    // Observed by running the target, never inferred from reading it (specs/vector-replay R1).
    vectors: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            args: z.array(z.string().max(4000)).max(50).default([]),
            stdin: z
              .string()
              .max(64 * 1024)
              .default(""),
            stdout: z.string().max(256 * 1024),
            exitCode: z.number().int().min(0).max(255).default(0),
            source: Source,
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict()

export type Contract = z.output<typeof ContractSchema>
export type Vector = Contract["vectors"][number]

/** The shape the specialist is asked for, as its instructions show it. */
export const CONTRACT_SHAPE = `{
  "functions": [{ "name": "…", "inputs": ["…"], "outputs": ["…"], "sideEffects": ["…"], "source": "path:10-30" }],
  "constants": [{ "name": "…", "value": 42, "source": "path@0x401000" }, { "name": "…", "value": "…", "estimated": true }],
  "unknowns": [{ "question": "…", "severity": "low | medium | high", "probes": ["what you tried"], "settle": "what would settle it" }],
  "closes": [{ "id": "<an open unknown's id>", "resolution": "…", "source": "ev_…" }],
  "vectors": [{ "name": "…", "args": ["…"], "stdin": "…", "stdout": "…", "exitCode": 0, "source": "the command you ran" }]
}`

/** Contracts are read from at most this much of a report. */
const REPORT_CAP = 256 * 1024

/** The last fenced json block of a report, validated (R1.2): the contract, or why there is none. */
export function readContract(report: string): { contract: Contract } | { problems: string[] } {
  const text = report.slice(-REPORT_CAP)
  const blocks = [...text.matchAll(/```json[^\S\n]*\n([\s\S]*?)\n```/g)]
  const last = blocks.at(-1)?.[1]
  if (last === undefined) return { problems: ["The report does not end with a contract: a fenced ```json block."] }
  let raw: unknown
  try {
    raw = JSON.parse(last)
  } catch (e) {
    return { problems: [`The contract is not valid JSON: ${(e as Error).message}`] }
  }
  const parsed = ContractSchema.safeParse(raw)
  if (parsed.success) return { contract: parsed.data }
  return { problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "contract"}: ${i.message}`) }
}

/** The report without its contract block, for a reader who gets the contract on its own. */
export function withoutContract(report: string): string {
  const blocks = [...report.matchAll(/```json[^\S\n]*\n[\s\S]*?\n```/g)]
  const last = blocks.at(-1)
  if (!last || last.index === undefined) return report
  return (report.slice(0, last.index) + report.slice(last.index + last[0].length)).trimEnd()
}
