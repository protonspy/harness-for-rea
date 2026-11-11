import { ExternalLink, Hammer, KeyRound, LogIn, LogOut, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { PROVIDER_IDS, PROVIDERS, resolveBaseUrl, SPECIALIST_PROVIDERS, type ProviderId, type SpecialistProvider } from "@shared/providers"
import type { ChatGPTAuthStatus, ChatGPTModelOption, HopperSignIn, KeyStatus, LoginStatus, SandboxStatus, Settings } from "@shared/types"
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
          Start Docker Desktop or a compatible Docker Engine (including WSL), then check again. The specialist never runs outside its container. (
          {sandbox.dockerError})
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
      if (p.type === "login") {
        setLogin(p.status)
        onChange?.()
      }
      if (p.type === "sandbox") {
        setImages(p.status.images)
        onChange?.()
      }
    })
  }, [api, onChange])
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
  settings: propSettings,
  onSettingsChange,
  keyRev,
  onChange,
  children,
}: {
  settings?: Settings | null
  onSettingsChange?(s: Settings): void
  keyRev?: number
  onChange?(): void
  children?: (settings: Settings, save: (p: Partial<Settings>) => Promise<void>) => ReactNode
}) {
  const api = window.hfr.api
  const [localSettings, setLocalSettings] = useState<Settings | null>(null)
  const settings = propSettings !== undefined ? propSettings : localSettings
  const [key, setKey] = useState<KeyStatus | null>(null)
  const [models, setModels] = useState<Array<string | ChatGPTModelOption>>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsNote, setModelsNote] = useState("")
  const [modelNotice, setModelNotice] = useState("")
  const { error, run } = useRun(onChange)

  useEffect(() => {
    if (propSettings === undefined) {
      void api.getSettings().then((st) => {
        setLocalSettings(st)
        return api.keyStatus(st.provider).then(setKey)
      })
    }
  }, [api, propSettings])

  // The provider's own model list, read again when the provider, its endpoint or whether a key is set changes.
  const activeProvider = settings?.provider
  const activeBaseUrl = settings?.baseUrl
  const keySet = key?.set
  const modelGenRef = useRef(0)
  const currentProviderRef = useRef(activeProvider)
  useEffect(() => {
    currentProviderRef.current = activeProvider
  }, [activeProvider])

  useEffect(() => {
    if (activeProvider && keyRev !== -1) {
      void api.keyStatus(activeProvider).then(setKey)
    }
  }, [api, activeProvider, keyRev])

  const loadModels = useCallback(() => {
    const gen = ++modelGenRef.current
    setModelsLoading(true)
    setModelsNote("")
    setModelNotice("")
    if (activeProvider === "chatgpt") {
      return api.listChatGPTModels().then(
        async (chatgptModels) => {
          if (gen !== modelGenRef.current || currentProviderRef.current !== "chatgpt") return
          setModelsLoading(false)
          setModels(chatgptModels)
          if (chatgptModels.length > 0) {
            const currentModel = settings?.model ?? ""
            const hasValid = chatgptModels.some((m) => m.slug === currentModel)
            if (!hasValid) {
              const first = chatgptModels[0]
              const updated = await api.saveSettings({ model: first.slug, expectedProvider: "chatgpt" })
              if (gen !== modelGenRef.current || currentProviderRef.current !== "chatgpt") return
              if (onSettingsChange) onSettingsChange(updated)
              else setLocalSettings(updated)
              onChange?.()
              if (currentModel) {
                setModelNotice(`Previous model unavailable on your plan. Selected ${first.displayName} (${first.slug}).`)
              }
            }
          } else {
            setModelsNote("ChatGPT (Codex) listed no models for this account.")
          }
        },
        (e: unknown) => {
          if (gen !== modelGenRef.current || currentProviderRef.current !== "chatgpt") return
          setModelsLoading(false)
          setModels([])
          setModelsNote(message(e))
        },
      )
    }
    return api.listModels(activeProvider).then(
      async (list) => {
        if (gen !== modelGenRef.current || currentProviderRef.current !== activeProvider) return
        setModelsLoading(false)
        setModels(list)
        setModelsNote("")
        if (activeProvider === "river" && list.length > 0) {
          const currentModel = settings?.model ?? ""
          if (currentModel === "deepseek-chat" || !list.includes(currentModel)) {
            const fallback = list.includes(PROVIDERS.river.defaultModel) ? PROVIDERS.river.defaultModel : (list[0] ?? "")
            const updated = await api.saveSettings({ model: fallback, expectedProvider: "river" })
            if (gen !== modelGenRef.current || currentProviderRef.current !== "river") return
            if (onSettingsChange) onSettingsChange(updated)
            else setLocalSettings(updated)
            onChange?.()
            if (currentModel) {
              setModelNotice(`Model "${currentModel}" is not in River catalog. Selected "${fallback}".`)
            }
          }
        }
      },
      (e: unknown) => {
        if (gen !== modelGenRef.current || currentProviderRef.current !== activeProvider) return
        setModelsLoading(false)
        setModels([])
        // A server with no model list still works: the model named here is checked with a test request (specs/onboarding R1.6).
        setModelsNote(`${message(e)} Name the model below; the setup checks it with a one-token test request.`)
      },
    )
  }, [activeProvider, api, settings?.model, onChange, onSettingsChange])
  useEffect(() => {
    if (!activeProvider || (PROVIDERS[activeProvider].keyRequired && !keySet) || (activeProvider === "custom" && !activeBaseUrl)) return
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      void loadModels()
    })()
    return () => {
      active = false
    }
  }, [activeProvider, activeBaseUrl, keySet, loadModels])

  const save = (patch: Partial<Settings>) =>
    run(async () => {
      const updated = await api.saveSettings(patch)
      if (onSettingsChange) onSettingsChange(updated)
      else setLocalSettings(updated)
      return updated
    })
  // Switching provider swaps in that provider's own endpoint (main keeps one per provider), model and key; the model
  // name of one is meaningless to another.
  const switchProvider = (id: ProviderId) =>
    // Picking the provider already chosen changes nothing: its endpoint and model stay as they were saved.
    id !== settings?.provider &&
    run(async () => {
      modelGenRef.current++
      setModels([])
      setModelNotice("")
      setModelsNote("")
      const nextModel = id === "chatgpt" || id === "custom" ? "" : PROVIDERS[id].defaultModel || ""
      const updated = await api.saveSettings({ provider: id, model: nextModel })
      if (onSettingsChange) onSettingsChange(updated)
      else setLocalSettings(updated)
      setKey(await api.keyStatus(id))
      onChange?.()
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
            onBlur={(e) => {
              const val = e.target.value.trim()
              if (val !== settings.baseUrl) {
                void save({
                  provider: settings.provider,
                  baseUrl: val,
                })
              }
            }}
          />
          {settings.provider === "custom" && !resolveBaseUrl("custom", settings.baseUrl) && <ErrorText>Set a base URL.</ErrorText>}
        </Field>
      )}
      <ProviderKeyField
        provider={settings.provider}
        status={key}
        onStatus={(nextKey) => {
          setKey(nextKey)
          if (!nextKey.set && settings.provider === "chatgpt") {
            setModels([])
            void save({ model: "" })
          }
          onChange?.()
        }}
        onChange={onChange}
        run={run}
      />
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
            loading={modelsLoading}
            emptyNote={modelsNote}
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
        {modelNotice && <p className="mt-1.5 text-xs text-blue-400">{modelNotice}</p>}
      </Field>
      {provider.supportedProtocols && provider.supportedProtocols.length > 1 && (
        <Field label="Protocol" hint="Inference protocol used by this provider: Chat Completions or Responses.">
          <div className="flex gap-2">
            {provider.supportedProtocols.map((proto) => (
              <Button
                key={proto}
                type="button"
                size="sm"
                variant={(settings.orchestratorProtocol ?? provider.defaultProtocol ?? "chat_completions") === proto ? "default" : "outline"}
                onClick={() => save({ orchestratorProtocol: proto })}
              >
                {proto === "responses" ? "Responses" : "Chat Completions"}
              </Button>
            ))}
          </div>
        </Field>
      )}
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

/**
  A provider's API key: saved to the OS keychain, cleared, and — for a provider with an account page — the link to
  make one and what the provider gives this app's users (specs/specialist-providers R1.5).
*/
export function ProviderKeyField({
  provider,
  status,
  onStatus,
  onChange,
  run,
  label,
}: {
  provider: ProviderId
  status: KeyStatus | null
  onStatus(s: KeyStatus): void
  onChange?(): void
  run(fn: () => Promise<unknown>): Promise<void>
  label?: string
}) {
  const api = window.hfr.api
  const [input, setInput] = useState("")
  const p = PROVIDERS[provider]

  if (provider === "chatgpt") {
    const fieldLabel = label ?? "ChatGPT account / Your ChatGPT plan"
    return (
      <Field
        label={fieldLabel}
        hint={
          status?.set
            ? "Connected via Sign in with ChatGPT (Token Sharing). Tokens are protected by the OS keychain."
            : "Sign in with your personal ChatGPT Plus or Pro account via official Token Sharing without an API key."
        }
      >
        <ChatGPTOAuthBox status={status} onKey={onStatus} onChange={onChange} />
      </Field>
    )
  }

  const fieldLabel = label ?? `${p.label} API key, shared with the orchestrator`
  return (
    <Field
      label={fieldLabel}
      hint={
        status?.set
          ? `Saved (${status.hint}), encrypted with the OS keychain. It is never shown again.`
          : "Encrypted with the OS keychain. It is never shown again."
      }
    >
      <div className="flex gap-2">
        <Input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder={p.keyPlaceholder} autoComplete="off" />
        <Button
          disabled={input.trim().length < 8}
          onClick={() =>
            run(async () => {
              const nextKey = await api.saveKey(input, provider)
              onStatus(nextKey)
              setInput("")
              onChange?.()
            })
          }
        >
          <KeyRound size={14} /> Save
        </Button>
        {status?.set && (
          <Button
            variant="destructive"
            onClick={() =>
              run(async () => {
                const nextKey = await api.clearKey(provider)
                onStatus(nextKey)
                onChange?.()
              })
            }
          >
            Clear
          </Button>
        )}
      </div>
      {p.signupUrl && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          No account yet?{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => run(() => api.openProviderSignup(provider))}>
            Create one at {p.signupUrl.replace(/^https:\/\//, "")}
          </button>
          {p.offer ? ` ${p.offer}` : ""}
        </p>
      )}
      {provider === "hopper" && !status?.set && <HopperSignInBox onKey={onStatus} onChange={onChange} />}
    </Field>
  )
}

/** What the specialist runs on, by name in the provider choice. */
export const specialistLabel = (p: SpecialistProvider) => (p === "claude" ? "Claude Code (your plan)" : PROVIDERS[p].label)

/**
  Who the specialist runs on (specs/specialist-providers R1.1): one of the orchestrator's providers with a model of it —
  its key shared with the orchestrator's — or Claude Code on the user's plan, whose sign-in `claude` shows.
*/
export function SpecialistPanel({
  settings: propSettings,
  onSettingsChange,
  keyRev,
  onChange,
  claude,
  children,
}: {
  settings?: Settings | null
  onSettingsChange?(s: Settings): void
  keyRev?: number
  onChange?(): void
  claude?: ReactNode
  children?: ReactNode
}) {
  const api = window.hfr.api
  const [localSettings, setLocalSettings] = useState<Settings | null>(null)
  const settings = propSettings !== undefined ? propSettings : localSettings
  const [key, setKey] = useState<KeyStatus | null>(null)
  const [models, setModels] = useState<Array<string | ChatGPTModelOption>>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsNote, setModelsNote] = useState("")
  const [modelNotice, setModelNotice] = useState("")
  const { error, run } = useRun(onChange)
  const sp = settings?.specialistProvider
  useEffect(() => {
    if (propSettings === undefined) {
      void api.getSettings().then(setLocalSettings)
    }
  }, [api, propSettings])
  useEffect(() => {
    if (sp && sp !== "claude" && keyRev !== -1) {
      void api.keyStatus(sp).then(setKey)
    }
  }, [api, sp, keyRev])
  const currentSpecialistModel = settings?.specialistModel ?? ""
  const specialistGenRef = useRef(0)
  const currentSpRef = useRef(sp)
  useEffect(() => {
    currentSpRef.current = sp
  }, [sp])

  const loadSpecialistModels = useCallback(async () => {
    if (!sp || sp === "claude") return
    const gen = ++specialistGenRef.current
    setModelsLoading(true)
    setModelsNote("")
    setModelNotice("")
    if (sp === "chatgpt") {
      if (!key?.set) {
        setModelsLoading(false)
        setModelsNote("Connect your ChatGPT account to list available models.")
        setModels([])
        return
      }
      return api
        .listChatGPTModels()
        .then(async (chatgptModels) => {
          if (gen !== specialistGenRef.current || currentSpRef.current !== "chatgpt") return
          setModelsLoading(false)
          setModels(chatgptModels)
          if (chatgptModels.length > 0) {
            const currentModel = currentSpecialistModel
            const hasValid = chatgptModels.some((m) => m.slug === currentModel)
            if (!hasValid) {
              const first = chatgptModels[0]
              const updated = await api.saveSettings({ specialistModel: first.slug, expectedSpecialistProvider: "chatgpt" })
              if (gen !== specialistGenRef.current || currentSpRef.current !== "chatgpt") return
              if (onSettingsChange) onSettingsChange(updated)
              else setLocalSettings(updated)
              onChange?.()
              if (currentModel) {
                setModelNotice(`Previous model unavailable on your plan. Selected ${first.displayName} (${first.slug}).`)
              }
            }
          } else {
            setModelsNote("ChatGPT (Codex) listed no models for this account.")
          }
        })
        .catch((e: unknown) => {
          if (gen !== specialistGenRef.current || currentSpRef.current !== "chatgpt") return
          setModelsLoading(false)
          setModelsNote(message(e))
        })
    }
    if (PROVIDERS[sp].keyRequired && !key?.set) {
      setModelsLoading(false)
      setModelsNote(`Save your ${PROVIDERS[sp].label} API key to list models.`)
      setModels([])
      return
    }
    return api
      .listModels(sp)
      .then(async (list) => {
        if (gen !== specialistGenRef.current || currentSpRef.current !== sp) return
        setModelsLoading(false)
        setModels(list)
        if (sp === "river" && list.length > 0) {
          const currentModel = currentSpecialistModel
          if (currentModel === "deepseek-chat" || !list.includes(currentModel)) {
            const fallback = list.includes(PROVIDERS.river.defaultModel) ? PROVIDERS.river.defaultModel : (list[0] ?? "")
            const updated = await api.saveSettings({ specialistModel: fallback, expectedSpecialistProvider: "river" })
            if (gen !== specialistGenRef.current || currentSpRef.current !== "river") return
            if (onSettingsChange) onSettingsChange(updated)
            else setLocalSettings(updated)
            onChange?.()
            if (currentModel) {
              setModelNotice(`Model "${currentModel}" is not in River catalog. Selected "${fallback}".`)
            }
          }
        }
      })
      .catch((e: unknown) => {
        if (gen !== specialistGenRef.current || currentSpRef.current !== sp) return
        setModelsLoading(false)
        setModelsNote(message(e))
      })
  }, [sp, key?.set, api, currentSpecialistModel, onChange, onSettingsChange])

  useEffect(() => {
    if (!sp || sp === "claude") return
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      loadSpecialistModels()
    })()
    return () => {
      active = false
    }
  }, [sp, loadSpecialistModels])
  if (!settings || !sp) return null
  const save = (patch: Partial<Settings>) =>
    run(async () => {
      const updated = await api.saveSettings(patch)
      if (onSettingsChange) onSettingsChange(updated)
      else setLocalSettings(updated)
      return updated
    })
  const choose = (p: SpecialistProvider) =>
    p !== sp &&
    save({
      specialistProvider: p,
      ...(p === "claude" ? {} : p === "chatgpt" || p === "custom" ? { specialistModel: "" } : { specialistModel: PROVIDERS[p].defaultModel || "" }),
    })
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Runs on"
        hint="A provider's model runs the specialist here as a DeepAgents agent, every command and tool inside the sandbox. Claude Code runs in the sandbox on your Claude plan."
      >
        <div className="flex flex-wrap gap-2">
          {SPECIALIST_PROVIDERS.map((p) => (
            <Button key={p} variant={sp === p ? "default" : "outline"} onClick={() => choose(p)}>
              {specialistLabel(p)}
            </Button>
          ))}
        </div>
      </Field>
      {sp === "claude" ? (
        claude
      ) : (
        <>
          <ProviderKeyField
            provider={sp}
            status={key}
            onStatus={(nextKey) => {
              setKey(nextKey)
              if (!nextKey.set && sp === "chatgpt") {
                setModels([])
                void save({ specialistModel: "" })
              }
              onChange?.()
            }}
            onChange={onChange}
            run={run}
            label={sp === "chatgpt" ? "ChatGPT account / Your ChatGPT plan" : `${PROVIDERS[sp].label} API key, shared with the orchestrator`}
          />
          {PROVIDERS[sp].editableBaseUrl && (
            <Field
              label={`${PROVIDERS[sp].label} base URL`}
              hint={`Where requests go, without /chat/completions. Shared with the orchestrator. Empty uses ${PROVIDERS[sp].baseUrl || "nothing: set one"}.`}
            >
              <Input
                defaultValue={settings.baseUrls?.[sp] ?? (sp === settings.provider ? settings.baseUrl : "")}
                key={`${sp}:${settings.baseUrls?.[sp] ?? (sp === settings.provider ? settings.baseUrl : "")}`}
                placeholder={PROVIDERS[sp].baseUrl || "https://host/v1"}
                onBlur={(e) => {
                  const val = e.target.value.trim()
                  const currentVal = settings.baseUrls?.[sp] ?? (sp === settings.provider ? settings.baseUrl : "")
                  if (val !== currentVal) {
                    void save({
                      specialistBaseUrl: val,
                      ...(sp === settings.provider ? { baseUrl: val } : {}),
                    })
                  }
                }}
              />
              {sp === "custom" && !resolveBaseUrl("custom", settings.baseUrls?.[sp] ?? "") && <ErrorText>Set a base URL.</ErrorText>}
            </Field>
          )}
          <Field
            label="Model"
            hint={sp === "chatgpt" ? "Models available for your connected ChatGPT subscription plan." : "Any model of this provider with tool calling."}
          >
            <div className="flex items-start gap-2">
              <ModelPicker
                key={`${sp}:${settings.specialistModel}`}
                provider={sp}
                value={settings.specialistModel}
                listed={models}
                loading={modelsLoading}
                emptyNote={modelsNote}
                onChange={(m) => save({ specialistModel: m })}
              />
              <Button
                variant="outline"
                onClick={() => run(loadSpecialistModels)}
                aria-label="Refresh the specialist model list"
                title="Refresh the specialist model list"
              >
                <RefreshCw size={14} />
              </Button>
            </div>
            {modelNotice && <p className="mt-1.5 text-xs text-blue-400">{modelNotice}</p>}
            {modelsNote && models.length === 0 && <p className="mt-1.5 text-xs text-muted-foreground">{modelsNote}</p>}
          </Field>
          {PROVIDERS[sp]?.supportedProtocols && PROVIDERS[sp].supportedProtocols.length > 1 && (
            <Field label="Protocol" hint="Inference protocol used by this provider: Chat Completions or Responses.">
              <div className="flex gap-2">
                {PROVIDERS[sp].supportedProtocols.map((proto) => (
                  <Button
                    key={proto}
                    type="button"
                    size="sm"
                    variant={(settings.specialistProtocol ?? PROVIDERS[sp].defaultProtocol ?? "chat_completions") === proto ? "default" : "outline"}
                    onClick={() => save({ specialistProtocol: proto })}
                  >
                    {proto === "responses" ? "Responses" : "Chat Completions"}
                  </Button>
                ))}
              </div>
            </Field>
          )}
        </>
      )}
      {children}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

/**
  Hopper's key without pasting it (specs/specialist-providers R3): the user's email goes to Hopper's registration, Hopper's
  page opens with a code to confirm, and the key comes back into the OS keychain.
*/
export function HopperSignInBox({ onKey, onChange }: { onKey(s: KeyStatus): void; onChange?(): void }) {
  const api = window.hfr.api
  const [email, setEmail] = useState("")
  const [state, setState] = useState<HopperSignIn | null>(null)
  const { error, run } = useRun(onChange)
  const waiting = state?.inProgress ?? false
  useEffect(() => {
    void api.hopperSignInStatus().then(setState)
  }, [api])
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void api.hopperSignInStatus().then(async (s) => {
        setState(s)
        if (s.done) {
          const nextKey = await api.keyStatus("hopper")
          onKey(nextKey)
          onChange?.()
        }
      })
    }, 2000)
    return () => clearInterval(timer)
  }, [api, waiting, onKey, onChange])
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3">
      {waiting && state ? (
        <>
          <p className="text-sm">
            Confirm the code <Mono className="text-base font-semibold">{state.code}</Mono> on the Hopper page that opened in your browser.
          </p>
          <p className="text-xs text-muted-foreground">
            Not open? <Mono>{state.url}</Mono>
          </p>
          <Button className="self-start" variant="ghost" onClick={() => run(async () => setState(await api.cancelHopperSignIn()))}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Or sign in with your Hopper account, or make one, and the key is saved for you.</p>
          <div className="flex gap-2">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            <Button disabled={!/^\S+@\S+\.\S+$/.test(email.trim())} onClick={() => run(async () => setState(await api.startHopperSignIn(email.trim())))}>
              <LogIn size={14} /> Sign in with Hopper
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Your email goes to Hopper, which sends you to its page to sign in or sign up.</p>
        </>
      )}
      {state?.done && <p className="text-xs text-muted-foreground">Signed in: the key is saved in the OS keychain.</p>}
      <ErrorText>{state?.error || error}</ErrorText>
    </div>
  )
}

export function ChatGPTOAuthBox({ status, onKey, onChange }: { status: KeyStatus | null; onKey(s: KeyStatus): void; onChange?(): void }) {
  const api = window.hfr.api
  const [authStatus, setAuthStatus] = useState<ChatGPTAuthStatus | null>(null)
  const statusGeneration = useRef(0)
  const { error, run } = useRun(onChange)

  useEffect(() => {
    let active = true
    const refresh = () => {
      const generation = ++statusGeneration.current
      void api
        .chatGPTAuthStatus()
        .then((s) => {
          if (active && generation === statusGeneration.current) setAuthStatus(s)
        })
        .catch(() => {})
    }
    // Poll so the card reflects the session being rotated by the main process
    // auto-refresh timer instead of freezing on a stale expiry / error.
    const timer = setInterval(refresh, 30_000)
    refresh()
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api])

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      {status?.set ? (
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-emerald-500">Connected with ChatGPT</p>
            {authStatus?.accountEmail && (
              <p className="text-xs text-muted-foreground">
                {authStatus.accountEmail} ({authStatus.planType ?? "subscription plan"})
              </p>
            )}
            {authStatus?.expiresAt && (
              <p className="text-[10px] text-muted-foreground">Session active (expires {new Date(authStatus.expiresAt).toLocaleTimeString()})</p>
            )}
            {authStatus?.warning && <p className="mt-1 text-xs text-amber-500">{authStatus.warning}</p>}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              run(async () => {
                const s = await api.chatGPTLogout()
                statusGeneration.current++
                setAuthStatus(s)
                const nextKey = await api.keyStatus("chatgpt")
                onKey(nextKey)
                onChange?.()
              })
            }
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Sign in with your personal ChatGPT Plus or Pro account via official token sharing without requiring an API key.
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() =>
                run(async () => {
                  const s = await api.startChatGPTAuth()
                  statusGeneration.current++
                  setAuthStatus(s)
                  const nextKey = await api.keyStatus("chatgpt")
                  onKey(nextKey)
                  onChange?.()
                })
              }
            >
              <LogIn size={14} /> Connect ChatGPT Account
            </Button>
          </div>
          {authStatus?.warning && <p className="text-xs text-amber-500">{authStatus.warning}</p>}
        </div>
      )}
      <ErrorText>{authStatus?.error || error}</ErrorText>
    </div>
  )
}
