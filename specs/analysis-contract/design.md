# Analysis contract — design

## What changes

Serves R1.1–R2.5.

- `src/shared/contract.ts` (new) — `ContractSchema` (zod) and `readContract(report)`: the last fenced
  ```` ```json ```` block of the report, parsed and validated; the problems, one line each, when it
  is missing or invalid (R1.2).
- `src/main/sandbox/prompt.ts` — the system prompt states the contract's shape and that it ends the
  report, whatever report format the package names (R1.1). `renderPrompt` gains a section listing
  the project's open unknowns by id, with how to close one (R2.4).
- `src/main/delegation.ts` — after the first answer, up to `CONTRACT_ROUNDS` (2) further turns in
  the same session carry the problems back (R1.3), each logged as `contract.rejected`. The step
  records `contract` or `contractProblems` (R1.4). Usage is counted from every turn's result event,
  no longer from the last result alone. With a project, open unknowns go into the prompt and a valid
  contract updates the ledger (R2.1–R2.3).
- `src/main/db.ts` — migration 4: `unknowns (id, project_id, question, severity, probes, settle,
  raised_by, closed_by, resolution, created_at, updated_at)`.
- `src/main/unknowns.ts` (new) — the ledger: `open(projectId)`, `list(projectId)`, and
  `record(projectId, stepId, contract)` which adds and closes, returning what it ignored (R2.1–R2.3).
- `src/main/orchestrator/tools.ts` — `delegate_to_specialist` returns `contract` (or
  `contractProblems`) beside the report (R1.5).
- `src/shared/api.ts`, `src/main/index.ts`, `ProjectView.tsx` — `getProject` also returns the
  project's unknowns, open first, which the view lists; it already reloads when a delegation moves
  (R2.5).

## Data

```json
{
  "functions": [{ "name": "", "inputs": [""], "outputs": [""], "sideEffects": [""], "source": "" }],
  "constants": [{ "name": "", "value": 0, "source": "path:10-12 | path@0x… | ev_…", "estimated": false }],
  "unknowns": [{ "question": "", "severity": "low | medium | high", "probes": [""], "settle": "" }],
  "closes": [{ "id": "", "resolution": "", "source": "" }]
}
```

Every list defaults to empty, so a step that maps nothing still returns `{}`.
