import { ExternalLink, Hammer, KeyRound, LogIn, LogOut, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { PROVIDER_IDS, PROVIDERS, resolveBaseUrl, type ProviderId } from "@shared/providers"
import type { KeyStatus, LoginStatus, SandboxStatus, Settings } from "@shared/types"
import { ErrorText, Field, Mono } from "@/components/common"
import { ModelPicker } from "@/components/setup/ModelPicker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/*
  The three things every run needs, as panels both the first-run setup and Settings show
  (specs/onboarding R1.3–R1.5): the sandbox images, the Claude Code sign-in, and the orchestrator's provider,
  key and model. Each loads its own state and calls `onChange` after anything that may change readiness.
*/

export const message = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, "")

function useRun(onChange?: () => void) {
  const [error, setError] = useState("")
  const run = async (fn: () => Promise<unknown>) => {
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(message(e))
    } finally {
      onChange?.()
    }
  }
  return { error, run }
}

/** Docker and the sandbox images, with the action that prepares them and its log. */
export function SandboxPanel({ onChange, children }: { onChange?(): void; children?: ReactNode }) {
  const api = window.hfr.api
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const { error, run } = useRun(onChange)
  useEffect(() => {
    void api.sandboxStatus().then(setSandbox)
    return window.hfr.onPush((p) => p.type === "sandbox" && setSandbox(p.status))
  }, [api])
  if (!sandbox) return null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={sandbox.docker ? "ok" : "bad"}>{sandbox.docker ? "Docker running" : "Docker unavailable"}</Badge>
        <Badge variant={sandbox.images ? "ok" : "warn"}>
          {sandbox.building ? "preparing…" : sandbox.images ? `images ready · Claude Code ${sandbox.claudeVersion}` : "images not prepared"}
        </Badge>
        <Button size="sm" variant="ghost" onClick={() => run(async () => setSandbox(await api.sandboxStatus()))} aria-label="Check again">
          <RefreshCw size={13} />
        </Button>
      </div>
      {!sandbox.docker && (
        <p className="text-sm text-muted-foreground">
          Start Docker Desktop, then check again. The specialist never runs outside its container. ({sandbox.dockerError})
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button className="shrink-0" disabled={!sandbox.docker || sandbox.building} onClick={() => run(async () => setSandbox(await api.buildSandbox()))}>
          <Hammer size={14} /> {sandbox.images ? "Prepare again" : "Prepare the images"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Pulls the pinned base image with REA, Ghidra and the Android tools, then downloads Claude Code {sandbox.claudeVersion}, checks its signed manifest and
          SHA-256, and adds it.
        </span>
      </div>
      {sandbox.buildLog && (
        <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {sandbox.buildLog}
        </pre>
      )}
      {children}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

/** The specialist's sign-in on the user's own Claude plan, run inside the sandbox image. */
export function ClaudePanel({ onChange, children }: { onChange?(): void; children?: ReactNode }) {
  const api = window.hfr.api
  const [login, setLogin] = useState<LoginStatus | null>(null)
  const [images, setImages] = useState(false)
  const [code, setCode] = useState("")
  const { error, run } = useRun(onChange)
  useEffect(() => {
    void api.loginStatus().then(setLogin)
    void api.sandboxStatus().then((s) => setImages(s.images))
    return window.hfr.onPush((p) => {
      if (p.type === "login") setLogin(p.status)
      if (p.type === "sandbox") setImages(p.status.images)
    })
  }, [api])
  if (!login) return null
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={login.loggedIn ? "ok" : "warn"}>{login.loggedIn ? `signed in${login.plan ? ` · ${login.plan}` : ""}` : "signed out"}</Badge>
        {login.email && <Mono className="text-muted-foreground">{login.email}</Mono>}
      </div>
      <p className="text-sm text-muted-foreground">
        The specialist uses your own Claude plan and its limits, signed in inside the sandbox. The app never reads the stored credential.
      </p>
      {login.inProgress ? (
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
          {!login.loggedIn && (
            <Button disabled={!images} onClick={() => run(async () => setLogin(await api.startLogin()))}>
              <LogIn size={14} /> Sign in to Claude
            </Button>
          )}
          {login.loggedIn && (
            <Button variant="destructive" onClick={() => run(async () => setLogin(await api.logout()))}>
              <LogOut size={14} /> Sign out
            </Button>
          )}
          {!images && !login.loggedIn && <span className="self-center text-xs text-muted-foreground">Prepare the sandbox images first.</span>}
        </div>
      )}
      {children}
      <ErrorText>{login.error || error}</ErrorText>
    </div>
  )
}

/** The orchestrator's OpenAI-compatible provider — OpenRouter first — its endpoint, its key and its model. */
export function ModelPanel({
  onChange,
  children,
}: {
  onChange?(): void
  children?: (settings: Settings, save: (p: Partial<Settings>) => Promise<void>) => ReactNode
}) {
  const api = window.hfr.api
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState<KeyStatus | null>(null)
  const [keyInput, setKeyInput] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [modelsNote, setModelsNote] = useState("")
  const { error, run } = useRun(onChange)

  useEffect(() => {
    void api.getSettings().then((st) => {
      setSettings(st)
      return api.keyStatus(st.provider).then(setKey)
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
          // A server with no model list still works: the model named here is checked with a test request (specs/onboarding R1.6).
          setModelsNote(`${message(e)} Name the model below; the setup checks it with a one-token test request.`)
        },
      ),
    [api],
  )
  useEffect(() => {
    if (!activeProvider || (PROVIDERS[activeProvider].keyRequired && !keySet) || (activeProvider === "custom" && !activeBaseUrl)) return
    void loadModels()
  }, [activeProvider, activeBaseUrl, keySet, loadModels])

  const save = (patch: Partial<Settings>) => run(async () => setSettings(await api.saveSettings(patch)))
  // Switching provider swaps in that provider's own endpoint (main keeps one per provider), model and key; the model
  // name of one is meaningless to another.
  const switchProvider = (id: ProviderId) =>
    // Picking the provider already chosen changes nothing: its endpoint and model stay as they were saved.
    id !== settings?.provider &&
    run(async () => {
      setModels([])
      setSettings(await api.saveSettings({ provider: id, model: PROVIDERS[id].defaultModel || settings?.model }))
      setKey(await api.keyStatus(id))
      setKeyInput("")
    })

  if (!settings) return null
  const provider = PROVIDERS[settings.provider]
  return (
    <div className="flex flex-col gap-4">
      {key && !key.encryption && <ErrorText>The OS keychain is unavailable, so a key cannot be stored. It is never kept in plain text.</ErrorText>}
      <Field label="Provider" hint="Hopper, the default, OpenRouter, DeepSeek, or any service that speaks the OpenAI chat API. Each keeps its own key.">
        <div className="flex flex-wrap gap-2">
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
            onBlur={(e) => e.target.value.trim() !== settings.baseUrl && save({ provider: settings.provider, baseUrl: e.target.value.trim() })}
          />
          {settings.provider === "custom" && !resolveBaseUrl("custom", settings.baseUrl) && <ErrorText>Set a base URL.</ErrorText>}
        </Field>
      )}
      <Field
        label="API key"
        hint={
          key?.set
            ? `Saved (${key.hint}), encrypted with the OS keychain. It is never shown again.`
            : "Encrypted with the OS keychain. It is never shown again."
        }
      >
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
        {provider.signupUrl && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            No account yet?{" "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => run(() => api.openProviderSignup(settings.provider))}>
              Create one at {provider.signupUrl.replace(/^https:\/\//, "")}
            </button>
            {provider.offer ? ` ${provider.offer}` : ""}
          </p>
        )}
      </Field>
      <Field
        label="Model"
        hint={
          settings.provider === "openrouter"
            ? "Any OpenRouter model with tool calling. The preset is also sent as the fallback; provider data collection is denied."
            : "Any model of this provider with tool calling. Reasoning-only models (such as deepseek-reasoner) are not supported."
        }
      >
        <div className="flex items-start gap-2">
          <ModelPicker
            key={`${settings.provider}:${settings.model}`}
            provider={settings.provider}
            value={settings.model}
            listed={models}
            onChange={(m) => save({ model: m })}
          />
          <Button variant="outline" onClick={() => run(loadModels)} aria-label="Refresh the model list" title="Refresh the model list">
            <RefreshCw size={14} />
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {models.length > 0
            ? `${models.length} models with tool calling from ${provider.label}, recommended first.`
            : modelsNote ||
              (keySet || !provider.keyRequired ? `Reading ${provider.label}'s models…` : "Save a key to list this provider's models; you can still name one.")}
        </p>
      </Field>
      {children?.(settings, save)}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

export function EffortSelect<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange(v: T): void }) {
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
