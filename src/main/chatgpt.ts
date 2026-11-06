import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { redact } from "./events/redact"

/*
  ChatGPT / Codex OAuth provider with token sharing (adr:0030, specs/chatgpt-auth R1.1–R5.2).
  Official documentation consulted (https://developers.openai.com/siwc/token-sharing-open-source
  on 2026-11-04):
  - Uses standard OAuth 2.0 Authorization Code flow with PKCE (RFC 7636, S256).
  - Dynamic client identity: `client_id=dynamic_agent_client`.
  - Persistent host identifier: `ext_agent_host_id`.
  - Loopback redirect: `http://127.0.0.1:<port>/callback`.
  - Scopes: `openid profile email chatgpt.tokens.use.direct resource.invoke`.
  - Protected storage in the OS keychain (DPAPI via safeStorage in desktop, OS keychain in TUI).
  - Independent provider identity, strictly separated from River AI and Hopper.
  - Explicit prohibition against reading or copying existing session files from `~/.codex`.
*/

export const CHATGPT_AUTH_ORIGIN = "https://auth.openai.com"
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_AUTH_ORIGIN}/authorize`
export const CHATGPT_TOKEN_URL = `${CHATGPT_AUTH_ORIGIN}/oauth/token`
export const CHATGPT_REVOKE_URL = `${CHATGPT_AUTH_ORIGIN}/oauth/revoke`
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_CLIENT_ID = "dynamic_agent_client"

export const REQUIRED_SCOPES = ["openid", "profile", "email", "chatgpt.tokens.use.direct", "resource.invoke"] as const

export interface ChatGPTSession {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt: number // epoch ms
  scopes: string[]
  hostId: string
  accountEmail?: string
  planType?: string
}

export interface ChatGPTAuthStatus {
  connected: boolean
  accountEmail?: string
  planType?: string
  expiresAt?: number
  hasTokenSharingScope: boolean
  error?: string
}

export interface PKCEPair {
  verifier: string
  challenge: string
  method: "S256"
}

export interface LoopbackHandle {
  server: Server
  port: number
  redirectUri: string
  close(): Promise<void>
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface ChatGPTAuthServiceDeps {
  fetch?: Fetch
  openUrl(url: string): Promise<boolean>
  saveSession(session: ChatGPTSession | null): Promise<void>
  loadSession(): Promise<ChatGPTSession | null>
  hostId?: string
}

/**
 * Generate an RFC 7636 compliant PKCE code verifier (43–128 characters).
 */
export function generateCodeVerifier(length = 64): string {
  const boundedLength = Math.max(43, Math.min(128, length))
  const bytes = randomBytes(Math.ceil((boundedLength * 3) / 4))
  return bytes.toString("base64url").slice(0, boundedLength)
}

/**
 * Generate an RFC 7636 compliant SHA-256 code challenge from a verifier.
 */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

/**
 * Generate a cryptographically random token for state and nonce.
 */
export function generateRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

/**
 * Builds the official OpenAI authorization URL for Sign in with ChatGPT and Token Sharing.
 */
export function buildAuthorizationUrl(params: {
  clientId?: string
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
  hostId: string
  scopes?: readonly string[]
  authorizeEndpoint?: string
}): string {
  const endpoint = params.authorizeEndpoint ?? CHATGPT_AUTHORIZE_URL
  const u = new URL(endpoint)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("client_id", params.clientId ?? DEFAULT_CLIENT_ID)
  u.searchParams.set("redirect_uri", params.redirectUri)
  u.searchParams.set("scope", (params.scopes ?? REQUIRED_SCOPES).join(" "))
  u.searchParams.set("state", params.state)
  u.searchParams.set("nonce", params.nonce)
  u.searchParams.set("code_challenge", params.codeChallenge)
  u.searchParams.set("code_challenge_method", "S256")
  u.searchParams.set("ext_agent_host_id", params.hostId)
  return u.toString()
}

/**
 * Starts an ephemeral loopback HTTP server on 127.0.0.1 to handle the OAuth redirect callback.
 */
export function startLoopbackServer(
  preferredPort = 0,
  onCallback: (params: { code?: string; state?: string; error?: string; errorDescription?: string }) => void,
): Promise<LoopbackHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", "http://127.0.0.1")
        if (u.pathname === "/callback") {
          const code = u.searchParams.get("code") ?? undefined
          const state = u.searchParams.get("state") ?? undefined
          const error = u.searchParams.get("error") ?? undefined
          const errorDescription = u.searchParams.get("error_description") ?? undefined

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          if (error) {
            res.end(
              `<!DOCTYPE html><html><body><h2>Authentication Cancelled</h2><p>${errorDescription ?? error}</p><p>You may close this window and return to Harness for REA.</p></body></html>`,
            )
          } else {
            res.end("<!DOCTYPE html><html><body><h2>Authentication Complete</h2><p>You may close this tab and return to Harness for REA.</p></body></html>")
          }

          onCallback({ code, state, error, errorDescription })
          return
        }

        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("Not Found")
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain" })
        res.end("Internal Server Error")
      }
    })

    server.once("error", reject)

    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        reject(new Error("Failed to bind loopback server address."))
        return
      }
      const port = addr.port
      const redirectUri = `http://127.0.0.1:${port}/callback`

      const close = () =>
        new Promise<void>((resClose) => {
          server.close(() => resClose())
        })

      resolve({ server, port, redirectUri, close })
    })
  })
}

export class ChatGPTAuthService {
  private readonly fetch: Fetch
  private readonly openUrl: (url: string) => Promise<boolean>
  private readonly saveSession: (session: ChatGPTSession | null) => Promise<void>
  private readonly loadSession: (session?: void) => Promise<ChatGPTSession | null>
  private readonly hostId: string
  private activeLoopback: LoopbackHandle | null = null
  private abortController: AbortController | null = null
  private currentSession: ChatGPTSession | null = null

  constructor(deps: ChatGPTAuthServiceDeps) {
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.openUrl = deps.openUrl
    this.saveSession = deps.saveSession
    this.loadSession = deps.loadSession
    this.hostId = deps.hostId ?? generateRandomToken(16)
  }

  getHostId(): string {
    return this.hostId
  }

  /**
   * Reports active authorization status.
   */
  async status(): Promise<ChatGPTAuthStatus> {
    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
    }
    if (!this.currentSession) {
      return { connected: false, hasTokenSharingScope: false }
    }

    const hasTokenSharing = this.currentSession.scopes.includes("chatgpt.tokens.use.direct")
    const expired = Date.now() >= this.currentSession.expiresAt

    return {
      connected: !expired,
      accountEmail: this.currentSession.accountEmail,
      planType: this.currentSession.planType,
      expiresAt: this.currentSession.expiresAt,
      hasTokenSharingScope: hasTokenSharing,
      error: expired ? "Session expired. Please reconnect your account." : undefined,
    }
  }

  /**
   * Starts the Sign in with ChatGPT authorization flow using RFC 7636 PKCE.
   */
  async startSignIn(options?: { preferredPort?: number; timeoutMs?: number }): Promise<ChatGPTSession> {
    this.cancelSignIn()

    const verifier = generateCodeVerifier(64)
    const challenge = generateCodeChallenge(verifier)
    const state = generateRandomToken(32)
    const nonce = generateRandomToken(32)
    const timeoutMs = options?.timeoutMs ?? 180_000

    this.abortController = new AbortController()
    const { signal } = this.abortController

    let loopbackHandle: LoopbackHandle | null = null

    try {
      let resolveCallback!: (params: { code?: string; state?: string; error?: string; errorDescription?: string }) => void
      let rejectCallback!: (err: Error) => void
      const callbackPromise = new Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }>((resolve, reject) => {
        resolveCallback = resolve
        rejectCallback = reject
      })

      const timeout = setTimeout(() => {
        rejectCallback(new Error("Authentication timed out waiting for browser callback."))
      }, timeoutMs)

      signal.addEventListener("abort", () => {
        clearTimeout(timeout)
        rejectCallback(new Error("Authentication cancelled by user."))
      })

      loopbackHandle = await startLoopbackServer(options?.preferredPort ?? 0, (params) => {
        clearTimeout(timeout)
        resolveCallback(params)
      })
      this.activeLoopback = loopbackHandle

      const authUrl = buildAuthorizationUrl({
        redirectUri: loopbackHandle.redirectUri,
        state,
        nonce,
        codeChallenge: challenge,
        hostId: this.hostId,
      })

      const opened = await this.openUrl(authUrl)
      if (!opened) {
        throw new Error("Could not open system browser for ChatGPT authorization.")
      }

      const callbackParams = await callbackPromise

      if (callbackParams.error) {
        if (callbackParams.error === "access_denied") {
          throw new Error("Consent denied by user. ChatGPT sign-in was cancelled.")
        }
        throw new Error(`OpenAI authorization error: ${callbackParams.errorDescription ?? callbackParams.error}`)
      }

      if (!callbackParams.code) {
        throw new Error("Authorization callback returned no authorization code.")
      }

      if (callbackParams.state !== state) {
        throw new Error("Invalid OAuth state parameter received in loopback callback.")
      }

      // Exchange authorization code for tokens
      const session = await this.exchangeCode({
        code: callbackParams.code,
        codeVerifier: verifier,
        redirectUri: handle.redirectUri,
      })

      this.currentSession = session
      await this.saveSession(session)
      return session
    } finally {
      if (loopbackHandle) {
        await (loopbackHandle as LoopbackHandle).close().catch(() => {})
      }
      this.activeLoopback = null
      this.abortController = null
    }
  }

  /**
   * Exchanges an authorization code and PKCE verifier for access & refresh tokens.
   */
  async exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<ChatGPTSession> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: DEFAULT_CLIENT_ID,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      ext_agent_host_id: this.hostId,
    })

    const res = await this.fetch(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })

    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      id_token?: string
      expires_in?: number
      scope?: string
      error?: string
      error_description?: string
    }

    if (!res.ok || !data.access_token) {
      const err = redact(data.error_description ?? data.error ?? `HTTP ${res.status}`)
      throw new Error(`Failed to exchange ChatGPT authorization code: ${err}`)
    }

    const scopes = (data.scope ?? "").split(" ").filter(Boolean)
    const hasTokenSharing = scopes.includes("chatgpt.tokens.use.direct")
    if (!hasTokenSharing) {
      throw new Error(
        "Your ChatGPT account does not have token sharing enabled. A ChatGPT Plus or Pro subscription with token sharing eligibility is required.",
      )
    }

    const expiresInMs = (data.expires_in ?? 3600) * 1000
    const expiresAt = Date.now() + expiresInMs

    // Extract basic profile metadata from id_token if available (without validating signature here)
    let accountEmail: string | undefined
    let planType: string | undefined
    if (data.id_token) {
      try {
        const payloadBase64 = data.id_token.split(".")[1]
        if (payloadBase64) {
          const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"))
          accountEmail = payload.email ?? undefined
          planType = payload["https://api.openai.com/plan"] ?? payload.plan ?? undefined
        }
      } catch {
        // ID token parsing is non-fatal
      }
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresAt,
      scopes,
      hostId: this.hostId,
      accountEmail,
      planType,
    }
  }

  /**
   * Refreshes the active access token using the stored refresh token.
   */
  async refreshSession(): Promise<ChatGPTSession> {
    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
    }
    if (!this.currentSession?.refreshToken) {
      throw new Error("No refresh token available. Re-authenticate with ChatGPT.")
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: DEFAULT_CLIENT_ID,
      refresh_token: this.currentSession.refreshToken,
      ext_agent_host_id: this.hostId,
    })

    const res = await this.fetch(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })

    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      error?: string
      error_description?: string
    }

    if (!res.ok || !data.access_token) {
      const err = redact(data.error_description ?? data.error ?? `HTTP ${res.status}`)
      throw new Error(`Failed to refresh ChatGPT token: ${err}`)
    }

    const expiresInMs = (data.expires_in ?? 3600) * 1000
    const scopes = data.scope ? data.scope.split(" ").filter(Boolean) : this.currentSession.scopes

    this.currentSession = {
      ...this.currentSession,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.currentSession.refreshToken,
      expiresAt: Date.now() + expiresInMs,
      scopes,
    }

    await this.saveSession(this.currentSession)
    return this.currentSession
  }

  /**
   * Obtains a valid access token, refreshing silently if expired or nearing expiry.
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
    }
    if (!this.currentSession) {
      throw new Error("No ChatGPT session found. Connect your account in Settings.")
    }

    // Refresh if expires within 60 seconds
    if (Date.now() >= this.currentSession.expiresAt - 60_000) {
      const refreshed = await this.refreshSession()
      return refreshed.accessToken
    }

    return this.currentSession.accessToken
  }

  /**
   * Revokes the active session and clears tokens from keychain and memory.
   */
  async signOut(): Promise<void> {
    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
    }
    if (this.currentSession?.accessToken) {
      try {
        const body = new URLSearchParams({
          token: this.currentSession.accessToken,
          client_id: DEFAULT_CLIENT_ID,
        })
        await this.fetch(CHATGPT_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        })
      } catch {
        // Non-fatal: revoke best-effort
      }
    }

    this.currentSession = null
    await this.saveSession(null)
  }

  /**
   * Aborts an in-flight authorization flow.
   */
  cancelSignIn(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.activeLoopback) {
      void this.activeLoopback.close().catch(() => {})
      this.activeLoopback = null
    }
  }

  /**
   * Verifies access to a model and proves inference capability with tools.
   * Catalogs alone do not prove plan access.
   */
  async validateModelInference(model = "gpt-4o"): Promise<{ valid: boolean; error?: string; status?: number }> {
    let token: string
    try {
      token = await this.getValidAccessToken()
    } catch (e) {
      return { valid: false, error: (e as Error).message }
    }

    try {
      const res = await this.fetch(`${OPENAI_API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
      })

      if (res.status === 401) {
        return { valid: false, status: 401, error: "ChatGPT session token rejected (401 Unauthorized)." }
      }
      if (res.status === 403) {
        return { valid: false, status: 403, error: "ChatGPT account plan lacks permission for model inference (403 Forbidden)." }
      }
      if (res.status === 404) {
        return { valid: false, status: 404, error: `Model '${model}' is not available on this ChatGPT account (404 Not Found).` }
      }
      if (res.status === 429) {
        return { valid: false, status: 429, error: "Rate limit reached on ChatGPT subscription plan (429 Too Many Requests)." }
      }
      if (!res.ok) {
        return { valid: false, status: res.status, error: `Inference failed with HTTP ${res.status}.` }
      }

      return { valid: true, status: res.status }
    } catch (e) {
      return { valid: false, error: redact((e as Error).message) }
    }
  }
}
