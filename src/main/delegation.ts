import { randomUUID } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { questionProblem, QuestionSchema, type Answer, type Origin, type Question } from "@shared/chat"
import { parseEvidence, type ContextPackage, type Evidence } from "@shared/context"
import type { PatchView, Settings, SpecialistEffort, StepRow } from "@shared/types"
import type { EventLog } from "./events/log"
import { claudeArgs, dockerExec, dockerRunArgs, execArgs, killContainer, preflight, specialistCommand, stopArgs, type Exec, type Mode } from "./sandbox/docker"
import { applyPatch, makePatch, PatchConflict } from "./sandbox/patch"
import { PathRejected } from "./sandbox/paths"
import { renderPrompt, renderSystemPrompt, scrubPaths } from "./sandbox/prompt"
import { SandboxError, type Box, type TaskSandboxes } from "./sandbox/specialistbox"
import { askDir, prepareWorkspace, rebaseSnapshot, writeSystemPrompt, type PreparedFile, type Workspace } from "./sandbox/workspace"
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
  /** `box` names the orchestrator's sandbox to run in; without it the run gets a container of its own */
  launch(ws: Workspace, mode: Mode, o: { specialistEffort?: SpecialistEffort }, box?: string): Launch
}

export function dockerLauncher(exec: Exec = dockerExec): Launcher {
  return {
    preflight: () => preflight(exec),
    launch: (ws, mode, o, box) => {
      const cli = claudeArgs(mode, undefined, o.specialistEffort)
      // In a sandbox the stop ends the CLI and leaves the sandbox up (specs/specialist-sandbox R4.4).
      if (box) return { command: "docker", args: execArgs(box, cli), stop: async () => void (await exec(stopArgs(box))) }
      return {
        command: "docker",
        args: [...dockerRunArgs({ id: ws.id, workspace: ws.workspace, runDir: ws.runDir, out: ws.out, mode }), ...specialistCommand(cli)],
        stop: () => killContainer(exec, ws.id),
      }
    },
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

/** The specialist declined the step under its usage policy (specs/specialist-lifecycle R2.1). */
export class SafeguardRefusal extends Error {
  constructor(
    readonly stepId: string,
    message: string,
  ) {
    super(message)
    this.name = "SafeguardRefusal"
  }
}

export interface DelegationResult {
  stepId: string
  report: string
  evidence: Evidence[]
  patch: PatchView | null
}

/** Empty a sandbox's ask channel, so an earlier delegation's questions are not answered again (specs/specialist-sandbox R4.8). */
function clearAskChannel(ws: Workspace) {
  const dir = askDir(ws.runDir)
  for (const name of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, name), { recursive: true, force: true })
}

export async function delegate(
  deps: DelegationDeps,
  o: {
    taskId: string
    sourceRoot: string
    pkg: ContextPackage
    signal?: AbortSignal
    ask?: AskUser
    prepared?: PreparedFile[]
    /** the orchestrator's sandbox to run in, instead of a container of the delegation's own (specs/specialist-sandbox R4) */
    sandbox?: { boxes: TaskSandboxes; id: string }
    /** the specialist's effort for this delegation, the project's; the Settings default when absent */
    specialistEffort?: SpecialistEffort
    /** the orchestrator's tool call that started this delegation, which the timeline nests it under (specs/chat-timeline R1.1) */
    callId?: string
  },
): Promise<DelegationResult> {
  const { log } = deps
  const settings = deps.settings()
  const step = log.addStep({
    taskId: o.taskId,
    kind: "delegation",
    title: o.pkg.objective.slice(0, 160),
    agent: "specialist",
    state: "running",
    data: { context: o.pkg, ...(o.callId ? { callId: o.callId } : {}) },
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
  let held: { box: Box; release: () => Promise<void> } | null = null
  try {
    if (o.sandbox) {
      held = await o.sandbox.boxes.hold(o.sandbox.id)
      ws = held.box.ws
      // The package's files the sandbox lacks come in now; what the orchestrator prepared, always as it is now.
      const missing = o.pkg.files.filter((f) => !f.startsWith(`.orchestrator/`) && !ws.files.some((c) => c.path === f))
      await o.sandbox.boxes.copy(o.sandbox.id, missing, o.prepared ?? [])
      if (held.box.stopped) throw new SandboxError(`Sandbox ${o.sandbox.id} was stopped: ${held.box.stopped}.`)
      clearAskChannel(ws)
    } else {
      // Under the task's own folder, kept until the task is deleted (specs/task-persistence R3.1, R3.7).
      ws = prepareWorkspace(log.taskDir(o.taskId), o.sourceRoot, o.pkg.files, o.prepared)
      ev("sandbox.copy", `Copied ${ws.files.length} file(s) into workspace ${ws.id}`, {
        workspace: ws.id,
        mode: o.pkg.mode,
        files: ws.files.map((f) => ({ path: f.path, op: "copy" })),
        sha256: Object.fromEntries(ws.files.map((f) => [f.path, f.sha256])),
      })
    }
  } catch (e) {
    await held?.release()
    if (e instanceof PathRejected) return refuse(`${e.path} cannot be delegated: ${e.message}`, { rejectedPath: e.path })
    if (e instanceof SandboxError) return refuse(e.message, { sandbox: o.sandbox?.id })
    throw e
  }

  try {
    const pkg = scrubPaths(o.pkg, o.sourceRoot)
    writeSystemPrompt(ws, renderSystemPrompt(pkg, held !== null))
    const session = new SpecialistSession(
      deps.launcher.launch(ws, o.pkg.mode, { specialistEffort: o.specialistEffort ?? settings.specialistEffort }, held?.box.name),
      {
        timeoutMs: settings.timeoutMinutes * 60_000,
        signal: o.signal,
        onRaw: (line) => log.raw(o.taskId, "specialist", line, step.id),
        onEvent: (e) =>
          log.append({ taskId: o.taskId, stepId: step.id, agent: "specialist", kind: `specialist.${e.kind}`, summary: e.summary, payload: e.payload }),
      },
    )
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
        // The sandbox goes on: its next patch is made against what this one proposed (specs/specialist-sandbox R4.5).
        if (held) rebaseSnapshot(ws, p.changes)
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
    // A sandbox stopped at its disk limit ends the run inside it; the reason is the sandbox's, not the CLI's.
    if (held) await held.release()
    if (held?.box.stopped && e instanceof Error) e.message += ` (sandbox ${held.box.id} was stopped: ${held.box.stopped})`
    // A safeguard refusal is its own state, never a failure to retry (specs/specialist-lifecycle R2.1).
    if (kind === "refused") {
      ev("safeguard.refusal", (e as Error).message, { error: (e as Error).message }, "refused")
      log.updateStep(step.id, { state: "refused", data: { error: (e as Error).message } })
      throw new SafeguardRefusal(step.id, (e as Error).message)
    }
    ev(`delegation.${kind}`, (e as Error).message, { error: (e as Error).message }, state)
    log.updateStep(step.id, { state, data: { error: (e as Error).message } })
    throw e
  } finally {
    // A sandbox outlives the delegation; its folders and a delegation's own stay with the task (specs/task-persistence R3.7).
    if (held) await held.release()
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
  // Kept with the task: deleting the task removes it (specs/task-persistence R4.3).
  return deps.log.updatePatch(patchId, { state: "rejected" })
}
