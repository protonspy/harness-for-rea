import { ExternalLink, Hammer, KeyRound, LogIn, LogOut, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { PROVIDER_IDS, PROVIDERS, resolveBaseUrl, type ProviderId } from "@shared/providers"
import { ORCHESTRATOR_EFFORTS, SPECIALIST_EFFORTS, type KeyStatus, type LoginStatus, type SandboxStatus, type Settings } from "@shared/types"
import { ErrorText, Field, Mono, PanelHeader } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/* Settings: the orchestrator's provider, key and endpoint, the model, the delegation timeout, Docker, images and the Claude sign-in (specs/desktop-ui R1). */

const message = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, "")

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState<KeyStatus | null>(null)
  const [keyInput, setKeyInput] = useState("")
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [login, setLogin] = useState<LoginStatus | null>(null)
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [modelsNote, setModelsNote] = useState("")
  const api = window.hfr.api

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.getSettings().then((st) => api.keyStatus(st.provider).then(setKey))
    void api.sandboxStatus().then(setSandbox)
    void api.loginStatus().then(setLogin)
    return window.hfr.onPush((p) => {
      if (p.type === "sandbox") setSandbox(p.status)
      if (p.type === "login") setLogin(p.status)
    })
  }, [api])

  // The provider's own model list, read again when the provider, its endpoint or whether a key is set changes.
  const activeProvider = settings?.provider
  const activeBaseUrl = settings?.baseUrl
  const keySet = key?.set
  const loadModels = useCallback(
    () =>
      api.listModels().then(
        (list) => {
          setModels(list)
          setModelsNote("")
        },
        (e: unknown) => {
          setModels([])
          setModelsNote(message(e))
        },
      ),
    [api],
  )
  useEffect(() => {
    if (!activeProvider || (PROVIDERS[activeProvider].keyRequired && !keySet) || (activeProvider === "custom" && !activeBaseUrl)) return
    void loadModels()
  }, [activeProvider, activeBaseUrl, keySet, loadModels])

  const run = async (fn: () => Promise<unknown>) => {
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(message(e))
    }
  }
  const save = (patch: Partial<Settings>) => run(async () => setSettings(await api.saveSettings(patch)))
  // Switching provider swaps in that provider's endpoint, model and key; the model name of one is meaningless to another.
  const switchProvider = (id: ProviderId) =>
    run(async () => {
      setModels([])
      setSettings(await api.saveSettings({ provider: id, baseUrl: PROVIDERS[id].baseUrl, model: PROVIDERS[id].defaultModel || settings?.model }))
      setKey(await api.keyStatus(id))
      setKeyInput("")
    })
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v))

  if (!settings) return null
  const provider = PROVIDERS[settings.provider]
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <ErrorText>{error}</ErrorText>

      <Card>
        <PanelHeader
          title={`Orchestrator (${provider.label})`}
          actions={key && <Badge variant={key.set ? "ok" : "warn"}>{key.set ? `key ${key.hint}` : "no key"}</Badge>}
        />
        <div className="flex flex-col gap-4 p-4">
          {key && !key.encryption && <ErrorText>The OS keychain is unavailable, so a key cannot be stored. It is never kept in plain text.</ErrorText>}
          <Field label="Provider" hint="OpenRouter, DeepSeek, or any service that speaks the OpenAI chat API (base URL and API key). Each keeps its own key.">
            <div className="flex gap-2">
              {PROVIDER_IDS.map((id) => (
                <Button key={id} variant={settings.provider === id ? "default" : "outline"} onClick={() => switchProvider(id)}>
                  {PROVIDERS[id].label}
                </Button>
              ))}
            </div>
          </Field>
          {provider.editableBaseUrl && (
            <Field label="Base URL" hint={`Where requests go, without /chat/completions. Empty uses ${provider.baseUrl || "nothing: set one"}.`}>
              <Input
                defaultValue={settings.baseUrl}
                key={`${settings.provider}:${settings.baseUrl}`}
                placeholder={provider.baseUrl || "https://host/v1"}
                onBlur={(e) => e.target.value.trim() !== settings.baseUrl && save({ baseUrl: e.target.value.trim() })}
              />
              {settings.provider === "custom" && !resolveBaseUrl("custom", settings.baseUrl) && <ErrorText>Set a base URL.</ErrorText>}
            </Field>
          )}
          <Field label="API key" hint="Encrypted with the Windows keychain. It is never shown again.">
            <div className="flex gap-2">
              <Input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={provider.keyPlaceholder} autoComplete="off" />
              <Button
                disabled={keyInput.trim().length < 8}
                onClick={() =>
                  run(async () => {
                    setKey(await api.saveKey(keyInput, settings.provider))
                    setKeyInput("")
                  })
                }
              >
                <KeyRound size={14} /> Save
              </Button>
              {key?.set && (
                <Button variant="destructive" onClick={() => run(async () => setKey(await api.clearKey(settings.provider)))}>
                  Clear
                </Button>
              )}
            </div>
          </Field>
          <Field
            label="Model"
            hint={
              settings.provider === "openrouter"
                ? "Any OpenRouter model with tool calling. The preset is also sent as the fallback; provider data collection is denied."
                : "Any model of this provider with tool calling. Reasoning-only models (such as deepseek-reasoner) are not supported."
            }
          >
            <div className="flex gap-2">
              <Input
                list="hfr-models"
                defaultValue={settings.model}
                key={settings.model}
                onBlur={(e) => e.target.value !== settings.model && save({ model: e.target.value.trim() })}
              />
              <datalist id="hfr-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Button variant="outline" size="default" onClick={loadModels} aria-label="Refresh the model list" title="Refresh the model list">
                <RefreshCw size={14} />
              </Button>
              {provider.models.map((m) => (
                <Button
                  key={m}
                  size="default"
                  variant={settings.model === m ? "default" : "outline"}
                  onClick={() => save({ model: m })}
                  className="shrink-0 font-mono text-xs"
                >
                  {m.split("/").pop()}
                </Button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {models.length > 0
                ? `${models.length} models from ${provider.label}: clear the field to see them all, or type to filter.`
                : modelsNote || "Save a key to list this provider's models; you can still type one."}
            </p>
          </Field>
          <Field
            label="Reasoning effort"
            hint={`Sent as ${settings.provider === "openrouter" ? "OpenRouter's reasoning.effort" : "reasoning_effort"}; models without reasoning ignore it. Default sends nothing.`}
          >
            <EffortSelect value={settings.orchestratorEffort} options={ORCHESTRATOR_EFFORTS} onChange={(v) => save({ orchestratorEffort: v })} />
          </Field>
        </div>
      </Card>

      <Card>
        <PanelHeader
          title="Sandbox (Docker)"
          actions={
            sandbox && (
              <div className="flex items-center gap-2">
                <Badge variant={sandbox.docker ? "ok" : "bad"}>{sandbox.docker ? "docker running" : "docker unavailable"}</Badge>
                <Badge variant={sandbox.images ? "ok" : "warn"}>
                  {sandbox.building ? "preparing" : sandbox.images ? `image ready · claude ${sandbox.claudeVersion}` : "image missing or out of date"}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => run(async () => setSandbox(await api.sandboxStatus()))} aria-label="Refresh">
                  <RefreshCw size={13} />
                </Button>
              </div>
            )
          }
        />
        <div className="flex flex-col gap-4 p-4">
          {sandbox && !sandbox.docker && (
            <p className="text-sm text-muted-foreground">Start Docker Desktop. The specialist never runs outside its container. ({sandbox.dockerError})</p>
          )}
          <div className="flex items-center gap-3">
            <Button className="shrink-0" disabled={!sandbox?.docker || sandbox.building} onClick={() => run(async () => setSandbox(await api.buildSandbox()))}>
              <Hammer size={14} /> {sandbox?.images ? "Prepare again" : "Prepare image"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Pulls the pinned base image, then downloads Claude Code {sandbox?.claudeVersion}, checks its signed manifest and SHA-256, and adds it. Runs on its
              own at start.
            </span>
          </div>
          {sandbox?.buildLog && (
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {sandbox.buildLog}
            </pre>
          )}
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
          <Label className="font-normal">
            <Checkbox checked={settings.discardOnCompletion} onCheckedChange={(v) => save({ discardOnCompletion: v === true })} />
            Discard each workspace, snapshot and decided patch when its delegation ends
          </Label>
        </div>
      </Card>

      <Card>
        <PanelHeader
          title="Specialist (Claude plan)"
          actions={
            login && (
              <Badge variant={login.loggedIn ? "ok" : "warn"}>{login.loggedIn ? `signed in${login.plan ? ` · ${login.plan}` : ""}` : "signed out"}</Badge>
            )
          }
        />
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            The specialist signs in with your own Claude plan, inside the sandbox image. The app never reads the stored credential.
          </p>
          <Field
            label="Effort"
            hint="Claude Code's --effort for every delegation. Higher effort thinks longer and uses more of your plan. Default passes nothing."
          >
            <EffortSelect value={settings.specialistEffort} options={SPECIALIST_EFFORTS} onChange={(v) => save({ specialistEffort: v })} />
          </Field>
          {login?.email && <Mono className="text-muted-foreground">{login.email}</Mono>}
          {login?.inProgress ? (
            <div className="flex flex-col gap-3">
              {login.url ? (
                <Button className="self-start" onClick={() => run(() => api.openLoginUrl())}>
                  <ExternalLink size={14} /> Open the Anthropic sign-in page
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">Starting the sign-in…</span>
              )}
              <Field label="Code from the Anthropic page">
                <div className="flex gap-2">
                  <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
                  <Button
                    variant="default"
                    disabled={code.trim().length < 8}
                    onClick={() =>
                      run(async () => {
                        setLogin(await api.sendLoginCode(code))
                        setCode("")
                      })
                    }
                  >
                    Submit
                  </Button>
                  <Button variant="ghost" onClick={() => run(async () => setLogin(await api.cancelLogin()))}>
                    Cancel
                  </Button>
                </div>
              </Field>
            </div>
          ) : (
            <div className="flex gap-2">
              {!login?.loggedIn && (
                <Button disabled={!sandbox?.images} onClick={() => run(async () => setLogin(await api.startLogin()))}>
                  <LogIn size={14} /> Sign in to Claude
                </Button>
              )}
              {login?.loggedIn && (
                <Button variant="destructive" onClick={() => run(async () => setLogin(await api.logout()))}>
                  <LogOut size={14} /> Sign out
                </Button>
              )}
            </div>
          )}
          {login?.error && <ErrorText>{login.error}</ErrorText>}
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

function EffortSelect<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange(v: T): void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 w-48 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}
