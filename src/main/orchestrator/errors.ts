/* Provider failures (OpenRouter, DeepSeek, any OpenAI-compatible API) as messages the user can act on (specs/orchestrator R1.4). Ported from study-lab. */

export class OrchestratorError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "OrchestratorError"
    this.status = status
  }
}

export function friendlyError(e: unknown, provider = "OpenRouter"): Error {
  const err = e as { statusCode?: number; status?: number; message?: string; name?: string }
  const status = err?.statusCode ?? err?.status
  const msg = String(err?.message ?? e)
  if (status === 401 || /user not found|invalid api key|no auth credentials|unauthorized/i.test(msg))
    return new OrchestratorError(`${provider} rejected the API key. Set a valid key in Settings.`, 401)
  if (status === 402 || /insufficient credits|payment required/i.test(msg))
    return new OrchestratorError(`Your ${provider} account is out of credits. Add credits and retry the task.`, 402)
  if (status === 429 || /rate.?limit/i.test(msg))
    return new OrchestratorError(`${provider} is rate-limiting this model. Retry in a minute or pick another model in Settings.`, 429)
  // LangChain's MODEL_NOT_FOUND: the endpoint or the model is wrong, the commonest mistake being a base URL without its /v1.
  if (status === 404 || /MODEL_NOT_FOUND/.test(msg))
    return new OrchestratorError(
      `${provider} answered 404 (not found): the base URL or the model is wrong. The base URL is the one /chat/completions is added to — for most services it ends in /v1 — and the model must be one that service serves.`,
      404,
    )
  if (/no endpoints found/i.test(msg))
    return new OrchestratorError("No OpenRouter provider can serve this model with tool calling and data collection denied. Pick another model in Settings.")
  if (err?.name === "AbortError" || /abort/i.test(msg)) return new OrchestratorError("Cancelled.")
  return e instanceof Error ? e : new Error(msg)
}
