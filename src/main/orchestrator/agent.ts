import type { BaseCheckpointSaver } from "@langchain/langgraph"
import { createDeepAgent, type BaseSandbox, type FilesystemBackend } from "deepagents"
import { todoListMiddleware } from "langchain"
import type { ChatOpenRouter } from "@langchain/openrouter"
import { APPLY_PATCH, applyPatchTool, delegateTool, type ToolContext } from "./tools"

/*
  The orchestrator agent (specs/orchestrator R2, R3.1; adr:0001-use-deepagents-on-openrouter-for-orchestration):
  DeepAgents with `write_todos` for decomposition, the source tree read-only in the task's sandbox
  (adr:0007-run-the-orchestrators-tools-in-a-task-container), the specialist as a tool, and
  `apply_patch` paused for the user's decision.
*/

export type AgentBackend = BaseSandbox | FilesystemBackend

export function systemPrompt(root: string): string {
  return [
    "You are the orchestrator of a software engineering task on the user's own source code: legacy-system comprehension, debugging, or authorized reverse engineering.",
    "",
    "How to work:",
    "1. Plan first: break the task into steps with write_todos, and keep the list current as steps finish.",
    `2. Explore the source tree yourself with ls, glob, grep and read_file. It is mounted read-only at \`${root}\`; you cannot write to it. Where execute is available it runs in an isolated container with no network, for read-only inspection such as git log.`,
    "3. For each step that needs deep reasoning on specific code, call delegate_to_specialist with a context package. Write its brief yourself: the background the specialist needs and the real purpose of the step as the user's request states it — what the system is, who owns it, why this analysis is being done. Never invent ownership, authorization or purpose the request does not support. Then give the objective, the files it needs, the excerpts to look at first, environment facts, the questions to answer and the constraints. The specialist sees only those files and that package — never this conversation — so make the package complete on its own and keep it narrow.",
    "4. When a change is needed, delegate in mode 'modify'. The specialist returns a patch; call apply_patch with its patchId to apply it. The user approves or rejects every patch; a rejection is final for that patch.",
    "5. Check the specialist's evidence against the files before relying on it.",
    "6. Finish with one consolidated answer: what was found, what changed (if anything), and the evidence for each claim as path:start-end.",
  ].join("\n")
}

export function buildAgent(o: { model: ChatOpenRouter; ctx: ToolContext; checkpointer: BaseCheckpointSaver; backend: AgentBackend }) {
  return createDeepAgent({
    model: o.model,
    systemPrompt: systemPrompt(o.ctx.root),
    tools: [delegateTool(o.ctx), applyPatchTool(o.ctx)],
    middleware: [todoListMiddleware()],
    backend: o.backend,
    permissions: [{ operations: ["write"], paths: ["/**"], mode: "deny" }],
    interruptOn: { [APPLY_PATCH]: { allowedDecisions: ["approve", "reject"] } },
    checkpointer: o.checkpointer,
  })
}
