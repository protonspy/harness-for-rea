import { TextAttributes } from "@opentui/core"
import { useCallback, useEffect, useState } from "react"
import { PROVIDERS, getAvailableEffortsForModel } from "../../../src/shared/providers"
import { ORCHESTRATOR_EFFORTS, SPECIALIST_EFFORTS, type Settings } from "../../../src/shared/types"
import { useApp, useKeys, useScreen } from "../app/context"
import { Choice, Field } from "../components/ui"
import { providerCommands, specialistCommands, specialistLabel } from "./Setup"

/*
  The settings editor (specs/tui-panels R4): the provider, model and key through the setup's commands, the
  orchestrator's and the specialist's effort, and the delegation's inactivity, approval and question timeouts, each saved as it is
  changed; /setup opens the setup again.
*/

const FIELDS = ["orchestrator", "specialist", "timeout", "approval", "question"] as const
type FieldName = (typeof FIELDS)[number]
const MINUTES = { timeout: "timeoutMinutes", approval: "approvalTimeoutMinutes", question: "questionTimeoutMinutes" } as const

export function SettingsScreen() {
  const app = useApp()
  const { api, theme } = app
  const [s, setS] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [focus, setFocus] = useState<FieldName>("orchestrator")
  const refresh = useCallback(() => void api.getSettings().then(setS), [api])
  useEffect(refresh, [refresh])

  const save = async (patch: Partial<Settings>, said: string) => {
    const next = await app.attempt(() => api.saveSettings(patch), said)
    if (next) setS(next)
  }
  const saveMinutes = (f: keyof typeof MINUTES) => {
    const n = Number(draft[f])
    if (!Number.isInteger(n) || n < 1) return app.toast("Give a whole number of minutes.", "error")
    void save({ [MINUTES[f]]: n }, "Saved.")
  }

  useScreen({
    title: "Settings",
    typing: true,
    commands: [
      ...providerCommands(app, s, refresh),
      ...specialistCommands(app, s, refresh),
      { name: "setup", title: "Open the first-run setup again", run: () => app.go({ kind: "setup", then: { kind: "settings" } }) },
    ],
  })
  const { setPromptFocused } = app
  useEffect(() => {
    setPromptFocused(false)
    return () => setPromptFocused(true)
  }, [setPromptFocused])
  const at = FIELDS.indexOf(focus)
  useKeys(
    "settings",
    "Settings",
    [
      { key: "tab", label: "Next field", hint: true, run: () => setFocus(FIELDS[(at + 1) % FIELDS.length]) },
      { key: "shift+tab", label: "Previous field", run: () => setFocus(FIELDS[(at - 1 + FIELDS.length) % FIELDS.length]) },
      { key: "ctrl+t", label: "Commands in the prompt", hint: true, run: () => app.setPromptFocused(!app.promptFocused) },
    ],
    { active: !app.promptFocused },
  )

  if (!s) return <text fg={theme.mutedForeground}>Loading…</text>
  const on = (f: FieldName) => focus === f && !app.promptFocused
  const minutes = (f: keyof typeof MINUTES, label: string) => (
    <Field
      label={label}
      value={draft[f] ?? String(s[MINUTES[f]])}
      onInput={(v) => setDraft((d) => ({ ...d, [f]: v }))}
      onSubmit={() => saveMinutes(f)}
      focused={on(f)}
      note="Enter saves"
    />
  )
  return (
    <box flexDirection="column" gap={1} maxWidth={90}>
      <text fg={theme.foreground}>
        <span attributes={TextAttributes.BOLD}>{`${PROVIDERS[s.provider].label} · ${s.model}`}</span>
        <span fg={theme.mutedForeground}>{"   /provider · /model · /key · /base-url in the prompt (Ctrl+T)"}</span>
      </text>
      <text fg={theme.foreground}>
        <span
          attributes={TextAttributes.BOLD}
        >{`Specialist: ${specialistLabel(s.specialistProvider)}${s.specialistProvider === "claude" ? "" : ` · ${s.specialistModel || "no model"}`}`}</span>
        <span fg={theme.mutedForeground}>{"   /specialist · /specialist-model · /specialist-key"}</span>
      </text>
      <Choice<(typeof ORCHESTRATOR_EFFORTS)[number]>
        label="Orchestrator's effort"
        value={s.orchestratorEffort}
        options={getAvailableEffortsForModel(s.provider, s.model)}
        onChange={(v) => void save({ orchestratorEffort: v }, `Orchestrator's effort: ${v}.`)}
        focused={on("orchestrator")}
      />
      <Choice<(typeof SPECIALIST_EFFORTS)[number]>
        label="Specialist's effort"
        value={s.specialistEffort}
        options={s.specialistProvider === "claude" ? SPECIALIST_EFFORTS : (getAvailableEffortsForModel(s.specialistProvider, s.specialistModel) as any)}
        onChange={(v) => void save({ specialistEffort: v }, `Specialist's effort: ${v}.`)}
        focused={on("specialist")}
      />
      {minutes("timeout", "Delegation inactivity timeout (minutes)")}
      {minutes("approval", "Approval timeout (minutes)")}
      {minutes("question", "Question timeout (minutes)")}
    </box>
  )
}
