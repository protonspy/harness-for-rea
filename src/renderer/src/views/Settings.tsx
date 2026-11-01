import { Wand2 } from "lucide-react"
import { useEffect, useState } from "react"
import { ORCHESTRATOR_EFFORTS, SPECIALIST_EFFORTS, type Settings } from "@shared/types"
import { ErrorText, Field, PanelHeader } from "@/components/common"
import { ClaudePanel, EffortSelect, message, ModelPanel, SandboxPanel } from "@/components/setup/panels"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

/*
  Settings: the orchestrator's provider, key, endpoint, model and effort, the sandbox images and the delegation
  timeout, the Claude sign-in and the specialist's effort, and the waits on the user (specs/desktop-ui R1); the
  first-run setup is reachable again from here (specs/onboarding R2.2).
*/

export function SettingsView({ onSetup }: { onSetup(): void }) {
  const api = window.hfr.api
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    void api.getSettings().then(setSettings)
  }, [api])

  const save = async (patch: Partial<Settings>) => {
    setError("")
    try {
      setSettings(await api.saveSettings(patch))
    } catch (e) {
      setError(message(e))
    }
  }
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v))

  if (!settings) return null
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <Button variant="outline" onClick={onSetup}>
          <Wand2 size={14} /> Run the setup again
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>

      <Card>
        <PanelHeader title="Orchestrator model" />
        <div className="p-4">
          <ModelPanel>
            {(s, saveModel) => (
              <Field
                label="Reasoning effort"
                hint={`Sent as ${s.provider === "openrouter" ? "OpenRouter's reasoning.effort" : "reasoning_effort"}; models without reasoning ignore it. Default sends nothing.`}
              >
                <EffortSelect value={s.orchestratorEffort} options={ORCHESTRATOR_EFFORTS} onChange={(v) => void saveModel({ orchestratorEffort: v })} />
              </Field>
            )}
          </ModelPanel>
        </div>
      </Card>

      <Card>
        <PanelHeader title="Sandbox (Docker)" />
        <div className="p-4">
          <SandboxPanel>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Timeout per delegation (minutes)">
                <Input
                  type="number"
                  min={1}
                  max={240}
                  defaultValue={settings.timeoutMinutes}
                  onBlur={(e) => Number.isInteger(num(e.target.value)) && save({ timeoutMinutes: num(e.target.value) })}
                />
              </Field>
            </div>
          </SandboxPanel>
        </div>
      </Card>

      <Card>
        <PanelHeader title="Specialist (Claude Code)" />
        <div className="p-4">
          <ClaudePanel>
            <Field
              label="Effort"
              hint="Claude Code's --effort for every delegation. Higher effort thinks longer and uses more of your plan. Default passes nothing."
            >
              <EffortSelect value={settings.specialistEffort} options={SPECIALIST_EFFORTS} onChange={(v) => save({ specialistEffort: v })} />
            </Field>
          </ClaudePanel>
        </div>
      </Card>

      <Card>
        <PanelHeader title="You in the loop" />
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-muted-foreground">
            How long the agents wait on you. A tool call you chose to approve is rejected when its wait runs out; a question gets the default the agent gave.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Approval timeout (minutes)">
              <Input
                type="number"
                min={1}
                max={1440}
                defaultValue={settings.approvalTimeoutMinutes}
                onBlur={(e) => Number.isInteger(num(e.target.value)) && save({ approvalTimeoutMinutes: num(e.target.value) })}
              />
            </Field>
            <Field label="Question timeout (minutes)">
              <Input
                type="number"
                min={1}
                max={1440}
                defaultValue={settings.questionTimeoutMinutes}
                onBlur={(e) => Number.isInteger(num(e.target.value)) && save({ questionTimeoutMinutes: num(e.target.value) })}
              />
            </Field>
          </div>
        </div>
      </Card>
    </div>
  )
}
