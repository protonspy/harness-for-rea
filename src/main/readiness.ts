import { refusedKey } from "./orchestrator/models"
import { PROVIDERS, resolveBaseUrl, type ProviderId } from "@shared/providers"
import type { LoginStatus, Readiness, SandboxStatus, Settings } from "@shared/types"

/*
  Whether the app is ready to run a task, step by step (specs/onboarding R1, R2): the sandbox images
  prepared on a running Docker, Claude Code signed in on the user's plan, and the orchestrator's provider
  with its key and a model it lists. Each step says why it is not ready and what readies it.
*/

export interface ReadinessDeps {
  sandbox(): Promise<SandboxStatus>
  /** the sign-in state, read from the login volume through the sandbox image */
  login(): Promise<LoginStatus>
  settings(): Settings
  keySet(provider: ProviderId): boolean
  listModels(run: RunChoice): Promise<string[]>
  /** a one-token request to the chosen model, for a provider whose model list does not answer */
  probeModel(run: RunChoice): Promise<void>
  /** what identifies the key in use, so a passed test is not repeated for the same provider, endpoint, model and key */
  keyHint?(provider: ProviderId): string
}

/** Test requests that passed, by what they tested, so readiness does not spend a request at every check. */
const probed = new Map<string, number>()
const PROBE_FOR_MS = 10 * 60_000

/** The provider, model and endpoint a task runs with: a project's own, or Settings' during the setup. */
export interface RunChoice {
  provider: ProviderId
  model: string
  baseUrl: string
}

/** A provider's base URL: its own, kept in Settings whichever provider Settings is on, else its default (specs/orchestrator R1.10). */
export function baseUrlFor(provider: ProviderId, settings: Pick<Settings, "provider" | "baseUrl"> & Partial<Pick<Settings, "baseUrls">>): string {
  return resolveBaseUrl(provider, settings.baseUrls?.[provider] ?? (provider === settings.provider ? settings.baseUrl : ""))
}

/** Every provider but a custom endpoint takes a key; a local OpenAI-compatible server may take none. */
export function needsKey(provider: ProviderId): boolean {
  return provider !== "custom"
}

/**
  The steps, for Settings' provider and model or for a project's (`run`). `list: false` checks the key, the endpoint
  and the model without asking the provider for its list, which a task start does not wait on.
*/
export async function readiness(d: ReadinessDeps, o: { run?: Omit<RunChoice, "baseUrl">; list?: boolean } = {}): Promise<Readiness> {
  const settings = d.settings()
  const s = await d.sandbox()
  const sandbox = {
    ready: s.docker && s.images && !s.building,
    building: s.building,
    reason: !s.docker
      ? `Docker is not running (${s.dockerError || "no answer"}). Start Docker Desktop.`
      : s.building
        ? "Preparing the sandbox images…"
        : !s.images
          ? "The sandbox images are not prepared yet. Prepare them."
          : "",
  }

  // The sign-in is read through the sandbox image, so it waits for the sandbox.
  let claude: Readiness["claude"] = { ready: false, reason: "Ready the sandbox first: Claude Code runs inside it." }
  if (sandbox.ready) {
    const l = await d.login().catch((e: unknown): LoginStatus | null => {
      claude = { ready: false, reason: `The sign-in could not be read: ${(e as Error).message}` }
      return null
    })
    if (l) claude = l.loggedIn ? { ready: true, reason: "", plan: l.plan, email: l.email } : { ready: false, reason: "Sign in to Claude Code with your plan." }
  }

  const provider = o.run?.provider ?? settings.provider
  const run: RunChoice = { provider, model: o.run?.model ?? settings.model, baseUrl: baseUrlFor(provider, settings) }
  const label = PROVIDERS[provider].label
  let model: Readiness["model"] = { ready: false, reason: "", provider, model: run.model }
  if (needsKey(provider) && !d.keySet(provider)) model.reason = `Set your ${label} API key.`
  else if (!run.baseUrl) model.reason = `Set the base URL of your ${label} in Settings.`
  else if (!run.model.trim()) model.reason = `Choose a model from ${label}.`
  else if (o.list === false) model = { ...model, ready: true }
  else {
    try {
      const listed = await d.listModels(run)
      model = listed.length ? { ...model, ready: true } : { ...model, reason: `${label} listed no models.` }
    } catch (e) {
      // A refused key is final; any other failure of the list — many OpenAI-compatible servers have none — is
      // settled by a one-token request to the chosen model (specs/onboarding R1.6).
      if (refusedKey(e)) model.reason = (e as Error).message
      else {
        const key = JSON.stringify([run.provider, run.baseUrl, run.model, d.keyHint?.(run.provider) ?? ""])
        if ((probed.get(key) ?? 0) > Date.now()) model = { ...model, ready: true }
        else
          try {
            await d.probeModel(run)
            probed.set(key, Date.now() + PROBE_FOR_MS)
            model = { ...model, ready: true }
          } catch (p) {
            model.reason = refusedKey(p) ? (p as Error).message : `${label} has no model list, and a test request failed: ${(p as Error).message}`
          }
      }
    }
  }

  return { sandbox, claude, model, ready: sandbox.ready && claude.ready && model.ready, completed: settings.setupCompleted }
}

/** Why a task may not start now, or null: the first step that is not ready (specs/onboarding R2.1). */
export function blocking(r: Readiness): string | null {
  for (const step of [r.sandbox, r.claude, r.model]) if (!step.ready) return step.reason
  return null
}
