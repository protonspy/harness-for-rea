# tui-0-1-defects

The terminal UI shipped in 0.1 (`tui/src/app.ts`, `tui/src/view.ts`, specs/tui) walked through
the first-run setup, a project, a long task, a question and a safeguard refusal beside the
desktop app on the same machine, and read against the renderer's views. Each defect carries the
steps that show it; each parity gap names the API method the desktop app's views call that the
0.1 TUI never reaches. The revamp (plans/tui-revamp.md) fixes them, and each spec that does
links back here.

## Defects

1. **The folder it is run in is ignored.** Run `harness-for-rea` inside a sample's folder: it
   opens the projects list, never the folder, and `harness-for-rea C:\samples\x` is not
   accepted. Fixed by specs/tui-launch.
2. **Only one app on the data folder.** Open the desktop app, then run the TUI: it prints
   "already open in the desktop app" and exits — and the reverse holds. Two TUIs in two
   folders cannot run either. Fixed by specs/shared-data-folder.
3. **One single-line input for everything.** A request cannot span lines, there is no history
   (Up does nothing), and the line means a command, an answer or a message depending on the
   screen and on whether a question waits — typing a reply while a question arrives answers
   the question. Fixed by specs/tui-shell and specs/tui-conversation.
4. **The whole timeline is redrawn as one plain-text block on every event.** Start a long
   task: each event rebuilds every line, scrolling back jumps to the bottom on the next event,
   markdown shows raw (`**`, fences), and code is not highlighted. Fixed by
   specs/tui-conversation.
5. **Tool calls and delegations cannot be opened.** A run of tool calls is one summary line
   and a delegation is its title plus the specialist's one-line entries: the context package,
   the report, the evidence and the files copied, read and written are nowhere. Fixed by
   specs/tui-conversation.
6. **A gated tool call is invisible.** The timeline skips the `approval` block, so a task
   waiting on a decision shows nothing to decide and stalls. Fixed by specs/tui-conversation.
7. **Lists lose their place.** On the projects or a project's screen, every `task` push
   refetches the screen and reassigns the list's options, so the selection jumps back to the
   top while another task runs; on a project's screen pushes of other projects' tasks
   refetch it too. Fixed by specs/tui-shell.
8. **Tab between a list and the input is the only navigation.** On a project's screen, text
   typed while the list was meant to have focus starts a task. Escape does nothing on the
   setup and projects screens. Fixed by specs/tui-shell.
9. **Ctrl+C quits at once.** Pressed during a running turn it stops every task of the app
   without asking. Fixed by specs/tui-shell (Ctrl+C twice, Esc to interrupt).
10. **Errors vanish.** An error goes to the status line, and the next redraw replaces it with
    the screen's help text. Fixed by specs/tui-shell (toasts).
11. **Creating a project needs a command grammar.** `/new <name> | <goal> | <target path>`,
    with no detection of the target's kind and no prefill from the Settings model. Fixed by
    specs/tui-launch and specs/tui-panels.
12. **The setup cannot finish without the desktop app's help.** `/login` prints the sign-in
    URL but never opens the browser; a sign-in cannot be cancelled and Claude cannot be signed
    out; the image build shows no log; `/key` sets the current provider's key with no way to
    pick a provider or a base URL, and `/model` takes an id with no list to pick from. Fixed
    by specs/tui-panels.
13. **Nothing after the setup can be changed.** No settings: provider, model, efforts,
    timeouts. Fixed by specs/tui-panels.
14. **A task's working state is a word.** The header shows `[running]`: no elapsed time, no
    tokens, no cost, no plan. Fixed by specs/tui-conversation and specs/tui-panels.

## Parity gaps

The desktop app's views call 36 API methods; the 0.1 TUI reaches 18. Not reached:

| Method | Where the desktop app calls it | Fixed by |
|---|---|---|
| `decidePatch` | a patch's approve and reject | specs/tui-conversation |
| `decideTool` | a gated tool call's approve, edit and reject | specs/tui-conversation |
| `closeTask` | Close on a task | specs/tui-conversation |
| `deleteTask` | Delete on a task | specs/tui-conversation |
| `retryTask` | Start over on an interrupted, failed or cancelled task | specs/tui-conversation |
| `listTasks` | the sidebar's recent tasks | specs/tui-launch (`--resume`) |
| `deleteProject` | the project overview | specs/tui-panels |
| `detectTarget` | the new-project dialog | specs/tui-launch |
| `pickTarget`, `pickFolder` | the new-project dialog's pickers | specs/tui-launch (typed paths) |
| `sandboxStatus` | the setup's image step and its banner | specs/tui-panels |
| `loginStatus` | the setup's sign-in step | specs/tui-panels |
| `openLoginUrl` | the sign-in's Open button | specs/tui-panels |
| `cancelLogin` | the sign-in's Cancel | specs/tui-panels |
| `logout` | the sign-in's Sign out | specs/tui-panels |
| `keyStatus` | the provider step | specs/tui-panels |
| `clearKey` | the provider step's Remove | specs/tui-panels |
| `listModels` | the model picker | specs/tui-panels |

The task view's event log, its usage per agent and the project's analyses and unknowns are
shown by the desktop app from data the TUI already fetches and never draws.
