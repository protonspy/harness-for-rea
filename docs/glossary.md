# Glossary

One canonical term per concept, and the synonyms nobody should use for it. Domain
vocabulary drifts by default — three names for one thing appear within a week of two
people working in parallel — so this file picks the name and the rest become
findings.

One entry per line:

```markdown
- **order total** — the amount charged, in minor units. Avoid: grand total, sum
```

The term is bold, the definition follows an em dash, and `Avoid:` lists the
synonyms it replaces, comma-separated and optional. Every synonym listed here is
reported wherever it appears as a whole word under `docs/`, so list one only when
you mean it.

Reach for the `glossary` skill when a term is coined, contested, or renamed. Define
what the thing *is*, not what it is called, and do not define what is obvious to
anyone in the domain.

<!-- Entries go below this line. Delete the guidance above once they read for
themselves. -->

- **orchestrator** — the DeepAgents agent on an OpenRouter model that plans a task, delegates steps and consolidates the results. Avoid: coordinator, planner agent
- **specialist** — the Claude Opus agent run through the pinned Claude Code CLI for steps that need deep analysis. Avoid: expert agent, worker agent
- **delegation** — handing one step from the orchestrator to the specialist with a context package. Avoid: handoff
- **context package** — what a delegation carries: objective, files and excerpts, environment facts, questions, constraints, and the expected report format. Avoid: context bundle
- **sandbox** — the container a delegation runs in, with `workspace/<uuid>/` holding copies of only the files its context package names mounted at `/work`
- **evidence** — a claim in a report tied to a file and line range, or to a captured tool output, that the orchestrator can check
- **event** — one normalized, redacted record of an agent action, stored in SQLite and shown in the UI
- **patch approval** — the user's explicit decision to apply a change produced in the sandbox to the original files
- **task** — one request from the user about one source folder, run by the orchestrator from start to its consolidated answer. Avoid: job
- **step** — one unit of a task: a todo the orchestrator wrote, or a delegation
- **workspace** — `workspace/<uuid>/` under the app's data folder, the copies a delegation's sandbox mounts at `/work`, with its snapshot and run directory beside it
- **egress proxy** — the `hfr-egress` container, the sandbox network's only route out, allowing Claude Code's required hosts and nothing else
