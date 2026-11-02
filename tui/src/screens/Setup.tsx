import { TextAttributes } from "@opentui/core"
import { useCallback, useEffect, useState } from "react"
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../../../src/shared/providers"
import type { KeyStatus, LoginStatus, Readiness, SandboxStatus, Settings } from "../../../src/shared/types"
import type { Command } from "../app/commands"
import { useApp, usePush, useScreen, type AppState, type Route } from "../app/context"
import { SelectDialog } from "../components/dialogs"
import { safe } from "../components/ui"

/*
  The first-run setup in the terminal (specs/tui-panels R3): the sandbox images with their preparation's log, the
  Claude sign-in opened in the browser with its code pasted back, cancelled or signed out, and the orchestrator's
  provider, base URL, key and model — each step's state from the same readiness the desktop app reads, completed with
  /done once every step is ready.
*/

/** Provider, key and model commands, shared with the settings editor (R3.4, R4.1). */
export function providerCommands(app: AppState, settings: Settings | null, refresh: () => void): Command[] {
  const { api } = app
  const provider = settings?.provider ?? "openrouter"
  const pickProvider = async () => {
    const id = await app.dialog<string>((done) => (
      <SelectDialog
        title="Provider"
        items={PROVIDER_IDS.map((p) => ({ id: p, label: PROVIDERS[p].label, detail: PROVIDERS[p].baseUrl || "your own endpoint" }))}
        initial={provider}
        done={done}
      />
    ))
    if (!id) return
    const p = PROVIDERS[id as ProviderId]
    // Switching provider swaps in its own endpoint (kept per provider), model and key; one provider's model name means nothing to another.
    await app.attempt(() => api.saveSettings({ provider: p.id, model: p.defaultModel || settings?.model }), `Provider: ${p.label}.`)
    refresh()
  }
  const pickModel = async (arg: string) => {
    let model = arg.trim()
    if (!model) {
      const models = await app.attempt(() => api.listModels())
      if (!models) return app.toast("No model list here: name the model with /model <id>; the setup checks it with a test request.", "info")
      const id = await app.dialog<string>((done) => (
        <SelectDialog title={`Models of ${PROVIDERS[provider].label}`} items={models.map((m) => ({ id: m, label: m }))} initial={settings?.model} done={done} />
      ))
      if (!id) return
      model = id
    }
    await app.attempt(() => api.saveSettings({ model }), `Model: ${model}.`)
    refresh()
  }
  return [
    { name: "provider", title: "Pick the orchestrator's provider", run: pickProvider },
    {
      name: "base-url",
      title: "Set the provider's base URL",
      args: "<url>",
      run: async (url) => {
        // Named with the provider it is for, so a switch made elsewhere in between never files it under another.
        await app.attempt(() => api.saveSettings({ ...(settings ? { provider: settings.provider } : {}), baseUrl: url.trim() }), "Base URL saved.")
        refresh()
      },
    },
    {
      name: "key",
      title: "Save the provider's API key in the OS keychain",
      args: "<key>",
      run: async (key) => {
        await app.attempt(() => api.saveKey(key.trim(), provider), "Key saved in the OS keychain.")
        refresh()
      },
    },
    {
      name: "remove-key",
      title: "Remove the provider's API key",
      run: async () => {
        await app.attempt(() => api.clearKey(provider), "Key removed.")
        refresh()
      },
    },
    { name: "model", title: "Pick the model from the provider's list, or name it", args: "[id]", run: pickModel },
  ]
}

export function SetupScreen({ then }: { then?: Route }) {
  const app = useApp()
  const { api, theme } = app
  const [r, setR] = useState<Readiness | null>(null)
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [login, setLogin] = useState<LoginStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState<KeyStatus | null>(null)

  const { toast } = app
  const refresh = useCallback(() => {
    void api.readiness().then(setR, (e: unknown) => toast((e as Error).message, "error"))
    void api.sandboxStatus().then(setSandbox, () => undefined)
    void api.loginStatus().then(setLogin, () => undefined)
    void api.getSettings().then((s) => {
      setSettings(s)
      return api.keyStatus(s.provider).then(setKey)
    })
  }, [api, toast])
  useEffect(refresh, [refresh])
  usePush((p) => {
    if (p.type === "sandbox") {
      setSandbox(p.status)
      void api.readiness().then(setR, () => undefined)
    } else if (p.type === "login") {
      setLogin(p.status)
      void api.readiness().then(setR, () => undefined)
    }
  })

  const commands: Command[] = [
    { name: "images", title: "Prepare the sandbox images again", run: () => void app.attempt(() => api.buildSandbox()).then((s) => s && setSandbox(s)) },
    {
      name: "login",
      title: "Sign Claude in, opening the page in your browser",
      run: async () => {
        const s = await app.attempt(() => api.startLogin())
        if (s) setLogin(s)
        // The page's address shows up in the sign-in's output a moment later.
        setTimeout(() => void api.openLoginUrl().then((ok) => !ok && app.toast("Open the address shown under the sign-in step.", "info")), 1500)
      },
    },
    { name: "open-login", title: "Open the sign-in page in your browser", run: () => void app.attempt(() => api.openLoginUrl()) },
    {
      name: "code",
      title: "Send the code the sign-in page gave you",
      args: "<code>",
      run: (code) => void app.attempt(() => api.sendLoginCode(code.trim())).then((s) => s && setLogin(s)),
    },
    { name: "cancel-login", title: "Cancel the sign-in", run: () => void app.attempt(() => api.cancelLogin()).then((s) => s && setLogin(s)) },
    { name: "logout", title: "Sign Claude out", run: () => void app.attempt(() => api.logout(), "Signed out.").then((s) => s && setLogin(s)) },
    ...providerCommands(app, settings, refresh),
    { name: "refresh", title: "Check every step again", run: refresh },
    {
      name: "done",
      title: "Finish the setup",
      run: async () => {
        const done = await app.attempt(() => api.completeSetup(), "Setup completed.")
        if (done) app.go(then ?? { kind: "launch" })
      },
    },
  ]
  useScreen({
    title: "Setup",
    status: r?.ready ? "ready" : undefined,
    commands,
    placeholder: "Type / for the setup's commands: /images, /login, /key, /model, /done",
  })

  const mark = (ready: boolean | undefined) => <span fg={ready ? theme.success : theme.warning}>{ready ? "✓ " : "○ "}</span>
  const head = (t: string, ready: boolean | undefined) => (
    <text fg={theme.foreground} attributes={TextAttributes.BOLD}>
      {mark(ready)}
      {t}
    </text>
  )
  const why = (s: string | undefined) => (s ? <text fg={theme.mutedForeground}>{safe(s)}</text> : null)
  const provider = settings ? PROVIDERS[settings.provider] : null
  const log = (sandbox?.buildLog ?? "").split("\n").filter(Boolean).slice(-8)
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.mutedForeground}>Ready what every project needs. Each step names the command that readies it.</text>
      <box flexDirection="column">
        {head("1 · Sandbox images", r?.sandbox.ready)}
        {why(r?.sandbox.reason)}
        <text fg={theme.mutedForeground}>
          {sandbox
            ? `Docker ${sandbox.docker ? "running" : `not running${sandbox.dockerError ? `: ${safe(sandbox.dockerError)}` : ""}`} · images ${sandbox.images ? "ready" : sandbox.building ? "being prepared" : "missing"} · Claude Code ${sandbox.claudeVersion}`
            : "…"}
        </text>
        {log.length > 0 && (
          <box flexDirection="column" border={["left"]} borderColor={theme.border} paddingLeft={1}>
            {log.map((l, i) => (
              <text key={i} fg={theme.mutedForeground} wrapMode="none">
                {safe(l)}
              </text>
            ))}
          </box>
        )}
        <text fg={theme.primary}>/images prepares them again</text>
      </box>
      <box flexDirection="column">
        {head("2 · Claude sign-in", r?.claude.ready)}
        {why(r?.claude.reason)}
        {login?.loggedIn ? (
          <text fg={theme.success}>{safe(`Signed in${login.plan ? ` on ${login.plan}` : ""}${login.email ? ` as ${login.email}` : ""}`)}</text>
        ) : null}
        {login?.inProgress ? (
          <text fg={theme.foreground}>
            {"Signing in: "}
            <span fg={theme.primary}>{safe(login.url ?? "waiting for the page's address…")}</span>
            {" · paste the code with /code <code> · /cancel-login"}
          </text>
        ) : null}
        {login?.error ? <text fg={theme.destructive}>{safe(login.error)}</text> : null}
        <text fg={theme.primary}>{login?.loggedIn ? "/logout signs out" : "/login opens the sign-in in your browser"}</text>
      </box>
      <box flexDirection="column">
        {head("3 · Orchestrator's model", r?.model.ready)}
        {why(r?.model.reason)}
        {settings && provider ? (
          <text fg={theme.foreground}>
            {`${provider.label} · ${settings.model || "no model"}`}
            <span
              fg={theme.mutedForeground}
            >{` · ${settings.baseUrl || provider.baseUrl || "no base URL"} · key ${key?.set ? `set ${key.hint}` : "not set"}`}</span>
          </text>
        ) : null}
        {key && !key.encryption ? (
          <text fg={theme.destructive}>The OS keychain is unavailable, so a key cannot be stored. It is never kept in plain text.</text>
        ) : null}
        <text fg={theme.primary}>
          /provider · /base-url {"<url>"} · /key {"<key>"} · /remove-key · /model
        </text>
      </box>
      <text fg={r?.ready ? theme.success : theme.mutedForeground} attributes={TextAttributes.BOLD}>
        {r?.ready ? "Every step is ready: /done finishes the setup." : "/done finishes the setup once every step is ready."}
      </text>
    </box>
  )
}
