---
status: accepted
---

# 0011 · Limit the orchestrator to planning, delegation and its own code

## Context

The harness splits the work by cost and skill. The orchestrator is a coding assistant
on a cheap OpenRouter model — the user means Chinese coding models such as DeepSeek —
that plans the task, prepares each analysis and writes the code. The specialist, Claude
Opus in its own container, does the deep research and the reverse engineering. The flow
the user wants: the orchestrator needs part of a binary understood, prepares a sandbox
holding only the context and files that analysis needs, delegates it, and writes code
from what the specialist returns. adr:0009-give-the-orchestrator-a-writable-scratch gave
the orchestrator `/scratch` and `execute` for that code, and specs/chat R6.1 asked it, in
its instructions only, to leave analysis to the specialist. A real task showed
instructions alone are weak: asked to analyse an APK, the orchestrator made 157 tool
calls of its own — a ZIP reader, an AXML decoder and a DEX parser in Perl — delegated
nothing, and answered from its own reading. DeepAgents binds a general-purpose `task`
subagent and `delete` besides the file tools, so the orchestrator could also hand the
analysis to a second cheap agent. And the orchestrator had no way to hand its own code
to the user, or to the specialist: only a specialist's modify-mode delegation produced
a patch, and a delegation carried only source files.

## Decision

The orchestrator keeps the tools a coding assistant needs: `write_todos`, `ls`, `glob`,
`read_file` and `grep` (to read the user's code it writes or integrates with),
`write_file`, `edit_file` and `execute` (whose writes land only in `/scratch`),
`delegate_to_specialist`, `propose_patch`, `apply_patch` and `ask_user`. A middleware in
`src/main/orchestrator/agent.ts` hides every other tool from the model and refuses a call
to one; it is an allowlist, so a tool a later DeepAgents release adds stays hidden. Its
instructions name it a coding assistant and send every analysis of the target —
disassembly, decompilation, formats, protocols, behaviour — to the specialist, with a
package complete enough for the analysis to run without obstacles and a report the
orchestrator can write code from (contracts, constants, test vectors). `propose_patch`
turns files the orchestrator wrote in `/scratch` into a patch against the current
originals, which `apply_patch` takes through the existing approval. A delegation may
carry files from `/scratch` — a harness, a script, code for the specialist to check
against the target — given to the specialist under `.orchestrator/` and never part of
a patch. adr:0009-give-the-orchestrator-a-writable-scratch and
adr:0007-run-the-orchestrators-tools-in-a-task-container stand. Rejected: keeping
every tool, which leaves the `task` subagent as a second analyst; confining
`read_file` and `grep` to `/scratch`, which stops the orchestrator reading the code it
must integrate with; removing `execute` and having the specialist compile and test the
orchestrator's code, which costs an Opus run per test cycle; and a second container
with no source mounted for `execute`, which costs a container per task and splits the
file tools from `execute`.

## Consequences

- The orchestrator can still read the target with `read_file`, `grep` and `execute`;
  only its instructions keep it from analysing. If cheap models keep analysing anyway,
  confining what its container mounts is the next step.
- Every analysis costs a delegation, so a task spends more on the specialist; the
  orchestrator re-delegates when a report or its own tests do not hold.
- The orchestrator's patch is checked against the originals' hashes at proposal time
  like a specialist's, so a file changed in between is a conflict, not an overwrite.
- Files the orchestrator prepares reach the specialist's workspace but neither its
  snapshot nor a patch; a specialist edit to them is dropped.
- The allowlist hides tools from one model; it does not remove them from the graph,
  so the read-only container remains what keeps the source unchanged.
