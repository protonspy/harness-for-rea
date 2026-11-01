---
autonomy: auto
ci: wait
branch: feat/finish-the-harness
delivery: in-progress
---

# Analysis contract — requirements

## Purpose

Makes an analysis checkable by the app rather than read from prose: the specialist ends each report
with a machine-readable contract — the functions it mapped, the constants it found, each tied to a
source or marked estimated, and the questions it left open or closed — which the app validates and
sends back when it fails. What one analysis leaves open is kept per project, in an unknowns ledger,
and handed to the next delegation of the project. Drawn from [[craft-anything]]'s contract and
ledger; for the orchestrator consolidating analyses and the user following a project.

## R1 · The contract

- **R1.1** (MODIFIED) The specialist's instructions shall ask for a report that ends with a JSON contract listing the functions mapped with their inputs, outputs and side effects, the constants found each with a source or marked estimated, the unknowns opened, the earlier unknowns closed, and the test vectors observed (specs/vector-replay R1.2).
- **R1.2** When a delegation's report arrives, the delegation shall validate its contract, refusing a constant that has neither a source nor `estimated: true`.
- **R1.3** If a report's contract is missing or invalid, then the delegation shall return the problems to the specialist in the same session for a corrected report, at most twice.
- **R1.4** If the contract is still invalid after the last correction, then the delegation shall finish with the last report and record that its contract failed, with the problems.
- **R1.5** The delegation shall give the orchestrator the validated contract with the report.

## R2 · The unknowns ledger

- **R2.1** When a delegation of a project returns a valid contract, the app shall add each unknown it opened to the project's unknowns ledger, tied to that analysis.
- **R2.2** When a contract closes an open unknown of the project by its id, the app shall mark it closed with its resolution and the analysis that closed it.
- **R2.3** If a contract closes an unknown that is not open in the project, then the app shall leave the ledger unchanged for that item and record why.
- **R2.4** When a delegation of a project starts, the app shall put the project's open unknowns into its context package.
- **R2.5** The desktop UI shall show a project's unknowns, open and closed, on the project's view.

## Out of scope

- Checking that a sourced constant appears in the orchestrator's code.
- Feeding REA's own `record_unknown` into the ledger.
