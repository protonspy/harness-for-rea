import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { questionProblem, QuestionSchema, type Answer, type Origin, type Question } from "@shared/chat"
import { parseEvidence, type ContextPackage, type Evidence } from "@shared/context"
import type { PatchView, Settings, SpecialistEffort, StepRow } from "@shared/types"
import type { EventLog } from "./events/log"
import { claudeArgs, dockerExec, dockerRunArgs, killContainer, preflight, type Exec, type Limits, type Mode } from "./sandbox/docker"
import { applyPatch, discardPatch, makePatch, PatchConflict } from "./sandbox/patch"
import { PathRejected } from "./sandbox/paths"
import { renderPrompt, renderSystemPrompt, scrubPaths } from "./sandbox/prompt"
import { askDir, discardWorkspace, prepareWorkspace, writeSystemPrompt, type PreparedFile, type Workspace } from "./sandbox/workspace"
import { SpecialistError, SpecialistSession, type Launch } from "./specialist/executor"

/*
  One delegation from start to end: check the sandbox, copy the package's files into a fresh
  workspace, render the prompt from the package alone, run the specialist in its container, read
  its report and evidence, propose a patch in modify mode, and record every step of it as events
  (specs/task-sandbox, specs/claude-specialist). While it runs, questions the specialist writes to the
  run's ask channel go to the user and the answers come back the same way (specs/chat R5.2). Also
  where a patch decision is carried out.
*/

/** Puts a question to the user for a delegation step and settles with the answer, or the default and why. */
export type AskUser = (q: Question, agent: "specialist", stepId: string) => Promise<{ answer: Answer; origin: Origin }>

/** Largest question file read from the sandbox; a question is a few lines. */
export const QUESTION_FILE_CAP = 16 * 1024
const TOO_LARGE = Symbol("too large")
/** Most questions one run's channel is read for; the turn's own cap is far lower. */
const QUESTIONS_PER_RUN = 64

/**
  A question file the container wrote, read through one descriptor and never past the cap: a link,
  or anything but a regular file, is refused, and a file grown after the check is cut off.
*/
function readQuestion(file: string): unknown {
  if (!lstatSync(file).isFile()) return undefined
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!fstatSync(fd).isFile()) return undefined
    const buf = Buffer.alloc(QUESTION_FILE_CAP + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return n > QUESTION_FILE_CAP ? TOO_LARGE : JSON.parse(buf.subarray(0, n).toString("utf8"))
  } finally {
    closeSync(fd)
  }
}

/**
  Watch a run's ask channel (adr:0008-ask-the-user-from-the-specialist-over-the-run-channel): each new
  `q-<id>.json` is read once, bounded, and answered with `a-<id>.json`, written whole by a rename.
  Returns the function that stops watching.
*/
export function watchAskChannel(dir: string, answer: (question: unknown) => Promise<object>, everyMs = 200): () => void {
  const seen = new Set<string>()
  const tick = () => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const id = /^q-([A-Za-z0-9-]{1,64})\.json$/.exec(name)?.[1]
      if (!id || seen.has(name) || seen.size >= QUESTIONS_PER_RUN) continue
      seen.add(name)
      let body: unknown
      try {
        body = readQuestion(join(dir, name))
      } catch {
        body = undefined
      }
      void Promise.resolve()
        .then(() => answer(body))
        .catch(() => ({ error: "The question could not be put to the user." }))
        .then((reply) => {
          try {
            // A fresh name, created exclusively: the container cannot plant a link the reply would follow.
            const tmp = join(dir, `.a-${id}-${randomUUID()}.tmp`)
            writeFileSync(tmp, JSON.stringify(reply), { flag: "wx" })
            renameSync(tmp, join(dir, `a-${id}.json`))
          } catch {
            // the run ended and its directory went with it
          }
        })
    }
  }
  const timer = setInterval(tick, everyMs)
  return () => clearInterval(timer)
}

/** A question from the sandbox checked before it reaches the user: what to write back when it cannot be asked. */
function askFromSandbox(body: unknown, ask: AskUser | undefined, stepId: string): Promise<object> {
  if (body === TOO_LARGE) return Promise.resolve({ error: `The question is too large; keep it under ${QUESTION_FILE_CAP / 1024} KB.` })
  const parsed = QuestionSchema.safeParse(body)
  if (!parsed.success)
    return Promise.resolve({ error: `The question is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "question"} ${i.message}`).join("; ")}` })
  const problem = questionProblem(parsed.data)
  if (problem) return Promise.resolve({ error: `The question is invalid: ${problem}.` })
  if (!ask) return Promise.resolve({ answer: parsed.data.default, origin: "timeout" })
  return ask(parsed.data, "specialist", stepId)
}

/** How a prepared run becomes a process. The app only ever builds `dockerLauncher`. */
export interface Launcher {
  /** the reason to refuse, or null */
  preflight(): Promise<string | null>
  launch(ws: Workspace, mode: Mode, limits: Limits & { specialistEffort?: SpecialistEffort }): Launch
}

export function dockerLauncher(exec: Exec = dockerExec): Launcher {
  return {
    preflight: () => preflight(exec),
    launch: (ws, mode, limits) => ({
      command: "docker",
      args: [...dockerRunArgs({ id: ws.id, workspace: ws.workspace, runDir: ws.runDir, mode, limits }), ...claudeArgs(mode, "opus", limits.specialistEffort)],
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
  o: { taskId: string; sourceRoot: string; pkg: ContextPackage; signal?: AbortSignal; ask?: AskUser; prepared?: PreparedFile[] },
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
    ws = prepareWorkspace(deps.dataDir, o.sourceRoot, o.pkg.files, o.prepared)
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
    const pkg = scrubPaths(o.pkg, o.sourceRoot)
    writeSystemPrompt(ws, renderSystemPrompt(pkg))
    const session = new SpecialistSession(deps.launcher.launch(ws, o.pkg.mode, settings), {
      timeoutMs: settings.timeoutMinutes * 60_000,
      signal: o.signal,
      onRaw: (line) => log.raw(o.taskId, "specialist", line, step.id),
      onEvent: (e) =>
        log.append({ taskId: o.taskId, stepId: step.id, agent: "specialist", kind: `specialist.${e.kind}`, summary: e.summary, payload: e.payload }),
    })
    const stopAsking = watchAskChannel(askDir(ws.runDir), (q) => askFromSandbox(q, o.ask, step.id))
    let result
    try {
      result = await session.send(renderPrompt(pkg))
    } finally {
      stopAsking()
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

/**
  Apply an approved patch, or record why it could not be (specs/task-sandbox R4.2–R4.4). The origin says
  who approved it: the user, or a task that runs its calls without asking (specs/chat R4.1).
*/
export function approvePatch(deps: DelegationDeps, patchId: string, sourceRoot: string, origin: "user" | "auto" = "user"): PatchView {
  const p = deps.log.getPatch(patchId)
  if (p.state !== "proposed" && p.state !== "approved") throw new Error(`The patch is already ${p.state}.`)
  const ev = (kind: string, summary: string, payload: Record<string, unknown>) =>
    deps.log.append({ taskId: p.taskId, stepId: p.stepId, agent: "sandbox", kind, summary, payload })
  deps.log.updatePatch(patchId, { state: "approved" })
  ev("patch.approved", origin === "auto" ? "Patch applied without asking" : "Patch approved by the user", { patchId, origin })
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
