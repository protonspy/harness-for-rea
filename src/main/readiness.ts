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
}

/** The provider, model and endpoint a task runs with: a project's own, or Settings' during the setup. */
export interface RunChoice {
  provider: ProviderId
  model: string
  baseUrl: string
}

/** A provider's base URL: kept in Settings for the provider Settings is on, the provider's default for any other. */
export function baseUrlFor(provider: ProviderId, settings: Pick<Settings, "provider" | "baseUrl">): string {
  return resolveBaseUrl(provider, provider === settings.provider ? settings.baseUrl : "")
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
  else if (!run.baseUrl) model.reason = `Set the base URL of your ${label} in Settings, with Settings on that provider.`
  else if (!run.model.trim()) model.reason = `Choose a model from ${label}.`
  else if (o.list === false) model = { ...model, ready: true }
  else {
    try {
      const listed = await d.listModels(run)
      model = listed.length ? { ...model, ready: true } : { ...model, reason: `${label} listed no models.` }
    } catch (e) {
      model.reason = `${label} did not answer: ${(e as Error).message}`
    }
  }

  return { sandbox, claude, model, ready: sandbox.ready && claude.ready && model.ready, completed: settings.setupCompleted }
}

/** Why a task may not start now, or null: the first step that is not ready (specs/onboarding R2.1). */
export function blocking(r: Readiness): string | null {
  for (const step of [r.sandbox, r.claude, r.model]) if (!step.ready) return step.reason
  return null
}
