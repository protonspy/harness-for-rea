import { TextAttributes } from "@opentui/core"
import { useEffect, useState } from "react"
import {
  GOALS,
  ORCHESTRATOR_EFFORTS,
  SPECIALIST_EFFORTS,
  type Goal,
  type OrchestratorEffort,
  type SpecialistEffort,
  type TargetInfo,
} from "../../../src/shared/types"
import { goalCard, nameFrom } from "../../../src/renderer/src/lib/projects"
import { useApp, useKeys, useScreen } from "../app/context"
import { InputDialog, SelectDialog } from "../components/dialogs"
import { Choice, Field, safe } from "../components/ui"
import { riskOf } from "../lib/launch"

/*
  The new-project screen (specs/tui-panels R2.3, specs/tui-launch R1.4–R1.6): a typed target path with its detected
  kind, the goal, the name prefilled from the path, the model and the efforts from Settings. A folder too broad to
  mount asks for its path typed before the project is created; the data folder is refused.
*/

const FIELDS = ["target", "goal", "name", "model", "orchestrator", "specialist"] as const
type FieldName = (typeof FIELDS)[number]

export function NewProjectScreen({ target: initial, confirm }: { target?: string; confirm: string | null }) {
  const app = useApp()
  const { api, theme, where } = app
  const [target, setTarget] = useState(initial ?? "")
  const [info, setInfo] = useState<TargetInfo | null>(null)
  const [detectError, setDetectError] = useState("")
  const [goal, setGoal] = useState<Goal>("understand")
  const [name, setName] = useState(initial ? nameFrom(initial) : "")
  const [named, setNamed] = useState(false)
  const [model, setModel] = useState("")
  const [provider, setProvider] = useState("")
  const [orch, setOrch] = useState<OrchestratorEffort>("default")
  const [spec, setSpec] = useState<SpecialistEffort>("medium")
  const [focus, setFocus] = useState<FieldName>(initial ? "goal" : "target")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.getSettings().then((s) => {
      setModel(s.model)
      setProvider(s.provider)
      setOrch(s.orchestratorEffort)
      setSpec(s.specialistEffort)
    })
  }, [api])
  // The target's kind, read again as the path is typed (R2.3).
  const trimmed = target.trim()
  useEffect(() => {
    if (!trimmed) return
    let alive = true
    const timer = setTimeout(
      () =>
        void api.detectTarget(trimmed).then(
          (t) => alive && (setInfo(t), setDetectError("")),
          (e: unknown) => alive && (setInfo(null), setDetectError((e as Error).message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, ""))),
        ),
      200,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, trimmed])
  // The name follows the target until the user types one.
  const shownName = named ? name : trimmed ? nameFrom(trimmed) : name
  const shownInfo = trimmed ? info : null

  const browse = async (kind: "file" | "folder") => {
    const p = await app.attempt(() => api.pickTarget(kind))
    if (p) setTarget(p)
  }
  const pickModel = async () => {
    const models = await app.attempt(() => api.listModels())
    if (!models?.length) return
    const id = await app.dialog<string>((done) => <SelectDialog title="Model" items={models.map((m) => ({ id: m, label: m }))} initial={model} done={done} />)
    if (id) setModel(id)
  }

  const create = async () => {
    const path = target.trim()
    if (!path || !shownInfo) return app.toast("Give a target the app can read.", "error")
    if (!shownName.trim()) return app.toast("Give the project a name.", "error")
    const risk = riskOf(path, where)
    if (risk.kind === "refuse") return app.toast(risk.why, "error")
    const why = risk.kind === "confirm" ? risk.why : confirm
    if (why) {
      // Typing the path, not pressing Enter on "yes", is what makes mounting a broad folder deliberate (R1.5).
      const typed = await app.dialog<string>((done) => (
        <InputDialog
          title="Mount a broad folder?"
          body={`${path} is ${why}. Everything under it is mounted into the analysis sandboxes, which reach the internet. Type the path to confirm.`}
          check={(v) =>
            v
              .trim()
              .replace(/[\\/]+$/, "")
              .toLowerCase() === path.replace(/[\\/]+$/, "").toLowerCase()
              ? null
              : "That is not the same path."
          }
          done={done}
        />
      ))
      if (typed === null) return
    }
    setBusy(true)
    const p = await app.attempt(
      () =>
        api.createProject({
          name: shownName.trim(),
          goal,
          target: path,
          provider: provider as never,
          model,
          orchestratorEffort: orch,
          specialistEffort: spec,
        }),
      `Created "${shownName.trim()}".`,
    )
    setBusy(false)
    if (p) app.go({ kind: "project", id: p.id })
  }

  useScreen({
    title: "New project",
    typing: true,
    commands: [
      { name: "create", title: "Create the project", run: create },
      { name: "browse-folder", title: "Pick the target folder from a browser", run: () => browse("folder") },
      { name: "browse-file", title: "Pick a target file from a browser", run: () => browse("file") },
      { name: "models", title: "Pick the model from the provider's list", run: pickModel },
    ],
  })
  // The form takes the keys; the prompt stays for commands.
  const { setPromptFocused } = app
  useEffect(() => {
    setPromptFocused(false)
    return () => setPromptFocused(true)
  }, [setPromptFocused])
  const at = FIELDS.indexOf(focus)
  useKeys(
    "new-project",
    "New project",
    [
      { key: "tab", label: "Next field", hint: true, run: () => setFocus(FIELDS[(at + 1) % FIELDS.length]) },
      { key: "shift+tab", label: "Previous field", run: () => setFocus(FIELDS[(at - 1 + FIELDS.length) % FIELDS.length]) },
      { key: "ctrl+s", label: "Create", hint: true, run: () => void (busy || create()) },
      { key: "ctrl+l", label: "Pick the model", run: () => void pickModel() },
      { key: "ctrl+o", label: "Browse for the target", run: () => void browse("folder") },
      { key: "ctrl+t", label: "Commands in the prompt", run: () => app.setPromptFocused(!app.promptFocused) },
    ],
    { active: !app.promptFocused },
  )

  const field = (f: FieldName) => focus === f && !app.promptFocused
  const card = goalCard(goal)
  return (
    <box flexDirection="column" gap={1} width="100%" maxWidth={100}>
      <Field
        label="Target — a folder or a file to analyse"
        value={target}
        onInput={setTarget}
        onSubmit={() => setFocus("goal")}
        focused={field("target")}
        placeholder="C:\\samples\\app or /path/to/binary"
        note={
          shownInfo
            ? `${shownInfo.label}${shownInfo.isFile ? ", copied into the project" : ", read in place"} · ${shownInfo.engines.join(", ")}`
            : detectError || "Ctrl+O browses"
        }
        noteColor={shownInfo ? theme.success : detectError ? theme.destructive : undefined}
      />
      <box flexDirection="column">
        <Choice<Goal> label="Goal" value={goal} options={GOALS} onChange={setGoal} focused={field("goal")} />
        <text fg={theme.mutedForeground}>{safe(`${card.title}: ${card.description}`)}</text>
      </box>
      <Field
        label="Name"
        value={shownName}
        onInput={(v) => {
          setName(v)
          setNamed(true)
        }}
        onSubmit={() => setFocus("model")}
        focused={field("name")}
      />
      <Field
        label={`Model (${provider || "provider"})`}
        value={model}
        onInput={setModel}
        onSubmit={() => setFocus("orchestrator")}
        focused={field("model")}
        note="Ctrl+L picks from the provider's list"
      />
      <Choice<OrchestratorEffort>
        label="Orchestrator's effort"
        value={orch}
        options={ORCHESTRATOR_EFFORTS}
        onChange={setOrch}
        focused={field("orchestrator")}
      />
      <Choice<SpecialistEffort> label="Specialist's effort" value={spec} options={SPECIALIST_EFFORTS} onChange={setSpec} focused={field("specialist")} />
      {confirm ? <text fg={theme.warning}>{safe(`This folder is ${confirm}: creating asks for its path typed.`)}</text> : null}
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        {busy ? "Creating…" : "Ctrl+S creates the project · Tab moves between fields · Esc goes back"}
      </text>
    </box>
  )
}
