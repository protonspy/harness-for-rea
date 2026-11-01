# Harness for REA

A desktop app and a terminal UI for deep analysis of software you own or are authorized to study:
legacy-system comprehension, debugging, reverse engineering, and porting or reimplementing a target.

Two agents split the work:

- **The orchestrator** — a [DeepAgents](https://github.com/langchain-ai/deepagentsjs) agent on a model
  from OpenRouter, DeepSeek or any OpenAI-compatible provider. It plans the task, prepares each step,
  writes and runs its own code in a scratch area, and talks to you. It never analyses the target
  itself ([adr:0011](docs/adr/0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code.md)).
- **The specialist** — Claude Opus running the pinned Claude Code CLI on your own Claude plan, inside a
  Docker container per delegation that sees only the files it was given, with
  [REA](https://github.com/morluto/rea), the reverse engineering MCP server, built in
  ([adr:0006](docs/adr/0006-run-the-specialist-inside-a-container-per-task.md),
  [adr:0018](docs/adr/0018-make-rea-native-to-the-specialist.md)).

Every report ends with a machine-readable contract — functions, constants with their sources,
unknowns, and test vectors the specialist observed by running the target — which the app checks,
keeps per project, and lets the orchestrator replay against its own reimplementation.

## What you need

- **Docker** (Docker Desktop on Windows and macOS), running. The app pulls the specialist's base
  image from GHCR and builds the specialist image on it at the first start.
- **A Claude plan** (Pro or Max) for the specialist. You sign in once, from the app, inside a
  container; the token stays in a Docker volume.
- **An API key** for the orchestrator's provider: OpenRouter by default, DeepSeek, or any
  OpenAI-compatible endpoint.

## Install

Download the build for your system from the
[releases](https://github.com/protonspy/harness-for-rea/releases):

| System | Desktop app | Terminal UI |
|---|---|---|
| Windows x64 | `harness-for-rea-<version>-windows-x64-setup.exe` | `harness-for-rea-cli-<version>-windows-x64.zip` |
| macOS arm64 (Apple silicon) | `harness-for-rea-<version>-macos-arm64.dmg` | `harness-for-rea-cli-<version>-macos-arm64.tar.gz` |
| macOS x64 (Intel) | `harness-for-rea-<version>-macos-x64.dmg` | `harness-for-rea-cli-<version>-macos-x64.tar.gz` |

Nothing is signed or notarized, so each system asks once:

- **Windows** — SmartScreen may stop the setup: choose **More info**, then **Run anyway**.
- **macOS, the desktop app** — drag it from the disk image to Applications, then, before the first
  launch, run:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Harness for REA.app"
  ```

- **macOS, the terminal UI** — unpack the archive, then run in its folder:

  ```bash
  xattr -dr com.apple.quarantine ./harness-for-rea
  ./harness-for-rea
  ```

  Keep the `sandbox/` folder next to the binary: it holds the specialist image's sources.

The terminal UI is also on npm, for Windows and macOS:

```bash
npm install -g harness-for-rea
harness-for-rea
```

## First run

Both apps open on a setup of three steps, and nothing else opens until all three are ready:

1. **Sandbox images** — Docker running, and the specialist image prepared (it is prepared at start;
   preparing it again is one action).
2. **Claude sign-in** — the sign-in runs in a container: open the link it shows, sign in with your
   Claude plan, and paste the code back.
3. **Orchestrator** — the provider, its API key and the model. The desktop app keeps the key encrypted
   with the OS keychain; the terminal UI keeps it in the OS keychain itself.

In the terminal UI the steps are commands typed on the input line: `/images`, `/login`, then
`/code <code>`, `/key <key>`, `/model <model id>`, and `/done` once every step is ready.

## Projects and tasks

A **project** is one target — a file (an APK, an executable, an archive) or a folder — with a goal
(understand, reimplement, integrate or debug) and the model its tasks run with. A **task** is one
request inside a project, run as a conversation: you can send messages while it works, stop and
continue it, and answer the questions either agent asks. The specialist's questions go to the
orchestrator's model first, and reach you only when they need a fact only you have
([adr:0021](docs/adr/0021-answer-the-specialist-from-the-orchestrator-and-let-the-user-decide-a-refusal.md)).

Tasks of a project share its sandboxes, outputs and analyses: a later task reads what an earlier one
found, and the questions an analysis left open are handed to the next one
([adr:0020](docs/adr/0020-group-tasks-into-projects-that-share-their-analyses.md)).

The terminal UI shows the same projects and tasks: Tab moves between the list and the input line,
Enter opens, Escape goes back, and on a task the input line sends a message or answers the question
that waits, with `/stop`, `/cancel`, `/continue` and `/older`. The desktop app and the terminal UI
use the same data folder, so only one of them can be open at a time; the second one names the first
and exits.

## Development

Node 24 and npm; Docker for the sandboxes; Bun 1.4 for the terminal UI.

```bash
# Install (npm 11 skips install scripts; the Electron binary is fetched by its own script)
npm install
node node_modules/electron/install.js

# Build — typecheck the Node, web and TUI tsconfigs, then electron-vite builds main, preload and renderer into out/
npm run typecheck && npm run build

# Run the desktop app in development
npm run dev

# Run the terminal UI from source (needs Bun)
npm run tui

# Test — the whole suite, one file, and the report the gate reads
npm test
npx vitest run tests/orchestrator.test.ts
node scripts/test-gate.mjs

# Tests against the real Docker and your Claude login, and against Bun
HFR_DOCKER=1 npx vitest run tests/claude-md.test.ts
HFR_BUN=1 npx vitest run tests/bun-core.test.ts

# Lint and format
npm run lint
npm run format:check

# Package the desktop app (Windows installer, macOS disk images) and the CLI
npm run dist
npm run dist:mac
bun scripts/build-cli.ts package
bun scripts/build-cli.ts binary bun-windows-x64 cli
```

A release is a maintainer's manual run of the **Release** workflow on `main`, after bumping
`version` in `package.json`; it needs the `NPM_TOKEN` repository secret to publish the CLI.

The specifications live in `specs/`, the plans in `plans/`, and the decisions in `docs/adr/`:

- [0001 · Use DeepAgents on OpenRouter for orchestration](docs/adr/0001-use-deepagents-on-openrouter-for-orchestration.md)
- [0002 · Run the specialist through the pinned Claude Code CLI](docs/adr/0002-run-the-specialist-through-the-pinned-claude-code-cli.md)
- [0003 · Authenticate the specialist with the user's Claude plan](docs/adr/0003-authenticate-the-specialist-with-the-users-claude-plan.md)
- [0004 · Sandbox delegated work in a read-only copy](docs/adr/0004-sandbox-delegated-work-in-a-read-only-copy.md) (superseded)
- [0005 · Store events in SQLite with raw JSONL per task](docs/adr/0005-store-events-in-sqlite-with-raw-jsonl-per-task.md)
- [0006 · Run the specialist inside a container per task](docs/adr/0006-run-the-specialist-inside-a-container-per-task.md)
- [0007 · Run the orchestrator's tools in a task container](docs/adr/0007-run-the-orchestrators-tools-in-a-task-container.md)
- [0008 · Ask the user from the specialist over the run channel](docs/adr/0008-ask-the-user-from-the-specialist-over-the-run-channel.md)
- [0009 · Give the orchestrator a writable scratch](docs/adr/0009-give-the-orchestrator-a-writable-scratch.md)
- [0010 · Build the renderer on shadcn/ui and Radix](docs/adr/0010-build-the-renderer-on-shadcn-ui-and-radix.md)
- [0011 · Limit the orchestrator to planning, delegation and its own code](docs/adr/0011-limit-the-orchestrator-to-planning-delegation-and-its-own-code.md)
- [0012 · Pull the specialist's base image from GHCR](docs/adr/0012-pull-the-specialists-base-image-from-ghcr.md)
- [0013 · Give the sandboxes full internet access](docs/adr/0013-give-the-sandboxes-full-internet-access.md)
- [0014 · Add OpenAI-compatible orchestrator providers](docs/adr/0014-add-openai-compatible-orchestrator-providers.md)
- [0015 · Run the task container as root](docs/adr/0015-run-the-task-container-as-root.md)
- [0016 · Let the orchestrator run the specialist's sandbox](docs/adr/0016-let-the-orchestrator-run-the-specialists-sandbox.md)
- [0017 · Keep a task's conversation, containers and files until it is deleted](docs/adr/0017-keep-a-tasks-conversation-containers-and-files-until-it-is-deleted.md)
- [0018 · Make REA native to the specialist](docs/adr/0018-make-rea-native-to-the-specialist.md)
- [0019 · Keep the specialist's brief technical](docs/adr/0019-keep-the-specialists-brief-technical.md)
- [0020 · Group tasks into projects that share their analyses](docs/adr/0020-group-tasks-into-projects-that-share-their-analyses.md)
- [0021 · Answer the specialist from the orchestrator, and let the user decide a refusal](docs/adr/0021-answer-the-specialist-from-the-orchestrator-and-let-the-user-decide-a-refusal.md)
- [0022 · Run the TUI on Bun with OpenTUI](docs/adr/0022-run-the-tui-on-bun-with-opentui.md)

## License

MIT.
