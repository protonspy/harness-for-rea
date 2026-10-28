import { ExternalLink, Hammer, KeyRound, LogIn, LogOut, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"
import { MODEL_PRESETS } from "@shared/defaults"
import type { KeyStatus, LoginStatus, SandboxStatus, Settings } from "@shared/types"
import { Badge, Button, Card, CardHeader, ErrorText, Field, Input, Mono } from "@/components/ui"

/* Settings: the OpenRouter key, the model, the sandbox limits, Docker, images and the Claude sign-in (specs/desktop-ui R1). */

const message = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method 'api': (\w*Error: )?/, "")

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState<KeyStatus | null>(null)
  const [keyInput, setKeyInput] = useState("")
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [login, setLogin] = useState<LoginStatus | null>(null)
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const api = window.hfr.api

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.keyStatus().then(setKey)
    void api.sandboxStatus().then(setSandbox)
    void api.loginStatus().then(setLogin)
    return window.hfr.onPush((p) => {
      if (p.type === "sandbox") setSandbox(p.status)
      if (p.type === "login") setLogin(p.status)
    })
  }, [api])

  const run = async (fn: () => Promise<unknown>) => {
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(message(e))
    }
  }
  const save = (patch: Partial<Settings>) => run(async () => setSettings(await api.saveSettings(patch)))
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v))

  if (!settings) return null
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <ErrorText>{error}</ErrorText>

      <Card>
        <CardHeader title="Orchestrator (OpenRouter)" actions={key && <Badge tone={key.set ? "ok" : "warn"}>{key.set ? `key ${key.hint}` : "no key"}</Badge>} />
        <div className="flex flex-col gap-4 p-4">
          {key && !key.encryption && <ErrorText>The OS keychain is unavailable, so a key cannot be stored. It is never kept in plain text.</ErrorText>}
          <Field label="API key" hint="Encrypted with the Windows keychain. It is never shown again.">
            <div className="flex gap-2">
              <Input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="sk-or-v1-…" autoComplete="off" />
              <Button
                disabled={keyInput.trim().length < 8}
                onClick={() =>
                  run(async () => {
                    setKey(await api.saveKey(keyInput))
                    setKeyInput("")
                  })
                }
              >
                <KeyRound size={14} /> Save
              </Button>
              {key?.set && (
                <Button variant="bad" onClick={() => run(async () => setKey(await api.clearKey()))}>
                  Clear
                </Button>
              )}
            </div>
          </Field>
          <Field label="Model" hint="Any OpenRouter model with tool calling. The preset is also sent as the fallback; provider data collection is denied.">
            <div className="flex gap-2">
              <Input
                defaultValue={settings.model}
                key={settings.model}
                onBlur={(e) => e.target.value !== settings.model && save({ model: e.target.value.trim() })}
              />
              {MODEL_PRESETS.map((m) => (
                <Button
                  key={m}
                  size="md"
                  variant={settings.model === m ? "primary" : "outline"}
                  onClick={() => save({ model: m })}
                  className="shrink-0 font-mono text-xs"
                >
                  {m.split("/")[1]}
                </Button>
              ))}
            </div>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Sandbox (Docker)"
          actions={
            sandbox && (
              <div className="flex items-center gap-2">
                <Badge tone={sandbox.docker ? "ok" : "bad"}>{sandbox.docker ? "docker running" : "docker unavailable"}</Badge>
                <Badge tone={sandbox.images ? "ok" : "warn"}>
                  {sandbox.building ? "building" : sandbox.images ? `images ready · claude ${sandbox.claudeVersion}` : "images missing"}
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
            <p className="text-sm text-muted">Start Docker Desktop. The specialist never runs outside its container. ({sandbox.dockerError})</p>
          )}
          <div className="flex items-center gap-3">
            <Button className="shrink-0" disabled={!sandbox?.docker || sandbox.building} onClick={() => run(async () => setSandbox(await api.buildSandbox()))}>
              <Hammer size={14} /> {sandbox?.images ? "Rebuild images" : "Build images"}
            </Button>
            <span className="text-xs text-muted">
              Downloads Claude Code {sandbox?.claudeVersion}, checks its signed manifest and SHA-256, and builds the egress proxy.
            </span>
          </div>
          {sandbox?.buildLog && (
            <pre className="max-h-56 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] whitespace-pre-wrap text-muted">
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
            <Field label="Memory (MB)">
              <Input
                type="number"
                min={256}
                defaultValue={settings.memoryMb}
                onBlur={(e) => Number.isInteger(num(e.target.value)) && save({ memoryMb: num(e.target.value) })}
              />
            </Field>
            <Field label="CPUs">
              <Input
                type="number"
                min={0.5}
                step={0.5}
                defaultValue={settings.cpus}
                onBlur={(e) => !Number.isNaN(num(e.target.value)) && save({ cpus: num(e.target.value) })}
              />
            </Field>
            <Field label="Process limit">
              <Input
                type="number"
                min={32}
                defaultValue={settings.pidsLimit}
                onBlur={(e) => Number.isInteger(num(e.target.value)) && save({ pidsLimit: num(e.target.value) })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.discardOnCompletion} onChange={(e) => save({ discardOnCompletion: e.target.checked })} />
            Discard each workspace, snapshot and decided patch when its delegation ends
          </label>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Specialist (Claude plan)"
          actions={
            login && <Badge tone={login.loggedIn ? "ok" : "warn"}>{login.loggedIn ? `signed in${login.plan ? ` · ${login.plan}` : ""}` : "signed out"}</Badge>
          }
        />
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted">
            The specialist signs in with your own Claude plan, inside the sandbox image. The app never reads the stored credential.
          </p>
          {login?.email && <Mono className="text-muted">{login.email}</Mono>}
          {login?.inProgress ? (
            <div className="flex flex-col gap-3">
              {login.url ? (
                <Button className="self-start" onClick={() => run(() => api.openLoginUrl())}>
                  <ExternalLink size={14} /> Open the Anthropic sign-in page
                </Button>
              ) : (
                <span className="text-sm text-muted">Starting the sign-in…</span>
              )}
              <Field label="Code from the Anthropic page">
                <div className="flex gap-2">
                  <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
                  <Button
                    variant="primary"
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
                <Button variant="bad" onClick={() => run(async () => setLogin(await api.logout()))}>
                  <LogOut size={14} /> Sign out
                </Button>
              )}
            </div>
          )}
          {login?.error && <ErrorText>{login.error}</ErrorText>}
        </div>
      </Card>
    </div>
  )
}
