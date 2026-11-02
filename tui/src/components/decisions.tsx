import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { checkAnswer, type Answer, type Question, type ToolDecision } from "../../../src/shared/chat"
import type { PatchView } from "../../../src/shared/types"
import { parseArgs, type GatedCall } from "../../../src/renderer/src/lib/chat"
import { diffLines } from "../../../src/renderer/src/lib/format"
import { useApp, useKeys, type AppState } from "../app/context"
import { InputDialog } from "./dialogs"
import { Frame, List, safe } from "./ui"

/*
  The decisions a task waits on, in dialogs (specs/tui-conversation R3): a question by its kind, the choice after a
  safeguard refusal among them, a gated call to approve, edit or reject, and a patch's diff to approve or reject.
*/

/** A patch's files and diff, lines colored by kind (R3.1). */
export function Diff({ patch, max = 400 }: { patch: PatchView; max?: number }) {
  const { theme } = useApp()
  const lines = diffLines(patch.diff)
  const color = { add: theme.success, del: theme.destructive, hunk: theme.primary, file: theme.warning, ctx: theme.mutedForeground }
  return (
    <box flexDirection="column">
      <text fg={theme.foreground} attributes={TextAttributes.BOLD}>
        {`Patch ${patch.state} · ${patch.files.length} file(s)`}
        {patch.conflicts.length ? <span fg={theme.destructive}>{` · conflicts: ${safe(patch.conflicts.join(", "))}`}</span> : null}
      </text>
      {lines.slice(0, max).map((l, i) => (
        <text key={i} fg={color[l.kind]} wrapMode="char">
          {safe(l.text) || " "}
        </text>
      ))}
      {lines.length > max ? <text fg={theme.mutedForeground}>{`… ${lines.length - max} more lines`}</text> : null}
    </box>
  )
}

/** Answer a question with the input its kind calls for; null when the dialog is closed unanswered (R3.3). */
export async function askQuestion(app: AppState, agent: string, q: Question): Promise<Answer | null> {
  if (q.kind === "choice" || q.kind === "yesno") {
    const options: { id: string; value: Answer }[] =
      q.kind === "yesno"
        ? [
            { id: "yes", value: true },
            { id: "no", value: false },
          ]
        : (q.choices ?? []).map((c) => ({ id: c, value: c }))
    const id = await app.dialog<string>((done) => <ChoiceQuestion agent={agent} q={q} options={options.map((o) => o.id)} done={done} />)
    return id === null ? null : (options.find((o) => o.id === id)?.value ?? null)
  }
  const typed = await app.dialog<string>((done) => (
    <InputDialog
      title={`${agent} asks`}
      body={`${q.prompt}\n\nWhy: ${q.reason}\nDefault: ${String(q.default)}`}
      initial={String(q.default)}
      check={(v) => {
        try {
          checkAnswer(q, q.kind === "number" ? Number(v.trim()) : v)
          return q.kind === "number" && !v.trim() ? "Answer with a number." : null
        } catch (e) {
          return (e as Error).message
        }
      }}
      done={done}
    />
  ))
  if (typed === null) return null
  return q.kind === "number" ? Number(typed.trim()) : typed
}

function ChoiceQuestion({ agent, q, options, done }: { agent: string; q: Question; options: string[]; done(id: string | null): void }) {
  const { theme } = useApp()
  const def = q.kind === "yesno" ? (q.default === true ? "yes" : "no") : String(q.default)
  const [selected, setSelected] = useState<string | null>(options.includes(def) ? def : (options[0] ?? null))
  useKeys("dialog:question", "Question", [{ key: "escape", label: "Later", run: () => done(null) }], { modal: true })
  return (
    <Frame title={`${agent} asks`} footer="↑ ↓ choose · Enter answers · Esc answers later with /answer">
      <text fg={theme.foreground} attributes={TextAttributes.BOLD}>
        {safe(q.prompt)}
      </text>
      <text fg={theme.mutedForeground}>{`Why: ${safe(q.reason)}`}</text>
      <box marginTop={1}>
        <List
          id="question"
          items={options.map((o) => ({ id: o, label: o, detail: o === def ? "default" : undefined }))}
          selected={selected}
          onMove={setSelected}
          onPick={(id) => done(id)}
        />
      </box>
    </Frame>
  )
}

/** Decide a gated call: approve it, run it with edited arguments, or reject it with a reason (R3.2). */
export async function decideCall(app: AppState, call: GatedCall, patch?: PatchView): Promise<ToolDecision | null> {
  const choice = await app.dialog<string>((done) => <CallDialog call={call} patch={patch} done={done} />)
  if (choice === "approve") return { type: "approve" }
  if (choice === "reject") {
    const why = await app.dialog<string>((done) => <InputDialog title="Reject the call" body="Why, for the agent to read (optional)" done={done} />)
    if (why === null) return null
    return why.trim() ? { type: "reject", message: why.trim() } : { type: "reject" }
  }
  if (choice === "edit") {
    const text = await app.dialog<string>((done) => (
      <InputDialog
        title={`Edit ${call.name}'s arguments`}
        body="The arguments as JSON, on one line."
        initial={JSON.stringify(call.args)}
        check={(v) => {
          const r = parseArgs(v)
          return "error" in r ? r.error : null
        }}
        done={done}
      />
    ))
    if (text === null) return null
    const r = parseArgs(text)
    return "args" in r ? { type: "edit", args: r.args } : null
  }
  return null
}

function CallDialog({ call, patch, done }: { call: GatedCall; patch?: PatchView; done(v: string | null): void }) {
  const { theme } = useApp()
  const [selected, setSelected] = useState<string | null>("approve")
  useKeys("dialog:call", "Gated call", [{ key: "escape", label: "Later", run: () => done(null) }], { modal: true })
  return (
    <Frame title={`The agent wants to run ${call.name}`} width={100} footer="↑ ↓ choose · Enter decides · Esc decides later with /decide">
      {patch ? (
        <scrollbox height={16}>
          <Diff patch={patch} />
        </scrollbox>
      ) : (
        <text fg={theme.foreground}>{safe(JSON.stringify(call.args, null, 2).slice(0, 2000))}</text>
      )}
      <box marginTop={1}>
        <List
          id="call"
          items={[
            { id: "approve", label: "Approve", detail: "run it as it is" },
            { id: "edit", label: "Edit", detail: "run it with other arguments" },
            { id: "reject", label: "Reject", detail: "the agent reads why" },
          ]}
          selected={selected}
          onMove={setSelected}
          onPick={(id) => done(id)}
        />
      </box>
    </Frame>
  )
}
