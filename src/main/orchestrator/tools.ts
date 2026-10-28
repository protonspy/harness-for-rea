import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { ContextPackageSchema } from "@shared/context"
import { approvePatch, delegate, DelegationRefused, type DelegationDeps } from "../delegation"
import { redactValue } from "../events/redact"
import { SpecialistError } from "../specialist/executor"

/*
  The orchestrator's own tools (specs/orchestrator R2.3–R2.5, R3.1): the specialist behind
  `delegate_to_specialist`, fed a validated context package, and `apply_patch`, which the agent
  only reaches after the user's approval because it sits in `interruptOn`.
*/

export const DELEGATE = "delegate_to_specialist"
export const APPLY_PATCH = "apply_patch"

export interface ToolContext {
  deps: DelegationDeps
  taskId: string
  sourceRoot: string
  signal: AbortSignal
}

function redactedJson(v: unknown): string {
  return JSON.stringify(redactValue(v))
}

/** The agent sees the source tree at `/`; the package wants paths relative to the source folder. */
function relative(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "")
}

export function delegateTool(ctx: ToolContext) {
  return tool(
    async (input) => {
      const pkg = ContextPackageSchema.parse({
        ...input,
        files: input.files.map(relative),
        excerpts: input.excerpts?.map((e) => ({ ...e, path: relative(e.path) })),
      })
      try {
        const r = await delegate(ctx.deps, { taskId: ctx.taskId, sourceRoot: ctx.sourceRoot, pkg, signal: ctx.signal })
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
      const done = approvePatch(ctx.deps, patchId, ctx.sourceRoot)
      if (done.state === "conflict")
        return `ERROR: the patch was not applied because these files changed since they were copied: ${done.conflicts.join(", ")}. Re-delegate with the current files if the change is still needed.`
      return `Applied the approved patch to ${done.files.map((f) => f.path).join(", ")}.`
    },
    {
      name: APPLY_PATCH,
      description: "Apply a patch the specialist proposed to the user's files. The user is asked to approve or reject it before it runs.",
      schema: z.object({ patchId: z.string().uuid().describe("The patchId returned by delegate_to_specialist.") }),
    },
  )
}
