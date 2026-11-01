# craft-anything

[storytold/craft-anything](https://github.com/storytold/craft-anything) is a Rust desktop
app, CLI and MCP server (early alpha, MIT OR Apache-2.0) that studies a website, app or game,
has a coding agent rebuild it, and checks the rebuild against the original. It is the nearest
public relative of this harness: its builder is also Claude Code, driven with `claude -p`. It
differs on who does what. There, one agent analyses and builds; here, the split
between orchestrator and specialist keeps the analysis with the specialist and the code with
the orchestrator (adr:0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code).

## How it works

A run has four stages (`crates/ai/src/rebuild/mod.rs`):

1. **Study.** No model is involved. It triages the target, prepares Ghidra and, for a console
   program, runs the original on fixed inputs. It writes `capture/README.md` for the builder.
2. **Build.** The user's local `claude -p` runs on the host, with the project folder as its
   working folder, craft-anything's MCP server attached, and an approval tool. The prompt
   rules are in `brief.rs`.
3. **Check.** Pluggable checks score the rebuild:
   - it builds;
   - it prints and exits like the original for each captured input;
   - every value in `app/mechanics.json` carries a `source` (function address or evidence
     id) or `estimated: true`, and every sourced number appears in the code as written.

   Missing evidence never counts as a pass (`crates/engine/src/workspace.rs`).
4. **Refine.** The first failing check goes back to the builder. This stops after six rounds,
   or once 90% of the checks pass.

The builder keeps an **unknowns ledger** (`crates/evidence/src/unknown.rs`). Each entry holds
a question, its severity, the probes tried, evidence for and against, and a resolution. The
builder must record a gap before guessing, and the final status counts what is still open.

## What it suggests for this harness

The ideas below are ranked by value. Ideas carry no license obligation. Prompt text copied
word for word would need the MIT notice.

- **Evidence that points into a binary.** Let a report cite a function address or an REA
  evidence id as well as `path:lines`. Today `parseEvidence` in `src/shared/context.ts` drops
  anything that is not `path:<line>` without saying so.
- **A machine-readable contract at the end of a report.** List functions with inputs, outputs
  and side effects; constants, each with a source or `estimated: true`; and test vectors. The
  app can then check that each sourced constant reaches the orchestrator's code, instead of a
  cheap model extracting them from prose.
- **Vectors observed, not inferred.** The specialist runs the original in its sandbox and
  records input/output pairs. A tool replays them against the reimplementation. Re-delegation
  stops after a bounded number of rounds.
- **A task-scoped unknowns ledger.** Open questions carry over into each new context package
  and appear in the final answer. REA's own `record_unknown` can feed it.
- **A reminder when the orchestrator concludes without delegating.** This is the fallback
  adr:0011 says instructions alone lack.
- **Evidence discipline in the specialist's prompt.** Missing evidence is never proof. Mark a
  value estimated only after looking for it. Record each open question with what would settle
  it.

## What does not fit

These parts conflict with how the harness is built:

- Running `claude` on the host breaks the container boundary of
  adr:0006-run-the-specialist-inside-a-container-per-task.
- One agent that analyses and builds breaks the split of adr:0011.
- Edits allowed without approval break patch approval.

These parts are off purpose:

- its asset and likeness checks;
- the 284-tool engine, which REA covers here ([[rea-in-the-sandbox]]).
