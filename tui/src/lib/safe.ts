/*
  Text from the target, the agents or a tool, made safe to draw (specs/tui-shell R3.3): every control character but
  the newline and the tab removed, so nothing in it reaches the terminal as an escape sequence — a title, the
  clipboard, a cursor move — and the bidirectional overrides and isolates, so nothing reorders the text around it.
*/

// C0 and C1 controls but the tab and the newline, DEL, and the bidi overrides and isolates.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

export function terminalSafe(text: string): string {
  return text.replace(CONTROL, "")
}
