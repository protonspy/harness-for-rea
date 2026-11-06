import { redact } from "./events/redact"

/*
  River AI authentication investigation (adr:0029, specs/river-auth R1.1–R2.3).
  Official documentation consulted (https://docs.river.ai/guides/inference/ on 2026-11-04)
  indicates that River requires an API key generated in the River Console (https://console.river.ai/keys)
  and passed as an HTTP Bearer token. No official public OAuth 2.0 or device authorization contract
  was found for external third-party clients.
  This module records the external blocker, validates River API keys against the official endpoint,
  and protects secret credentials from leakage.
*/

export const RIVER_API_ORIGIN = "https://api.river.ai"
export const RIVER_API_BASE_URL = `${RIVER_API_ORIGIN}/v1`
export const RIVER_MODELS_URL = `${RIVER_API_BASE_URL}/models`
export const RIVER_CONSOLE_ORIGIN = "https://console.river.ai"
export const RIVER_CONSOLE_KEYS_URL = `${RIVER_CONSOLE_ORIGIN}/keys`
export const RIVER_DOCS_INFERENCE_URL = "https://docs.river.ai/guides/inference/"

export interface RiverAuthStatus {
  hasOfficialBrowserLogin: boolean
  supportedAuthMethod: "api_key"
  message: string
  consoleUrl: string
  docsUrl: string
}

export interface RiverKeyValidation {
  valid: boolean
  error?: string
  status?: number
  modelsCount?: number
  models?: string[]
  hasModel?: boolean
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class RiverAuthService {
  private readonly fetch: Fetch

  constructor(fetchImpl?: Fetch) {
    this.fetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  }

  /**
   * Reports capability status for River account authentication (specs/river-auth R1.1, R1.2).
   * Reflects that no official public browser OAuth flow was found.
   */
  capability(): RiverAuthStatus {
    return {
      hasOfficialBrowserLogin: false,
      supportedAuthMethod: "api_key",
      message: "No public documented browser authorization or OAuth flow was found for River. Authenticate using an API key from the River Console.",
      consoleUrl: RIVER_CONSOLE_KEYS_URL,
      docsUrl: RIVER_DOCS_INFERENCE_URL,
    }
  }

  /**
   * Whether River provides an official browser login flow.
   * False based on public documentation consulted on 2026-11-04 (adr:0029).
   */
  hasOfficialBrowserLoginFlow(): boolean {
    return false
  }

  /**
   * Attempting to start a browser sign-in for River is rejected with an explicit
   * explanation and the direct console URL (specs/river-auth R1.4, adr:0029).
   */
  async startBrowserSignIn(): Promise<never> {
    throw new Error(`River AI does not support browser authorization for external applications. Please generate an API key at ${RIVER_CONSOLE_KEYS_URL}.`)
  }

  /**
   * Sanitizes a River API key (trims whitespace).
   */
  sanitizeKey(key: string): string {
    return key.trim()
  }

  /**
   * Validates a River API key against the official /v1/models endpoint using Bearer auth (specs/river-auth R2.3).
   * - Restricts target exclusively to the fixed official HTTPS endpoint RIVER_MODELS_URL.
   * - Sanitizes and checks key format to avoid malformed header exceptions.
   * - Redacts exception details to prevent leaking secrets through transport/header errors.
   * - Validates response JSON structure (data array of models), distinguishing empty catalogs from invalid responses.
   * - Optionally checks whether a specific model ID exists in the catalog.
   */
  async validateKey(key: string, requiredModel?: string): Promise<RiverKeyValidation> {
    const sanitized = this.sanitizeKey(key)
    if (!sanitized) {
      return { valid: false, error: "River API key cannot be empty." }
    }

    if (/[\r\n\x00-\x1F\x7F]/.test(sanitized)) {
      return { valid: false, error: "River API key contains invalid characters." }
    }

    try {
      const response = await this.fetch(RIVER_MODELS_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${sanitized}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (response.ok) {
        let body: unknown
        try {
          body = await response.json()
        } catch {
          return {
            valid: false,
            status: response.status,
            error: "River returned invalid or non-JSON response.",
          }
        }

        if (!body || typeof body !== "object") {
          return {
            valid: false,
            status: response.status,
            error: "River returned an unexpected response structure.",
          }
        }

        const record = body as Record<string, unknown>
        if ("error" in record && record.error) {
          const errObj = record.error as Record<string, unknown>
          const rawErr = typeof errObj?.message === "string" ? errObj.message : "River returned an error in response body."
          return {
            valid: false,
            status: response.status,
            error: `River returned error: ${redact(rawErr.split(sanitized).join("[redacted]"))}`,
          }
        }

        if (!Array.isArray(record.data)) {
          return {
            valid: false,
            status: response.status,
            error: "River response missing models data array.",
          }
        }

        const models: string[] = []
        for (const item of record.data) {
          if (!item || typeof item !== "object" || !("id" in item)) {
            return {
              valid: false,
              status: response.status,
              error: "River response contains malformed model entries.",
            }
          }
          const rawId = (item as Record<string, unknown>).id
          if (typeof rawId !== "string" || rawId.trim().length === 0) {
            return {
              valid: false,
              status: response.status,
              error: "River response contains invalid model ID.",
            }
          }
          models.push(rawId.trim())
        }

        const result: RiverKeyValidation = {
          valid: true,
          status: response.status,
          modelsCount: models.length,
          models,
        }

        if (requiredModel !== undefined) {
          result.hasModel = models.includes(requiredModel)
        }

        return result
      }

      if (response.status === 401) {
        return { valid: false, status: 401, error: "Invalid River API key." }
      }

      if (response.status === 403) {
        return { valid: false, status: 403, error: "River account does not have access or permissions for this endpoint." }
      }

      if (response.status === 429) {
        return { valid: false, status: 429, error: "River rate limit exceeded or credit quota exhausted." }
      }

      return {
        valid: false,
        status: response.status,
        error: `River answered with HTTP error (${response.status}).`,
      }
    } catch (err) {
      let rawMsg = err instanceof Error ? err.message : String(err)
      if (sanitized) {
        rawMsg = rawMsg.split(sanitized).join("[redacted]")
      }
      const safeMsg = redact(rawMsg)
      return {
        valid: false,
        error: `River could not be reached: ${safeMsg}`,
      }
    }
  }
}
