# TUI shell — tasks

## 1 · The frame

- [ ] 1.1 (Unit) Build the theme tokens, the key map with its layers and labels, and the command registry with prefix and fuzzy filters — R1.3, R2.1, R2.2, R2.3
- [ ] 1.2 (Unit) Build the shell: status line, body, sidebar toggle, prompt, hint line, toasts, dialogs and the help overlay, with Esc and Ctrl+C handled — R1.1, R1.2, R1.4, R2.4, R2.5, R3.1, R3.2, R3.3
  _Depends 1.1_
- [ ] 1.3 (Unit) Add slash-command completion to the prompt and the Ctrl+P palette, and keep a list's selection by id across pushes — R2.2, R2.3, R1.5
  _Depends 1.2_

## 2 · Screen tests

- [ ] 2.1 (Unit) Test the shell on OpenTUI's test renderer with simulated keys and a scripted API: the help lists every key, `/` and Ctrl+P list every command — R4.1, R2.1, R2.2, R2.3
  _Depends 1.3_
