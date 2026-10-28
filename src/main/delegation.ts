import { parseEvidence, type ContextPackage, type Evidence } from "@shared/context"
import type { PatchView, Settings, StepRow } from "@shared/types"
import type { EventLog } from "./events/log"
import { claudeArgs, dockerExec, dockerRunArgs, killContainer, preflight, type Exec, type Limits, type Mode } from "./sandbox/docker"
import { applyPatch, discardPatch, makePatch, PatchConflict } from "./sandbox/patch"
import { PathRejected } from "./sandbox/paths"
import { renderPrompt, renderSystemPrompt } from "./sandbox/prompt"
import { discardWorkspace, prepareWorkspace, writeSystemPrompt, type Workspace } from "./sandbox/workspace"
import { SpecialistError, SpecialistSession, type Launch } from "./specialist/executor"

/*
  One delegation from start to end: check the sandbox, copy the package's files into a fresh
  workspace, render the prompt from the package alone, run the specialist in its container, read
  its report and evidence, propose a patch in modify mode, and record every step of it as events
  (specs/task-sandbox, specs/claude-specialist). Also where a patch decision is carried out.
*/

/** How a prepared run becomes a process. The app only ever builds `dockerLauncher`. */
export interface Launcher {
  /** the reason to refuse, or null */
  preflight(): Promise<string | null>
  launch(ws: Workspace, mode: Mode, limits: Limits): Launch
}

export function dockerLauncher(exec: Exec = dockerExec): Launcher {
  return {
    preflight: () => preflight(exec),
    launch: (ws, mode, limits) => ({
      command: "docker",
      args: [...dockerRunArgs({ id: ws.id, workspace: ws.workspace, runDir: ws.runDir, mode, limits }), ...claudeArgs(mode)],
      stop: () => killContainer(exec, ws.id),
    }),
  }
}

export interface DelegationDeps {
  log: EventLog
  dataDir: string
  launcher: Launcher
  settings: () => Settings
}

export class DelegationRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DelegationRefused"
  }
}

export interface DelegationResult {
  stepId: string
  report: string
  evidence: Evidence[]
  patch: PatchView | null
}

export async function delegate(
  deps: DelegationDeps,
  o: { taskId: string; sourceRoot: string; pkg: ContextPackage; signal?: AbortSignal },
): Promise<DelegationResult> {
  const { log } = deps
  const settings = deps.settings()
  const step = log.addStep({
    taskId: o.taskId,
    kind: "delegation",
    title: o.pkg.objective.slice(0, 160),
    agent: "specialist",
    state: "running",
    data: { context: o.pkg },
  })
  const ev = (kind: string, summary: string, payload: Record<string, unknown> = {}, state: StepRow["state"] | "" = "") =>
    log.append({ taskId: o.taskId, stepId: step.id, agent: "sandbox", kind, summary, payload, state })
  const refuse = (reason: string, payload: Record<string, unknown> = {}): never => {
    ev("sandbox.refused", `Delegation refused: ${reason}`, { error: reason, ...payload }, "failed")
    log.updateStep(step.id, { state: "failed", data: { error: reason } })
    throw new DelegationRefused(reason)
  }

  const blocked = await deps.launcher.preflight()
  if (blocked) refuse(blocked)

  let ws: Workspace
  try {
    ws = prepareWorkspace(deps.dataDir, o.sourceRoot, o.pkg.files)
  } catch (e) {
    if (e instanceof PathRejected) return refuse(`${e.path} cannot be delegated: ${e.message}`, { rejectedPath: e.path })
    throw e
  }
  ev("sandbox.copy", `Copied ${ws.files.length} file(s) into workspace ${ws.id}`, {
    workspace: ws.id,
    mode: o.pkg.mode,
    files: ws.files.map((f) => ({ path: f.path, op: "copy" })),
    sha256: Object.fromEntries(ws.files.map((f) => [f.path, f.sha256])),
  })

  try {
    writeSystemPrompt(ws, renderSystemPrompt(o.pkg))
    const session = new SpecialistSession(deps.launcher.launch(ws, o.pkg.mode, settings), {
      timeoutMs: settings.timeoutMinutes * 60_000,
      signal: o.signal,
      onRaw: (line) => log.raw(o.taskId, "specialist", line, step.id),
      onEvent: (e) =>
        log.append({ taskId: o.taskId, stepId: step.id, agent: "specialist", kind: `specialist.${e.kind}`, summary: e.summary, payload: e.payload }),
    })
    let result
    try {
      result = await session.send(renderPrompt(o.pkg))
    } finally {
      await session.close()
      // A failed turn can still have spent tokens; its result carries them.
      const spent = session.reader.result
      if (spent) log.addUsage(o.taskId, { tokensIn: spent.tokensIn + spent.cacheTokens, tokensOut: spent.tokensOut, specialistCostUsd: spent.costUsd ?? 0 })
    }
    const evidence = parseEvidence(
      result.text,
      ws.files.map((f) => f.path),
    )
    let patch: PatchView | null = null
    if (o.pkg.mode === "modify") {
      const p = makePatch(deps.dataDir, ws)
      if (p?.skipped.length)
        ev("sandbox.skipped", `Left out of the patch: ${p.skipped.join(", ")}`, { files: p.skipped.map((path) => ({ path, op: "write" })) })
      if (p) {
        patch = log.savePatch({ id: p.id, taskId: o.taskId, stepId: step.id, files: p.files, diff: p.diff })
        ev("patch.proposed", `Patch proposed for ${p.files.length} file(s)`, {
          patchId: p.id,
          files: p.files.map((f) => ({ path: f.path, op: "write" })),
          output: p.diff,
        })
      }
    }
    log.updateStep(step.id, { state: "done", data: { report: result.text, evidence, patchId: patch?.id ?? null, session: result.session } })
    return { stepId: step.id, report: result.text, evidence, patch }
  } catch (e) {
    const kind = e instanceof SpecialistError ? e.kind : "failed"
    const state = kind === "cancelled" ? "cancelled" : "failed"
    ev(`delegation.${kind}`, (e as Error).message, { error: (e as Error).message }, state)
    log.updateStep(step.id, { state, data: { error: (e as Error).message } })
    throw e
  } finally {
    if (settings.discardOnCompletion) {
      discardWorkspace(deps.dataDir, ws.id)
      ev("sandbox.discarded", `Discarded workspace ${ws.id}`, { workspace: ws.id })
    }
  }
}

/** Apply an approved patch, or record why it could not be (specs/task-sandbox R4.2–R4.4). */
export function approvePatch(deps: DelegationDeps, patchId: string, sourceRoot: string): PatchView {
  const p = deps.log.getPatch(patchId)
  if (p.state !== "proposed" && p.state !== "approved") throw new Error(`The patch is already ${p.state}.`)
  const ev = (kind: string, summary: string, payload: Record<string, unknown>) =>
    deps.log.append({ taskId: p.taskId, stepId: p.stepId, agent: "sandbox", kind, summary, payload })
  deps.log.updatePatch(patchId, { state: "approved" })
  ev("patch.approved", "Patch approved by the user", { patchId })
  try {
    const files = applyPatch(deps.dataDir, patchId, sourceRoot)
    ev("patch.applied", `Patch applied to ${files.length} file(s)`, { patchId, files: files.map((path) => ({ path, op: "apply" })) })
    const done = deps.log.updatePatch(patchId, { state: "applied" })
    if (deps.settings().discardOnCompletion) discardPatch(deps.dataDir, patchId)
    return done
  } catch (e) {
    if (!(e instanceof PatchConflict)) throw e
    ev("patch.conflict", e.message, { patchId, error: e.message, conflicts: e.conflicts })
    return deps.log.updatePatch(patchId, { state: "conflict", conflicts: e.conflicts })
  }
}

export function rejectPatch(deps: DelegationDeps, patchId: string): PatchView {
  const p = deps.log.getPatch(patchId)
  if (p.state !== "proposed") throw new Error(`The patch is already ${p.state}.`)
  deps.log.append({ taskId: p.taskId, stepId: p.stepId, agent: "sandbox", kind: "patch.rejected", summary: "Patch rejected by the user", payload: { patchId } })
  const done = deps.log.updatePatch(patchId, { state: "rejected" })
  discardPatch(deps.dataDir, patchId)
  return done
}
