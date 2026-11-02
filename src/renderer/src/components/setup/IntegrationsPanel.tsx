import { AlertTriangle, CheckCircle2, Plug, RefreshCw, XCircle } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { IntegrationActionResult, IntegrationSettings, IntegrationStatus, IntegrationView } from "@shared/integrations"
import type { Settings } from "@shared/types"
import { ErrorText, Field, Mono } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { settingsOf, toolRows, withChoice } from "@/lib/integrations"
import { message } from "./panels"

/*
  The MCP section of Settings (specs/mcp-integrations R1, R2): every integration the app carries, each off by default,
  with its settings, its switch, its checks and their fixes, its actions, whether it is connected, and its tools with
  one checkbox per agent. There is no way to add another.
*/

export function IntegrationsPanel({ settings, onSaved }: { settings: Settings; onSaved(s: Settings): void }) {
  const api = window.hfr.api
  const [views, setViews] = useState<IntegrationView[] | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    void api
      .integrations()
      .then(setViews)
      .catch((e: unknown) => setError(message(e)))
  }, [api])
  if (!views) return <ErrorText>{error}</ErrorText>
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Engines on this machine the agents can use only through the app. Each is off until you turn it on, and every target they work on is yours to approve.
      </p>
      {views.map((v) => (
        <Integration key={v.id} view={v} settings={settings} onSaved={onSaved} />
      ))}
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

function Integration({ view, settings, onSaved }: { view: IntegrationView; settings: Settings; onSaved(s: Settings): void }) {
  const api = window.hfr.api
  const s = settingsOf(view, settings.integrations)
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [action, setAction] = useState<IntegrationActionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => setStatus(await api.integrationStatus(view.id)), [api, view.id])
  useEffect(() => {
    if (s.enabled)
      void api
        .integrationStatus(view.id)
        .then(setStatus)
        .catch(() => undefined)
  }, [api, view.id, s.enabled])

  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    setError("")
    try {
      await f()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const save = (next: IntegrationSettings) =>
    run(async () => {
      onSaved(await api.saveSettings({ integrations: { [view.id]: next } }))
      // Turning it on ran its checks: show each, the failed ones with their fix (R1.2, R1.3).
      if (next.enabled || status) await refresh()
    })

  const rows = toolRows(view, s)
  return (
    <section className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Plug size={14} />
            <span className="font-medium">{view.title}</span>
            {s.enabled && status && <Badge variant={status.connected ? "ok" : "warn"}>{status.connected ? "connected" : "not connected"}</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">{view.description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <Checkbox
            checked={s.enabled}
            disabled={busy}
            onCheckedChange={(v) => void save({ ...s, enabled: v === true })}
            aria-label={`Turn ${view.title} on`}
          />
          {s.enabled ? "On" : "Off"}
        </label>
      </div>

      {view.fields.map((f) => (
        <Field key={f.label} label={f.label} hint={f.hint}>
          <Input
            defaultValue={String(s.config[f.key] ?? "")}
            disabled={busy}
            onBlur={(e) => e.target.value !== String(s.config[f.key] ?? "") && void save({ ...s, config: { ...s.config, [f.key]: e.target.value } })}
          />
        </Field>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {view.actions.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant="outline"
            disabled={busy}
            title={a.description}
            onClick={() =>
              void run(async () => {
                setAction(await api.runIntegrationAction(view.id, a.id))
                await refresh()
              })
            }
          >
            {a.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(refresh)} aria-label="Run the checks">
          <RefreshCw size={13} /> Check
        </Button>
      </div>
      {action && (
        <div className={`rounded-md border px-3 py-2 text-sm ${action.ok ? "border-border" : "border-warning/40 bg-warning/10"}`}>
          <p>{action.message}</p>
          {action.paths?.map((p) => (
            <p key={p.label} className="mt-1 text-xs text-muted-foreground">
              {p.label}: <Mono className="select-all">{p.path}</Mono>
            </p>
          ))}
        </div>
      )}

      {status && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {status.checks.map((c) => (
            <li key={c.name} className="flex items-start gap-2">
              {c.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-destructive" />}
              <span>
                <span className="font-medium">{c.name}</span> <span className="text-muted-foreground">{c.detail}</span>
                {!c.ok && c.fix && <span className="block text-xs">{c.fix}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 font-medium">Tool</th>
            <th className="w-28 py-1 text-center font-medium">Orchestrator</th>
            <th className="w-28 py-1 text-center font-medium">Specialist</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-border align-top">
              <td className="py-1.5 pr-3">
                <Mono>{r.name}</Mono>
                {r.target && <span className="ml-2 text-xs text-muted-foreground">on the approved target</span>}
                <span className="block text-xs text-muted-foreground">{r.description}</span>
                {r.warn && (
                  <span className="mt-1 flex items-start gap-1 text-xs text-warning">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    What it returns goes to the orchestrator&apos;s model and its provider, with anything the target holds.
                  </span>
                )}
              </td>
              {(["orchestrator", "specialist"] as const).map((agent) => (
                <td key={agent} className="py-1.5 text-center">
                  <Checkbox
                    checked={r[agent]}
                    disabled={busy}
                    aria-label={`${r.name} for the ${agent}`}
                    onCheckedChange={(v) => void save(withChoice(view, s, r.name, agent, v === true))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorText>{error}</ErrorText>
    </section>
  )
}
