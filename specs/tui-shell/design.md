# TUI shell — design

## What changes

Serves R1–R4 under adr:0023-build-the-tui-on-opentuis-react-layer. The 0.1 screens (`tui/src/app.ts`,
`tui/src/view.ts`) go; `tui/src/main.ts` becomes `main.tsx`.

```
tui/src/
  main.tsx            flags, the folder, the core, the renderer, <App/>
  app/
    context.tsx       AppContext: the API, the push bus, the theme, toasts, dialogs, the router
    App.tsx           the shell and the router of screens
    keymap.ts         one key map: layers of bindings, the topmost that matches wins (R2.1)
    commands.ts       slash commands, the same list the palette searches (R2.2, R2.3)
    theme.ts          tokens from src/renderer/src/index.css's colors, and a light variant (R1.3)
  components/         StatusLine, Prompt, Sidebar, Palette, Help, Dialogs, Toasts, Markdown, Diff
  screens/            Setup, Projects, NewProject, Project, Task, EventLog, Settings
  lib/                pure logic the screens call, tested by Vitest like the renderer's lib/
```

- **Layout (R1.1, R1.4).** A column: the status line, a row of the screen's body and the sidebar
  when shown (Ctrl+B), the prompt, and one line of key hints. Yoga lays it out again on resize.
- **Keys (R2).** `useKeyboard` is registered once, in `App`. Screens, dialogs and the prompt push a
  layer of bindings while mounted; a key goes to the topmost layer that binds it, so an open dialog
  takes every key. `?` reads the layers to list every binding (R2.1). A binding has a label, so the
  help, the hint line and the palette read one list.
- **Commands (R2.2, R2.3).** A command has a name, a title, an argument hint, where it applies and
  a run. Typing `/` in the prompt lists those that apply on the screen, filtered by prefix, Tab
  completing; Ctrl+P opens the palette over the same list with a fuzzy filter.
- **Esc and Ctrl+C (R2.4, R2.5).** Esc closes the topmost overlay, else stops a running turn, else
  goes back. Ctrl+C clears a non-empty prompt, else arms a two-second window in which a second
  Ctrl+C quits, said in a toast.
- **Lists keep their place (R1.5).** Screens hold the selected item's id, not its index, and
  re-derive the index from the id after a push.
- **Safe text (R3.3).** Everything drawn from the API goes through `terminalSafe`, kept from 0.1.
- **Screen tests (R4.1).** `App` takes the API and the push bus as props; `tui/test/` drives it with
  `testRender`, simulated keys and a scripted API that records the methods called.

## Theme

Tokens are named as the desktop app's CSS variables — `background`, `foreground`, `card`,
`muted`, `mutedForeground`, `primary`, `border`, `success`, `warning`, `destructive` — with the same
dark values; the light variant inverts the neutrals and keeps the accents. Code colors come from
`SYNTAX` in `src/renderer/src/lib/highlight.ts`.
