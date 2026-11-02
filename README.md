# Harness for REA

A desktop app and a terminal UI for deep analysis of software you own or are authorized to study:
understanding a legacy system, debugging, reverse engineering a binary or an app, and porting or
reimplementing what it does.

You describe what you want in a chat. Two agents do the work:

- **The orchestrator** is the agent you talk to. It runs on a model from OpenRouter, DeepSeek or any
  OpenAI-compatible provider. It plans the task, prepares each step, writes and runs its own code
  (a decoder, a reimplementation, a probe) and answers you. It does not analyse the target itself.
- **The specialist** does the deep analysis. It is Claude Opus running the Claude Code CLI on your
  own Claude plan, inside a Docker container that holds only the files a step needs, with
  [REA](https://github.com/morluto/rea) — a reverse engineering MCP server for native binaries,
  Android, .NET, Electron and JavaScript targets — built in, and a root shell to install any other tool.

The split keeps the expensive, careful work with the specialist and the cheap planning and coding
with the orchestrator, and keeps the target away from your machine: the specialist only ever sees
copies of the files it was handed.

## How a task runs

```
 you ──chat──▶ orchestrator (your provider's model, in the app)
                  │  plans the steps, reads your code, writes its own in /scratch
                  │  (its tools run in a task container: /workspace read-only, /scratch writable)
                  │
                  ├─ delegate a step ──▶ specialist (Claude Code in a container per step)
                  │    context package:      /work = copies of the files listed
                  │    brief, objective,     REA, a shell, internet
                  │    files, questions      ── report + evidence + contract ──▶ back
                  │
                  ├─ replay test vectors ─▶ its own code, in the task container
                  └─ propose a patch ─────▶ you approve, then it is applied to your files
```

1. **You start a task** in a project with a request. The orchestrator breaks it into steps.
2. **For each analysis**, the orchestrator writes a *context package*: a technical brief (what the
   artifact is, what is already known), the objective, the files, the questions and the report
   format. The specialist sees that package and nothing else — not your request, not the chat.
3. **The specialist runs** in a fresh container (or a sandbox the orchestrator prepared with tools
   and files), with the files copied into `/work`. It answers with a report whose claims cite
   evidence: a line range, an address in a binary, or an REA evidence id.
4. **Every report ends with a contract**, a JSON block the app validates: the functions mapped with
   their inputs, outputs and side effects; the constants found, each with a source or marked
   estimated; the questions left open; and *test vectors* — inputs given to the target and the
   output it produced, observed by running it. A report whose contract fails is sent back to the
   specialist for a correction, up to twice.
5. **The orchestrator writes its code** from the report and checks it with `replay_vectors`, which
   runs the vectors against its reimplementation and compares outputs byte for byte.
6. **Changes to your files** come back as patches. Nothing outside the task's containers changes
   until a patch is applied.

**Questions.** Either agent can ask you a question mid-run. The specialist's questions go first to
the orchestrator's model, which answers from the context package when it can; questions about
authorization, ownership or purpose always come to you.

**Refusals.** If the specialist declines a step under its usage policy, the task waits for you to
stop it, skip the step, or ask for a different technical approach. The request is never reworded to
get past the refusal.

**Projects.** A project is one target — a file (an APK, an executable, an archive) or a folder —
with a goal and the model its tasks use. Tasks in a project share its sandboxes and everything
earlier tasks found, and the questions one analysis left open are handed to the next.

## Isolation

- The specialist runs in a container per delegation, or in a sandbox the orchestrator created for
  the project; it sees only the files copied into it, as root, with internet access. Its Claude
  Code runs with no user or project settings, so a `CLAUDE.md` or settings left in `/work` by an
  earlier step are never loaded.
- The orchestrator's tools run in a task container where your source is mounted read-only; it
  writes only to its own scratch area.
- The specialist signs in with your Claude plan once; the token lives in a Docker volume.
- Provider API keys are kept in the OS keychain — encrypted with it by the desktop app, stored in it
  by the terminal UI — and redacted from everything the app records or sends to a model.
- Everything the agents do is recorded per task: an event log in SQLite and each agent's raw output
  as JSONL, in the app's data folder.

## What you need

- **Docker** (Docker Desktop on Windows and macOS), running. At the first start the app pulls the
  specialist's base image from GHCR and builds the specialist image on it.
- **A Claude plan** (Pro or Max) for the specialist.
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

1. **Sandbox images** — Docker running and the specialist image prepared.
2. **Claude sign-in** — runs in a container: open the link it shows, sign in with your Claude plan,
   and paste the code back.
3. **Orchestrator** — the provider, its API key and the model.

In the terminal UI the steps are commands on the input line: `/images`, `/login`, then
`/code <code>`, `/key <key>`, `/model <model id>`, and `/done` once every step is ready.

## Using it

**Desktop app.** Create a project from a target and a goal, then start tasks in it. A task shows as
a chat: the messages, each tool call, and each delegation as a card with the specialist's own steps
inside it. Long tasks load their history in pages as you scroll up. The side panel has the plan,
the delegations with their reports and evidence, the cost per agent, and the raw event log. The
project page lists its tasks, what the specialist found, and the questions still open.

**Terminal UI.** The same projects and tasks in a terminal. Tab moves between the list and the input
line, Enter opens, Escape goes back. On a task, the input line sends a message or answers the
question that waits, and takes `/stop`, `/cancel`, `/continue` and `/older`.

The two apps share one data folder, so only one can be open at a time; the second names the first
and exits. `harness-for-rea --version` and `--help` work at any time.

## How the code is organized

```
src/main/            the core (Node): Electron shell and everything behind it
  core.ts            wires the database, event log, projects, sandboxes, runner and API handlers
  index.ts           the Electron shell: window, IPC, dialogs
  orchestrator/      the orchestrator agent, its tools, the task runner, the model
  delegation.ts      one delegation: workspace, specialist run, contract check, patch
  specialist/        running Claude Code and reading its stream-json output
  sandbox/           Docker: images, containers, sandboxes, prompts, patches
  events/            the event log (SQLite + JSONL) and redaction
  unknowns.ts        the per-project ledger of open questions
src/shared/          types and the IPC contract (zod schemas) shared with the views
src/renderer/        the desktop UI (React, Tailwind, shadcn/ui on Radix)
tui/                 the terminal UI (OpenTUI on Bun) and its npm package
sandbox/             the specialist's images: the published base and the local layer with Claude Code
scripts/             test gate, image pinning, CLI build
tests/               Vitest suite; the specialist is faked by tests/fixtures/fake-claude.mjs
```

The desktop app and the terminal UI run the same core: `startCore()` takes the data folder, how to
deliver updates to the view, and where keys are kept, and returns the API handlers. Every call from
either UI goes through the same validating dispatcher.

## Development

Node 24 and npm; Docker for the sandboxes; Bun 1.4 for the terminal UI.

```bash
# Install (npm 11 skips install scripts; the Electron binary is fetched by its own script)
npm install
node node_modules/electron/install.js

# Typecheck, then build main, preload and renderer into out/
npm run typecheck && npm run build

# Run the desktop app in development
npm run dev

# Run the terminal UI from source
npm run tui

# Tests: the suite, one file, and the coverage report the CI gate reads
npm test
npx vitest run tests/orchestrator.test.ts
node scripts/test-gate.mjs

# Tests against the real Docker and your Claude login, and against Bun
HFR_DOCKER=1 npx vitest run tests/claude-md.test.ts
HFR_BUN=1 npx vitest run tests/bun-core.test.ts

# Lint and format
npm run lint
npm run format:check

# Package: Windows installer, macOS disk images, the CLI's npm package and a standalone binary
npm run dist
npm run dist:mac
bun scripts/build-cli.ts package
bun scripts/build-cli.ts binary bun-windows-x64 cli
```

Tests run the TypeScript sources directly. The specialist is `tests/fixtures/fake-claude.mjs`, which
speaks Claude Code's stream-json; the orchestrator's provider is a scripted `fetch`.

To release, bump `version` in `package.json` and run the **Release** workflow on `main`. It builds
everything above for Windows and macOS, publishes a GitHub Release, and publishes the CLI to npm
with the `NPM_TOKEN` repository secret.

## License

MIT.
