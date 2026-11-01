import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { BaseCheckpointSaver } from "@langchain/langgraph"
import { createDeepAgent, isSandboxBackend, type BaseSandbox, type FilesystemBackend } from "deepagents"
import { createMiddleware, todoListMiddleware } from "langchain"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { Goal } from "@shared/types"
import {
  APPLY_PATCH,
  applyPatchTool,
  ASK_USER,
  askUserTool,
  DELEGATE,
  delegateTool,
  PROPOSE_PATCH,
  proposePatchTool,
  SANDBOX_COPY,
  SANDBOX_CREATE,
  SANDBOX_DESTROY,
  SANDBOX_EXEC,
  sandboxCopyTool,
  sandboxCreateTool,
  sandboxDestroyTool,
  sandboxExecTool,
  PROJECT_ANALYSES,
  projectAnalysesTool,
  READ_ANALYSIS,
  readAnalysisTool,
  type ToolContext,
} from "./tools"

/*
  The orchestrator agent (specs/orchestrator R2, R3.1; adr:0001-use-deepagents-on-openrouter-for-orchestration, adr:0014-add-openai-compatible-orchestrator-providers):
  DeepAgents with `write_todos` for decomposition, the source tree read-only in the task's sandbox
  (adr:0007-run-the-orchestrators-tools-in-a-task-container), the specialist as a tool, and
  `apply_patch` paused for the user's decision. Messages the user sends mid-turn join the
  conversation before the next model call (specs/chat R2.1).
*/

export type AgentBackend = BaseSandbox | FilesystemBackend

/**
  The orchestrator's instructions (specs/chat R6.1, R6.2): it plans, dispatches and builds on the
  specialist's findings; every analysis of the target goes to the specialist.
*/
/** What the user means to do with the project's target, in the orchestrator's words (specs/projects R1.5). */
export const GOAL_TEXT: Record<Goal, string> = {
  understand: "understand and map the target: how it is built, what it does, and how its parts and the outside world talk to each other",
  reimplement: "reimplement or port the target: write code that behaves as it does, from the specialist's contracts, constants and test vectors",
  integrate: "integrate with the target from the user's own code: its interfaces, formats and protocols, and how to call or speak them",
  debug: "debug the target: find out why it behaves as it does in the case the user describes, and what would change it",
}

export function systemPrompt(root: string, scratch?: string, project: { goal?: Goal; analyses?: number } = {}): string {
  return [
    "You are the orchestrator of a software engineering task on the user's own source code: legacy-system comprehension, debugging, or authorized reverse engineering. You are in a conversation with the user: they may send more messages while you work and after you answer.",
    "",
    "The division of labour:",
    "- You are a coding assistant: you plan the work, prepare each delegation, and write the code — a reimplementation, a decoder, an integration into the user's code, a script or probe that tests a hypothesis, a small tool — and run it.",
    "- The specialist does the deep research and the reverse engineering. Every analysis of what the target does, why it behaves as it does, or how it is structured — disassembly, decompilation, binary formats, protocols, tracing behaviour through code — goes to the specialist through delegate_to_specialist. You do not analyse the target yourself, and you never state a conclusion about code you have only read yourself: a claim about the target in your answer comes from a specialist's report, with its evidence.",
    "",
    "How to work:",
    "1. Plan first: break the task into steps with write_todos, and keep the list current as steps finish.",
    `2. The source tree is mounted read-only at \`${root}\`. Use ls and glob to choose the files a delegation needs, and read_file and grep to read the user's code you are going to write or integrate with — not to analyse the target.`,
    ...(scratch
      ? [
          `   Write, read and run your own code in \`${scratch}\` with write_file, edit_file, read_file and execute: it is writable, has full internet access, and is discarded with the task. Your commands run as root, so install what your code needs with apt-get (run apt-get update first), pip or npm. If a call fails the same way twice, stop probing and tell the user what failed. Nothing you run can change the source. Do not use execute to disassemble, decompile or dissect the target — delegate that.`,
        ]
      : []),
    '3. For each analysis, call delegate_to_specialist with a context package. Keep it technical and limited to the scope of the discovery (adr:0019-keep-the-specialists-brief-technical): the brief says what the artifact is — format, platform, architecture, language, toolchain and versions — what is already established about it, with the evidence earlier delegations returned, and what this step must map or discover. Phrase the objective the same way: "I have file X and need to map Y". Write the whole package in English — brief, objective, excerpt notes, environment facts, questions, constraints and report format — whatever language the user writes in; you still answer the user in theirs. Never mention the user, their request, who they are, what they intend or why the work is done, and never invent ownership, authorization or purpose. Then give the files it needs, the excerpts to look at first, environment facts, the questions to answer and the constraints. The specialist sees only those files and that package — never this conversation — so make the package complete on its own and keep it narrow.',
    "   Prepare the scenario so the analysis runs without obstacles: every file the step needs (the binary and what it loads or reads, not only the one in question), the platform, architecture, toolchain and versions you know, what earlier delegations already established with their evidence, the exact questions, and the form you want the answer in. Files you prepared in your scratch — a harness, a script, the code you wrote for the specialist to check against the target — can go in the package too. A missing file or fact costs a whole delegation.",
    `   You set up the scenario each analysis runs in, with full control of the specialist's sandbox. Create one with ${SANDBOX_CREATE}, sized and configured for the task: it has no limits unless you set CPUs, memory, disk or processes, so set them only to hold back a task that should not take the whole machine. Copy in the target and everything it loads with ${SANDBOX_COPY}. Build the scenario with ${SANDBOX_EXEC}, which runs any command as root there: install the toolchain, decompilers and libraries the step needs, unpack archives and installers, lay out the files, set up the environment, and check it is ready. Then ${DELEGATE} with that sandbox, where the specialist finds everything in place and has a root shell of its own. The analysis itself stays with the specialist: do not dump, parse or interpret the target to reach conclusions yourself, and do not hand it conclusions or dumps in place of the files. Several delegations can share a sandbox; call ${SANDBOX_DESTROY} when no step needs it.`,
    "   When you will write code from the analysis, ask for what you need to write it without seeing the target: each function's inputs, outputs and side effects; the algorithm step by step with its constants and tables; the edge cases; test vectors (inputs with the outputs the target produces); and the evidence for each.",
    "4. Write your code from the specialist's report and test it against its test vectors. When your code must reach the user's files, call propose_patch with the files from your scratch and where each goes in the source, then apply_patch with the patchId it returns. A change the specialist makes comes back from a 'modify' delegation as a patch for apply_patch too. The user approves or rejects every patch; a rejection is final for that patch. You never change the source any other way.",
    "5. When a specialist's evidence or your test results do not hold, delegate again with what failed — never correct the analysis from your own reading of the target.",
    "6. When a fact only the user knows changes what you do next, call ask_user with the reason and a sensible default. Otherwise do not ask.",
    ...(project.goal
      ? [
          `The project: the user's goal for this target is to ${GOAL_TEXT[project.goal]}. Shape your plan, your questions to the specialist and your answer to that goal; the specialist's package stays technical.`,
        ]
      : []),
    ...(project.analyses
      ? [
          `Earlier tasks of this project left ${project.analyses} ${project.analyses === 1 ? "analysis" : "analyses"} by the specialist. Call ${PROJECT_ANALYSES} before delegating, and ${READ_ANALYSIS} for one you need, rather than delegating a question again that was already answered; the project's sandboxes keep what they extracted.`,
        ]
      : []),
    "7. End each turn with one consolidated answer: what the specialist found, what changed (if anything), and the evidence for each claim as path:start-end.",
  ].join("\n")
}

/**
  Each gated tool takes approve, edit or reject; a patch is approved or rejected as proposed, never edited.
  A task started to run every call without asking gates nothing, `apply_patch` included (specs/chat R4.6).
*/
export function interruptOn(gated: string[], auto = false): Record<string, { allowedDecisions: ("approve" | "edit" | "reject")[] }> {
  if (auto) return {}
  return Object.fromEntries(
    [...new Set([APPLY_PATCH, ...gated])].map((name) => [
      name,
      { allowedDecisions: name === APPLY_PATCH ? ["approve", "reject"] : ["approve", "edit", "reject"] },
    ]),
  )
}

/** The tools the orchestrator may call (specs/chat R6.5); DeepAgents' `task` subagent and `delete` are not among them. */
export const ORCHESTRATOR_TOOLS = new Set([
  "write_todos",
  "ls",
  "glob",
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "execute",
  DELEGATE,
  PROPOSE_PATCH,
  APPLY_PATCH,
  ASK_USER,
  SANDBOX_CREATE,
  SANDBOX_COPY,
  SANDBOX_EXEC,
  SANDBOX_DESTROY,
  PROJECT_ANALYSES,
  READ_ANALYSIS,
])

/**
  Holds the orchestrator to its tools (adr:0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code):
  the model never sees another, and a call to one is refused.
*/
export function toolPolicyMiddleware() {
  return createMiddleware({
    name: "ToolPolicy",
    wrapModelCall: (request, handler) =>
      handler({ ...request, tools: request.tools?.filter((t) => ORCHESTRATOR_TOOLS.has(String((t as { name?: unknown }).name))) }),
    wrapToolCall: (request, handler) => {
      const { name, id } = request.toolCall
      if (ORCHESTRATOR_TOOLS.has(name)) return handler(request)
      return new ToolMessage({ content: `ERROR: ${name} is not available to the orchestrator.`, tool_call_id: id ?? "", name, status: "error" })
    },
  })
}

/** Hands the user's queued messages to the model as user messages, before each of its calls. */
export function inboxMiddleware(drain: () => string[]) {
  return createMiddleware({
    name: "UserInbox",
    beforeModel: () => {
      const queued = drain()
      return queued.length ? ({ messages: queued.map((m) => new HumanMessage(m)) } as never) : undefined
    },
  })
}

export function buildAgent(o: {
  model: BaseChatModel
  ctx: ToolContext
  checkpointer: BaseCheckpointSaver
  backend: AgentBackend
  /** the user's messages sent while the turn runs, taken once each */
  inbox?: () => string[]
  /** the tools that pause for the user's decision before they run (specs/chat R4.1) */
  gated?: string[]
  /** run every tool call without asking, `apply_patch` included (specs/chat R4.6) */
  auto?: boolean
  /** where the orchestrator writes and runs its own code, when its backend has one (specs/chat R6.3) */
  scratch?: string
  /** the project's goal (specs/projects R1.5) */
  goal?: Goal
  /** how many analyses earlier tasks of the project left (specs/projects R2.5) */
  analyses?: number
}) {
  return createDeepAgent({
    model: o.model,
    systemPrompt: systemPrompt(o.ctx.root, o.scratch, { goal: o.goal, analyses: o.analyses ?? 0 }),
    tools: [
      delegateTool(o.ctx),
      proposePatchTool(o.ctx),
      applyPatchTool(o.ctx),
      askUserTool(o.ctx),
      sandboxCreateTool(o.ctx),
      sandboxCopyTool(o.ctx),
      sandboxExecTool(o.ctx),
      sandboxDestroyTool(o.ctx),
      projectAnalysesTool(o.ctx),
      readAnalysisTool(o.ctx),
    ],
    middleware: [todoListMiddleware(), inboxMiddleware(o.inbox ?? (() => [])), toolPolicyMiddleware()],
    backend: o.backend,
    // A backend that runs commands takes no path rules (DeepAgents refuses them): there the read-only
    // bind and the refused uploads are what keep the source unwritten.
    ...(isSandboxBackend(o.backend) ? {} : { permissions: [{ operations: ["write"], paths: ["/**"], mode: "deny" }] }),
    interruptOn: interruptOn(o.gated ?? [APPLY_PATCH], o.auto),
    checkpointer: o.checkpointer,
  })
}
