/*
  River AI authentication investigation (adr:0029, specs/river-auth R1.1–R2.3).
  River provides no public external OAuth/OIDC or device authorization flow; authentication
  is done via an API key created in the River Console (https://console.river.ai/keys).
  This module records the external blocker, validates River API keys, and prevents any
  insecure or unverified authentication attempts.
*/

export const RIVER_API_ORIGIN = "https://api.river.ai"
export const RIVER_API_BASE_URL = `${RIVER_API_ORIGIN}/v1`
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
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export class RiverAuthService {
  private readonly fetch: Fetch

  constructor(fetchImpl?: Fetch) {
    this.fetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  }

  /**
   * Reports the capability status for River account authentication (specs/river-auth R1.1, R1.2).
   * Verifies that browser OAuth/login is not supported officially by River AI.
   */
  capability(): RiverAuthStatus {
    return {
      hasOfficialBrowserLogin: false,
      supportedAuthMethod: "api_key",
      message:
        "River does not provide an external browser authorization or OAuth flow for third-party clients. Authenticate using an API key from the River Console.",
      consoleUrl: RIVER_CONSOLE_KEYS_URL,
      docsUrl: RIVER_DOCS_INFERENCE_URL,
    }
  }

  /**
   * Whether River provides an official browser login flow.
   * Always false based on official River documentation and API verification (adr:0029).
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
   * Validates a River key against River's /v1/models endpoint using Bearer auth (specs/river-auth R2.3).
   * Distinguishes 401 (invalid key), 403 (forbidden/unauthorized), 429 (rate limit/quota),
   * without leaking the key in errors or logs.
   */
  async validateKey(key: string, endpoint = `${RIVER_API_BASE_URL}/models`): Promise<RiverKeyValidation> {
    const sanitized = this.sanitizeKey(key)
    if (!sanitized) {
      return { valid: false, error: "River API key cannot be empty." }
    }

    try {
      const response = await this.fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${sanitized}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (response.ok) {
        return { valid: true, status: response.status }
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
      return {
        valid: false,
        error: `River could not be reached: ${(err as Error).message}`,
      }
    }
  }
}
