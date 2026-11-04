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

- **orchestrator** — the DeepAgents agent on a model from Hopper, OpenRouter, DeepSeek or another OpenAI-compatible provider that plans a task, delegates steps and consolidates the results. Avoid: coordinator, planner agent
- **specialist** — the agent that does a step's deep analysis: by default a DeepAgents agent on the host on a provider's model whose every tool runs in its sandbox, or Claude Opus through the pinned Claude Code CLI on the user's plan (adr:0028-run-the-specialist-on-a-provider-model-as-a-deepagents-agent). Avoid: expert agent, worker agent
- **specialist provider** — what the specialist runs on: one of the orchestrator's providers, Hopper by default, its key shared with the orchestrator, or the Claude plan. Avoid: specialist backend, specialist vendor
- **delegation** — handing one step from the orchestrator to the specialist with a context package. Avoid: handoff
- **context package** — what a delegation carries: the orchestrator's brief, objective, files and excerpts, environment facts, questions, constraints, and the expected report format. Avoid: context bundle
- **brief** — the orchestrator's own technical prompt to the specialist inside a context package: what the artifact is, what is known about it and what one step must discover, never the user's request or purpose (adr:0019-keep-the-specialists-brief-technical). Avoid: narrative, pretext
- **sandbox** — the container the specialist runs in, with `workspace/<uuid>/` holding copies of only the files it was given mounted at `/work`: one the orchestrator created and prepared (`hfr-sbx-<id>`), or a delegation's own
- **evidence** — a claim in a report tied to a file and line range, or to a captured tool output, that the orchestrator can check
- **event** — one normalized, redacted record of an agent action, stored in SQLite and shown in the UI
- **patch approval** — the user's explicit decision to apply a change produced in the sandbox to the original files
- **task** — one request from the user in a project, run by the orchestrator from start to its consolidated answer. Avoid: job
- **step** — one unit of a task: a todo the orchestrator wrote, or a delegation
- **workspace** — `workspace/<uuid>/` under the app's data folder, the copies a delegation's sandbox mounts at `/work`, with its snapshot and run directory beside it
- **base image** — `hfr-specialist-base` on GHCR: the specialist image without Claude Code, pinned by digest in `sandbox/images.json`
- **specialist image** — `hfr-specialist:<version>`, built locally from the base image plus the verified Claude Code CLI
- **project** — a target with a goal, a model and its tasks, which share the project's sandboxes and analyses (adr:0020-group-tasks-into-projects-that-share-their-analyses)
- **target** — the file or folder a project analyses: a file is copied into the project's folder, a folder is read in place
- **analysis** — a delegation's report with its evidence, kept with the project so every later task of it can read it
- **safeguard refusal** — the specialist declining a step under its usage policy: its own state, never a failure to retry or a request to reword
- **unknowns ledger** — the project's list of what an analysis left open, each item tied to the analysis that raised it and the one that closed it
- **test vector** — an input and the output the target produced for it, recorded by an analysis and replayed against a reimplementation
- **chat timeline** — the task view: each agent's turns, tool calls and delegations, the specialist's own tool calls nested under its delegation
- **TUI** — the terminal UI on OpenTUI under Bun, beside the desktop app
- **MCP integration** — an engine on the user's machine, such as Cheat Engine or IDA Pro, that the app carries in its own list and the agents reach only through the app, each of its tools checked per agent in Settings (adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations). Avoid: connector, custom MCP server
- **integration target** — what an MCP integration's tools work on, such as one Windows process by pid for Cheat Engine or one database by its input file's SHA-256 for IDA Pro, approved by the user in every task; not a project's target. Avoid: attached process
- **bridge** — the app's read-only Lua script in Cheat Engine's autorun folder, derived from the upstream cheatengine-mcp-bridge, answering the app on its own named pipe. Avoid: CE script
- **IDA plugin** — the app's read-only Python plugin in IDA's user plugins folder, derived from the upstream ida-pro-mcp, answering the app on its own named pipe (adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe). Avoid: IDA bridge
- **integration skill** — the guide an MCP integration carries for the specialist on working with its tools, written into a delegation's run directory only while the integration answers; not REA's skill. Avoid: integration prompt, tool guide
