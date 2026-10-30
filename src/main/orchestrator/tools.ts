import { posix } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { questionProblem, QuestionSchema, type Answer, type Origin, type Question } from "@shared/chat"
import { ContextPackageSchema } from "@shared/context"
import { approvePatch, delegate, DelegationRefused, type DelegationDeps } from "../delegation"
import { redactValue } from "../events/redact"
import { makePatchFrom, PATCH_CAP } from "../sandbox/patch"
import { PREPARED, WORKSPACE_CAP, type PreparedFile } from "../sandbox/workspace"
import { SpecialistError } from "../specialist/executor"

/*
  The orchestrator's own tools (specs/orchestrator R2.3–R2.5, R3.1): the specialist behind
  `delegate_to_specialist`, fed a validated context package, `propose_patch`, which turns the
  orchestrator's own code into a patch (specs/chat R6.6), `apply_patch`, which the agent only
  reaches after the user's approval because it sits in `interruptOn`, and `ask_user`, which
  waits for the user's answer (specs/chat R5.1).
*/

export const DELEGATE = "delegate_to_specialist"
export const APPLY_PATCH = "apply_patch"
export const ASK_USER = "ask_user"
export const PROPOSE_PATCH = "propose_patch"

export interface ToolContext {
  deps: DelegationDeps
  taskId: string
  sourceRoot: string
  /** the source folder's path as the agent sees it: `/workspace` in the task's sandbox, `/` in tests */
  root: string
  signal: AbortSignal
  /** puts a question to the user and settles with the answer, or the default and why; a specialist's names its delegation step */
  ask?(q: Question, agent: "orchestrator" | "specialist", stepId?: string): Promise<{ answer: Answer; origin: Origin }>
  /** the agent's writable scratch in its sandbox, when it has one (adr:0009-give-the-orchestrator-a-writable-scratch) */
  scratch?: string
  /** the task runs its calls without asking, so nobody approves a patch it applies (specs/chat R4.1) */
  auto?: boolean
  /** reads files out of the scratch; one it cannot read comes back with no content */
  readScratch?(paths: string[]): Promise<{ path: string; content: Uint8Array | null }[]>
}

function redactedJson(v: unknown): string {
  return JSON.stringify(redactValue(v))
}

/** The agent sees the source tree under its root; the package wants paths relative to the source folder. */
export function relativeTo(root: string, p: string): string {
  const s = p.replace(/\\/g, "/")
  const r = root.replace(/\/+$/, "")
  return (r && (s === r || s.startsWith(`${r}/`)) ? s.slice(r.length) : s).replace(/^\/+/, "")
}

export function delegateTool(ctx: ToolContext) {
  return tool(
    async (input) => {
      // A file from the scratch goes to the specialist under .orchestrator/ (specs/chat R6.7); the rest are the source's.
      const scratch = input.files.filter((f) => inScratch(f, ctx.scratch))
      const name = (p: string) => (inScratch(p, ctx.scratch) ? `${PREPARED}/${posix.normalize(p).slice(ctx.scratch!.length + 1)}` : relativeTo(ctx.root, p))
      const pkg = ContextPackageSchema.parse({
        ...input,
        files: input.files.map(name),
        excerpts: input.excerpts?.map((e) => ({ ...e, path: name(e.path) })),
      })
      let prepared: PreparedFile[] = []
      if (scratch.length) {
        const read = await readScratchFiles(ctx, scratch, WORKSPACE_CAP)
        if (typeof read === "string") return `ERROR: ${read}.`
        prepared = [...read].map(([p, content]) => ({ path: name(p).slice(PREPARED.length + 1), content }))
      }
      try {
        const r = await delegate(ctx.deps, { taskId: ctx.taskId, sourceRoot: ctx.sourceRoot, pkg, signal: ctx.signal, ask: ctx.ask, prepared })
        // The report goes to OpenRouter: no secret shape leaves the machine in it.
        return redactedJson({
          report: r.report,
          evidence: r.evidence,
          patch: r.patch
            ? {
                patchId: r.patch.id,
                files: r.patch.files,
                note: `To change the user's files, call ${APPLY_PATCH} with this patchId; the user approves or rejects it first.`,
              }
            : null,
        })
      } catch (e) {
        if (e instanceof SpecialistError && e.kind === "cancelled") throw e
        if (e instanceof DelegationRefused || e instanceof SpecialistError) return `ERROR: ${e.message}`
        throw e
      }
    },
    {
      name: DELEGATE,
      description: [
        "Delegate one well-scoped step to the specialist, Claude Opus running in a sandbox that sees only the files you list.",
        "Files may come from the source or from your scratch area; the specialist gets the scratch ones under .orchestrator/, and they are never part of a patch.",
        "It sees nothing else: not the user's request, not this conversation. State the objective and questions so they stand on their own.",
        "Use mode 'modify' only when the step must change files; the change comes back as a patch.",
        "Returns the specialist's report, its evidence lines (path:start-end — claim) and any patch.",
      ].join(" "),
      schema: ContextPackageSchema,
    },
  )
}

export function applyPatchTool(ctx: ToolContext) {
  return tool(
    async ({ patchId }) => {
      let p
      try {
        p = ctx.deps.log.getPatch(patchId)
      } catch {
        return `ERROR: there is no patch ${patchId}.`
      }
      if (p.taskId !== ctx.taskId) return `ERROR: patch ${patchId} does not belong to this task.`
      const done = approvePatch(ctx.deps, patchId, ctx.sourceRoot, ctx.auto ? "auto" : "user")
      if (done.state === "conflict")
        return `ERROR: the patch was not applied because these files changed since they were copied: ${done.conflicts.join(", ")}. Re-delegate with the current files if the change is still needed.`
      return `Applied the approved patch to ${done.files.map((f) => f.path).join(", ")}.`
    },
    {
      name: APPLY_PATCH,
      description:
        "Apply a patch proposed by the specialist or by propose_patch to the user's files. The user is asked to approve or reject it before it runs.",
      schema: z.object({ patchId: z.string().uuid().describe("The patchId returned by delegate_to_specialist or propose_patch.") }),
    },
  )
}

export function askUserTool(ctx: ToolContext) {
  return tool(
    async (q) => {
      const problem = questionProblem(q)
      if (problem) return `ERROR: ${problem}.`
      if (!ctx.ask) return JSON.stringify({ answer: q.default, origin: "timeout" })
      return JSON.stringify(await ctx.ask(q, "orchestrator"))
    },
    {
      name: ASK_USER,
      description: [
        "Ask the user one question and wait for the answer. Use it only when the answer changes what you do next and neither the request, the files nor the specialist can settle it.",
        "Give the reason the answer is needed and a sensible default: the default is used if the user does not answer in time, and a turn allows only a few questions.",
        'Returns {"answer", "origin"}, where origin is "user", or "timeout"/"cap"/"stopped" when the default was used.',
      ].join(" "),
      schema: QuestionSchema,
    },
  )
}

/** Whether a path the agent named lies inside the scratch, once `..` is resolved. */
export function inScratch(path: unknown, scratch: string | undefined): boolean {
  if (!scratch || typeof path !== "string" || !path.startsWith("/")) return false
  const p = posix.normalize(path)
  return p === scratch || p.startsWith(`${scratch}/`)
}

/**
  Files out of the scratch by their normalized path, each read once and one at a time, stopping at
  the cap, so a list naming one large file many times never fills the app's memory; or why not.
*/
export async function readScratchFiles(ctx: ToolContext, paths: string[], cap: number): Promise<Map<string, Buffer> | string> {
  if (!ctx.scratch || !ctx.readScratch) return "there is no scratch area to read from"
  const out = new Map<string, Buffer>()
  let total = 0
  for (const p of new Set(paths.map((x) => posix.normalize(x)))) {
    if (p === ctx.scratch) return `${p} is the scratch folder itself; name the files in it`
    const [file] = await ctx.readScratch([p])
    if (!file?.content) return `${p} could not be read from the scratch`
    total += file.content.length
    if (total > cap) return `the files pass ${cap / 1024 / 1024} MB`
    out.set(p, Buffer.from(file.content))
  }
  return out
}

export function proposePatchTool(ctx: ToolContext) {
  return tool(
    async ({ files, summary }) => {
      const outside = files.find((f) => !inScratch(f.from, ctx.scratch))
      if (outside) return `ERROR: ${outside.from} is not in ${ctx.scratch ?? "a scratch area"}; propose only code you wrote there.`
      const read = await readScratchFiles(
        ctx,
        files.map((f) => f.from),
        PATCH_CAP,
      )
      if (typeof read === "string") return `ERROR: ${read}.`
      let p
      try {
        p = makePatchFrom(
          ctx.deps.dataDir,
          ctx.sourceRoot,
          files.map((f) => ({ path: relativeTo(ctx.root, f.to), content: read.get(posix.normalize(f.from))! })),
        )
      } catch (e) {
        return `ERROR: ${(e as Error).message}`
      }
      if (!p) return "ERROR: these files are the same as the originals, so there is nothing to propose."
      const { log } = ctx.deps
      const title = summary || `Patch for ${p.files.length} file(s)`
      const step = log.addStep({ taskId: ctx.taskId, kind: "patch", title, agent: "orchestrator", state: "done" })
      const patch = log.savePatch({ id: p.id, taskId: ctx.taskId, stepId: step.id, files: p.files, diff: p.diff })
      log.append({
        taskId: ctx.taskId,
        stepId: step.id,
        agent: "orchestrator",
        kind: "patch.proposed",
        summary: `Patch proposed for ${p.files.length} file(s)`,
        payload: { patchId: p.id, files: p.files.map((f) => ({ path: f.path, op: "write" })), output: p.diff },
      })
      return redactedJson({
        patchId: patch.id,
        files: patch.files,
        note: `Call ${APPLY_PATCH} with this patchId; the user approves or rejects it first.`,
      })
    },
    {
      name: PROPOSE_PATCH,
      description: [
        "Propose code you wrote in your scratch area as a change to the user's source files.",
        "Each file is read from the scratch and becomes the new contents of its target in the source, added where none exists.",
        `Returns a patchId; call ${APPLY_PATCH} with it to ask the user to approve the change.`,
      ].join(" "),
      schema: z.object({
        summary: z.string().max(200).optional().describe("What the change is, in a few words."),
        files: z
          .array(
            z.object({
              from: z.string().min(1).max(1024).describe("The file in your scratch area, as an absolute path."),
              to: z.string().min(1).max(1024).describe("Where it goes, relative to the source folder."),
            }),
          )
          .min(1)
          .max(100),
      }),
    },
  )
}
