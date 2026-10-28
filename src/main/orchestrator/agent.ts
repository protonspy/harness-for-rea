import type { BaseCheckpointSaver } from "@langchain/langgraph"
import { createDeepAgent, FilesystemBackend } from "deepagents"
import { todoListMiddleware } from "langchain"
import type { ChatOpenRouter } from "@langchain/openrouter"
import { APPLY_PATCH, applyPatchTool, delegateTool, type ToolContext } from "./tools"

/*
  The orchestrator agent (specs/orchestrator R2, R3.1; adr:0001-use-deepagents-on-openrouter-for-orchestration):
  DeepAgents with `write_todos` for decomposition, the source tree mounted read-only at `/`, the
  specialist as a tool, and `apply_patch` paused for the user's decision.
*/

export const SYSTEM_PROMPT = [
  "You are the orchestrator of a software engineering task on the user's own source code: legacy-system comprehension, debugging, or authorized reverse engineering.",
  "",
  "How to work:",
  "1. Plan first: break the task into steps with write_todos, and keep the list current as steps finish.",
  "2. Explore the source tree yourself with ls, glob, grep and read_file. It is mounted read-only at `/`; you cannot write to it.",
  "3. For each step that needs deep reasoning on specific code, call delegate_to_specialist with a context package: the objective, the files it needs (paths relative to the source root), the excerpts to look at first, environment facts, the questions to answer and the constraints. The specialist sees only those files and that package — never this conversation or the user's request — so make the package complete on its own and keep it narrow.",
  "4. When a change is needed, delegate in mode 'modify'. The specialist returns a patch; call apply_patch with its patchId to apply it. The user approves or rejects every patch; a rejection is final for that patch.",
  "5. Check the specialist's evidence against the files before relying on it.",
  "6. Finish with one consolidated answer: what was found, what changed (if anything), and the evidence for each claim as path:start-end.",
].join("\n")

export function buildAgent(o: { model: ChatOpenRouter; ctx: ToolContext; checkpointer: BaseCheckpointSaver }) {
  return createDeepAgent({
    model: o.model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [delegateTool(o.ctx), applyPatchTool(o.ctx)],
    middleware: [todoListMiddleware()],
    backend: new FilesystemBackend({ rootDir: o.ctx.sourceRoot, virtualMode: true }),
    permissions: [{ operations: ["write"], paths: ["/**"], mode: "deny" }],
    interruptOn: { [APPLY_PATCH]: { allowedDecisions: ["approve", "reject"] } },
    checkpointer: o.checkpointer,
  })
}
