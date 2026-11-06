import { createHash, createPublicKey, createVerify, randomBytes, randomUUID, type KeyLike } from "node:crypto"
import { createServer, type Server } from "node:http"
import { redact, registerSecret } from "./events/redact"

/*
  ChatGPT / Codex OAuth provider with token sharing (adr:0030, specs/chatgpt-auth R1.1–R5.2).
  Official documentation consulted (https://developers.openai.com/siwc/token-sharing-open-source):
  - Endpoints:
      Authorize: https://auth.openai.com/api/accounts/authorize
      Token:     https://auth.openai.com/api/accounts/oauth/token
      Revoke:    https://auth.openai.com/api/accounts/oauth/revoke
      Responses: https://api.openai.com/v1/responses
  - Uses standard OAuth 2.0 Authorization Code flow with PKCE (RFC 7636, S256).
  - Dynamic client identity: `client_id=dynamic_agent_client` (and retains issued client_id).
  - Persistent host identifier: URN format `urn:uuid:<uuid>`.
  - Loopback redirect: `http://127.0.0.1:<port>/callback`.
  - Scopes: `openid profile email offline_access chatgpt.tokens.use.direct resource.invoke`.
  - Protected storage in the OS keychain (DPAPI via safeStorage in desktop, OS keychain in TUI).
  - Independent provider identity, strictly separated from River AI and Hopper.
  - Explicit prohibition against reading or copying existing session files from `~/.codex`.
*/

export const CHATGPT_AUTH_ORIGIN = "https://auth.openai.com"
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_AUTH_ORIGIN}/api/accounts/authorize`
export const CHATGPT_TOKEN_URL = `${CHATGPT_AUTH_ORIGIN}/api/accounts/oauth/token`
export const CHATGPT_REVOKE_URL = `${CHATGPT_AUTH_ORIGIN}/api/accounts/oauth/revoke`
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1"
export const OPENAI_RESPONSES_URL = `${OPENAI_API_BASE_URL}/responses`
export const DEFAULT_CLIENT_ID = "dynamic_agent_client"

export const REQUIRED_SCOPES = ["openid", "profile", "email", "offline_access", "chatgpt.tokens.use.direct", "resource.invoke"] as const

export interface ChatGPTSession {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt: number // epoch ms
  scopes: string[]
  hostId: string
  clientId: string
  accountEmail?: string
  planType?: string
  accountSub?: string
}

export interface ChatGPTAuthStatus {
  connected: boolean
  inProgress?: boolean
  accountEmail?: string
  planType?: string
  expiresAt?: number
  hasTokenSharingScope: boolean
  error?: string
  warning?: string
}

export interface SignOutResult {
  revokedRemotely: boolean
  warning?: string
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

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface ChatGPTAuthServiceDeps {
  fetch?: Fetch
  openUrl(url: string): Promise<boolean>
  saveSession(session: ChatGPTSession | null): Promise<void>
  loadSession(): Promise<ChatGPTSession | null>
  hostId?: string
  jwks?: { keys: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
  publicKey?: KeyLike | string
}

/**
 * Validates whether a host ID conforms to official URN format.
 */
export function isValidHostId(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith("urn:uuid:") && id.length >= 45
}

/**
 * Generates an official URN format host identifier.
 */
export function createHostId(): string {
  return `urn:uuid:${randomUUID()}`
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
  resource?: string
  agentNameHint?: string
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
  u.searchParams.set("resource", params.resource ?? OPENAI_API_BASE_URL)
  u.searchParams.set("agent_name_hint", params.agentNameHint ?? "Harness for REA")
  return u.toString()
}

export interface VerifyIdTokenOptions {
  idToken: string
  expectedNonce: string
  expectedAudience: string
  jwks?: { keys: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
  publicKey?: KeyLike | string
}

/**
 * Validates claims and cryptographic signature of an OpenID Connect ID token according to official guidelines.
 */
export function verifyIdToken(params: VerifyIdTokenOptions): { sub: string; email?: string; plan?: string } {
  const parts = params.idToken.split(".")
  if (parts.length !== 3) {
    throw new Error("Invalid ID token structure: token is not a valid 3-part JWT.")
  }

  const [headerB64, payloadB64, signatureB64] = parts

  let header: { alg?: string; kid?: string; typ?: string }
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid ID token header: failed to parse JSON header.")
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid ID token payload: failed to parse JSON claims.")
  }

  // Mandatory expiration check
  if (typeof payload.exp !== "number") {
    throw new Error("Invalid ID token: missing required 'exp' expiration claim.")
  }
  if (payload.exp * 1000 <= Date.now()) {
    throw new Error("Invalid ID token: token has expired.")
  }

  // Issuer check
  if (payload.iss !== CHATGPT_AUTH_ORIGIN && payload.iss !== "https://auth0.openai.com/") {
    throw new Error(`Invalid ID token issuer: expected ${CHATGPT_AUTH_ORIGIN}, got ${String(payload.iss)}.`)
  }

  // Nonce check
  if (payload.nonce !== params.expectedNonce) {
    throw new Error("Invalid ID token nonce: nonce mismatch detected.")
  }

  // Exact audience check (strictly reject dynamic_agent_client if issued client ID is expected)
  const aud = payload.aud
  const audMatches = Array.isArray(aud) ? aud.includes(params.expectedAudience) : aud === params.expectedAudience
  if (!audMatches) {
    throw new Error(`Invalid ID token audience: expected ${params.expectedAudience}, got ${String(aud)}.`)
  }

  // Subject check
  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new Error("Invalid ID token: missing required 'sub' subject claim.")
  }

  // Cryptographic signature check
  const signingInput = `${headerB64}.${payloadB64}`
  const sigBuffer = Buffer.from(signatureB64, "base64url")

  let verified = false
  if (params.publicKey) {
    try {
      const verifier = createVerify("RSA-SHA256")
      verifier.update(signingInput)
      verified = verifier.verify(params.publicKey, sigBuffer)
    } catch {
      verified = false
    }
  } else if (params.jwks) {
    const keys = Array.isArray(params.jwks) ? params.jwks : params.jwks.keys
    const matchingKey = keys.find((k) => !header.kid || k.kid === header.kid)
    if (!matchingKey) {
      throw new Error(`Invalid ID token: no matching key in JWKS for kid '${header.kid}'.`)
    }
    try {
      const keyObj = createPublicKey({ key: matchingKey as any, format: "jwk" })
      const verifier = createVerify("RSA-SHA256")
      verifier.update(signingInput)
      verified = verifier.verify(keyObj, sigBuffer)
    } catch {
      verified = false
    }
  } else {
    // If no keys provided for cryptographic validation, require signature validation failure
    throw new Error("Invalid ID token: cryptographic verification failed (missing public key or JWKS).")
  }

  if (!verified) {
    throw new Error("Invalid ID token signature: cryptographic verification failed.")
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    plan:
      typeof payload.plan === "string"
        ? payload.plan
        : typeof payload["https://api.openai.com/plan"] === "string"
          ? (payload["https://api.openai.com/plan"] as string)
          : undefined,
  }
}

/**
 * Starts an ephemeral loopback HTTP server on 127.0.0.1 to handle the OAuth redirect callback.
 * Strictly prevents XSS by avoiding reflection of query parameters in HTML responses.
 */
export function startLoopbackServer(
  preferredPort = 0,
  expectedState: string,
  onCallback: (params: { code?: string; state?: string; clientId?: string; error?: string; errorDescription?: string }) => void,
): Promise<LoopbackHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", "http://127.0.0.1")
        if (u.pathname === "/callback") {
          const code = u.searchParams.get("code") ?? undefined
          const state = u.searchParams.get("state") ?? undefined
          const clientId = u.searchParams.get("client_id") ?? undefined
          const error = u.searchParams.get("error") ?? undefined
          const errorDescription = u.searchParams.get("error_description") ?? undefined

          // Validate state before processing callback
          if (state !== expectedState) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
            res.end("Bad Request: OAuth state mismatch or invalid session.")
            return
          }

          // Static sanitized HTML responses without reflecting untrusted query parameters
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          if (error) {
            res.end(
              "<!DOCTYPE html><html><head><title>Authentication Cancelled</title></head><body><h2>Authentication Cancelled</h2><p>The sign-in request was cancelled or declined. You may close this tab and return to Harness for REA.</p></body></html>",
            )
          } else {
            res.end(
              "<!DOCTYPE html><html><head><title>Authentication Complete</title></head><body><h2>Authentication Complete</h2><p>Your ChatGPT account has been authorized. You may close this tab and return to Harness for REA.</p></body></html>",
            )
          }

          onCallback({ code, state, clientId, error, errorDescription })
          return
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("Not Found")
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
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
  private readonly loadSession: () => Promise<ChatGPTSession | null>
  private readonly hostId: string
  private readonly jwks?: { keys: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
  private readonly publicKey?: KeyLike | string
  private activeLoopback: LoopbackHandle | null = null
  private currentSession: ChatGPTSession | null = null
  private refreshGeneration = 0
  private signInGeneration = 0
  private currentAttempt: { generation: number; abortController: AbortController } | null = null
  private pendingRefresh: Promise<ChatGPTSession> | null = null
  private inProgress = false

  constructor(deps: ChatGPTAuthServiceDeps) {
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.openUrl = deps.openUrl
    this.saveSession = deps.saveSession
    this.loadSession = deps.loadSession
    this.hostId = isValidHostId(deps.hostId) ? deps.hostId! : createHostId()
    this.jwks = deps.jwks
    this.publicKey = deps.publicKey
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
      if (this.currentSession) {
        this.registerSessionSecrets(this.currentSession)
      }
    }
    if (!this.currentSession) {
      return { connected: false, inProgress: this.inProgress, hasTokenSharingScope: false }
    }

    const hasTokenSharing = this.currentSession.scopes.includes("chatgpt.tokens.use.direct")
    const expired = Date.now() >= this.currentSession.expiresAt

    return {
      connected: !expired,
      inProgress: this.inProgress,
      accountEmail: this.currentSession.accountEmail,
      planType: this.currentSession.planType,
      expiresAt: this.currentSession.expiresAt,
      hasTokenSharingScope: hasTokenSharing,
      error: expired ? "Session expired. Please reconnect your account." : undefined,
    }
  }

  /**
   * Registers OAuth secrets in the global redactor to ensure opaque tokens are masked.
   */
  private registerSessionSecrets(session: ChatGPTSession | null): void {
    if (!session) return
    if (session.accessToken) registerSecret(session.accessToken)
    if (session.refreshToken) registerSecret(session.refreshToken)
    if (session.idToken) registerSecret(session.idToken)
  }

  /**
   * Starts the Sign in with ChatGPT authorization flow using RFC 7636 PKCE.
   */
  async startSignIn(options?: { preferredPort?: number; timeoutMs?: number }): Promise<ChatGPTSession> {
    this.cancelSignIn()
    const attemptGen = ++this.signInGeneration
    const abortController = new AbortController()
    this.currentAttempt = { generation: attemptGen, abortController }
    this.inProgress = true

    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
      if (this.currentSession) {
        this.registerSessionSecrets(this.currentSession)
      }
    }

    const verifier = generateCodeVerifier(64)
    registerSecret(verifier)
    const challenge = generateCodeChallenge(verifier)
    const state = generateRandomToken(32)
    const nonce = generateRandomToken(32)
    const timeoutMs = options?.timeoutMs ?? 180_000

    const { signal } = abortController
    let loopbackHandle: LoopbackHandle | null = null
    let timeoutTimer: NodeJS.Timeout | null = null

    try {
      let resolveCallback!: (params: { code?: string; state?: string; clientId?: string; error?: string; errorDescription?: string }) => void
      let rejectCallback!: (err: Error) => void
      const callbackPromise = new Promise<{ code?: string; state?: string; clientId?: string; error?: string; errorDescription?: string }>((res, rej) => {
        resolveCallback = res
        rejectCallback = rej
      })
      callbackPromise.catch(() => {})

      timeoutTimer = setTimeout(() => {
        rejectCallback(new Error("Authentication timed out waiting for browser callback."))
      }, timeoutMs)

      signal.addEventListener("abort", () => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        rejectCallback(new Error("Authentication cancelled by user."))
      })

      loopbackHandle = await startLoopbackServer(options?.preferredPort ?? 0, state, (params) => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        resolveCallback(params)
      })
      this.activeLoopback = loopbackHandle

      const expectedClientId = this.currentSession?.clientId ?? DEFAULT_CLIENT_ID
      const authUrl = buildAuthorizationUrl({
        clientId: expectedClientId,
        redirectUri: loopbackHandle.redirectUri,
        state,
        nonce,
        codeChallenge: challenge,
        hostId: this.hostId,
      })

      const opened = await this.openUrl(authUrl)
      if (!opened) {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        throw new Error("Could not open system browser for ChatGPT authorization.")
      }

      const callbackParams = await callbackPromise

      if (callbackParams.error) {
        if (callbackParams.error === "access_denied") {
          throw new Error("Consent denied by user. ChatGPT sign-in was cancelled.")
        }
        const errDesc = redact(callbackParams.errorDescription ?? callbackParams.error)
        throw new Error(`OpenAI authorization error: ${errDesc}`)
      }

      if (!callbackParams.code) {
        throw new Error("Authorization callback returned no authorization code.")
      }

      // Check re-authorization client_id consistency
      if (this.currentSession?.clientId && callbackParams.clientId && callbackParams.clientId !== this.currentSession.clientId) {
        throw new Error(`Client ID mismatch during re-authorization: expected ${this.currentSession.clientId}, got ${callbackParams.clientId}.`)
      }

      // Exchange authorization code for tokens
      const session = await this.exchangeCode({
        code: callbackParams.code,
        codeVerifier: verifier,
        redirectUri: loopbackHandle.redirectUri,
        clientId: callbackParams.clientId ?? this.currentSession?.clientId ?? DEFAULT_CLIENT_ID,
        expectedNonce: nonce,
        signal,
      })

      // Strict check against cancel / logout race conditions
      if (attemptGen !== this.signInGeneration || this.currentAttempt === null) {
        throw new Error("Authentication cancelled.")
      }

      this.currentSession = session
      this.registerSessionSecrets(session)
      await this.saveSession(session)
      return session
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (loopbackHandle) {
        await loopbackHandle.close().catch(() => {})
      }
      if (this.currentAttempt?.generation === attemptGen) {
        this.currentAttempt = null
        this.inProgress = false
        this.activeLoopback = null
      }
    }
  }

  /**
   * Exchanges an authorization code and PKCE verifier for access & refresh tokens.
   */
  async exchangeCode(params: {
    code: string
    codeVerifier: string
    redirectUri: string
    clientId: string
    expectedNonce: string
    signal?: AbortSignal
  }): Promise<ChatGPTSession> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: params.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      ext_agent_host_id: this.hostId,
      resource: OPENAI_API_BASE_URL,
    })

    const res = await this.fetch(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: params.signal,
    })

    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      id_token?: string
      client_id?: string
      expires_in?: number
      scope?: string
      error?: string
      error_description?: string
    }

    if (!res.ok || !data.access_token) {
      const err = redact(data.error_description ?? data.error ?? `HTTP ${res.status}`)
      throw new Error(`Failed to exchange ChatGPT authorization code: ${err}`)
    }

    const issuedClientId = data.client_id ?? params.clientId

    // Validate ID token (mandatory per R3)
    if (!data.id_token) {
      throw new Error("Missing required OpenID Connect ID token in ChatGPT token response.")
    }

    const claims = verifyIdToken({
      idToken: data.id_token,
      expectedNonce: params.expectedNonce,
      expectedAudience: issuedClientId,
      jwks: this.jwks,
      publicKey: this.publicKey,
    })

    const scopes = (data.scope ?? "").split(" ").filter(Boolean)
    const hasTokenSharing = scopes.includes("chatgpt.tokens.use.direct")
    if (!hasTokenSharing) {
      throw new Error(
        "Your ChatGPT account does not have token sharing enabled. A ChatGPT Plus or Pro subscription with token sharing eligibility is required.",
      )
    }

    const expiresInMs = (data.expires_in ?? 3600) * 1000
    const expiresAt = Date.now() + expiresInMs

    const session: ChatGPTSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresAt,
      scopes,
      hostId: this.hostId,
      clientId: issuedClientId,
      accountEmail: claims.email,
      planType: claims.plan,
      accountSub: claims.sub,
    }

    this.registerSessionSecrets(session)
    return session
  }

  /**
   * Refreshes the active access token using the stored refresh token.
   * Employs generational coordination to prevent out-of-order race conditions with logout.
   */
  async refreshSession(): Promise<ChatGPTSession> {
    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
      if (this.currentSession) {
        this.registerSessionSecrets(this.currentSession)
      }
    }
    if (!this.currentSession?.refreshToken) {
      throw new Error("No refresh token available. Re-authenticate with ChatGPT.")
    }

    if (this.pendingRefresh) {
      return this.pendingRefresh
    }

    const current = this.currentSession
    const gen = ++this.refreshGeneration

    const refreshPromise = (async () => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: current.clientId,
        refresh_token: current.refreshToken!,
        ext_agent_host_id: this.hostId,
        resource: OPENAI_API_BASE_URL,
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
        throw new Error(`Failed to refresh ChatGPT token: ${err}`)
      }

      const expiresInMs = (data.expires_in ?? 3600) * 1000
      const scopes = data.scope ? data.scope.split(" ").filter(Boolean) : current.scopes

      const updated: ChatGPTSession = {
        ...current,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? current.refreshToken,
        idToken: data.id_token ?? current.idToken,
        expiresAt: Date.now() + expiresInMs,
        scopes,
      }

      this.registerSessionSecrets(updated)

      // Only save if generation matches and session was not signed out during in-flight request
      if (gen === this.refreshGeneration && this.currentSession !== null) {
        this.currentSession = updated
        await this.saveSession(updated)
      }

      return updated
    })().finally(() => {
      if (this.pendingRefresh === refreshPromise) {
        this.pendingRefresh = null
      }
    })

    this.pendingRefresh = refreshPromise
    return refreshPromise
  }

  /**
   * Obtains a valid access token, refreshing silently if expired or nearing expiry.
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
      if (this.currentSession) {
        this.registerSessionSecrets(this.currentSession)
      }
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
   * Advances both sign-in and refresh generations to prevent any in-flight requests from restoring the session.
   */
  async signOut(): Promise<SignOutResult> {
    this.signInGeneration++
    this.refreshGeneration++
    this.inProgress = false

    if (this.currentAttempt) {
      this.currentAttempt.abortController.abort()
      this.currentAttempt = null
    }
    this.pendingRefresh = null

    if (!this.currentSession) {
      this.currentSession = await this.loadSession()
    }
    const sessionToRevoke = this.currentSession
    this.currentSession = null
    await this.saveSession(null)

    if (!sessionToRevoke?.refreshToken && !sessionToRevoke?.accessToken) {
      return { revokedRemotely: true }
    }

    try {
      const token = sessionToRevoke.refreshToken ?? sessionToRevoke.accessToken
      const body = new URLSearchParams({
        token,
        token_type_hint: sessionToRevoke.refreshToken ? "refresh_token" : "access_token",
        client_id: sessionToRevoke.clientId,
      })
      const res = await this.fetch(CHATGPT_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
      if (!res.ok) {
        return {
          revokedRemotely: false,
          warning: `Local session cleared, but remote token revocation returned HTTP ${res.status}. You may revoke access in your OpenAI account security settings.`,
        }
      }
      return { revokedRemotely: true }
    } catch {
      return {
        revokedRemotely: false,
        warning:
          "Local session cleared, but a network error prevented remote token revocation. You may revoke access in your OpenAI account security settings.",
      }
    }
  }

  /**
   * Aborts an in-flight authorization flow.
   */
  cancelSignIn(): void {
    this.signInGeneration++
    this.inProgress = false
    if (this.currentAttempt) {
      this.currentAttempt.abortController.abort()
      this.currentAttempt = null
    }
    if (this.activeLoopback) {
      void this.activeLoopback.close().catch(() => {})
      this.activeLoopback = null
    }
  }

  /**
   * Verifies access to a model and proves inference capability with tools using Responses API.
   * Requires `store: false` and `stream: true` per official token sharing preview requirements.
   */
  async validateModelInference(
    model = "gpt-4o",
    tools?: { type: "function"; name: string; description: string; parameters: Record<string, unknown> }[],
    toolExecutor?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown,
  ): Promise<{ valid: boolean; error?: string; status?: number; toolCallsCount?: number }> {
    let token: string
    try {
      token = await this.getValidAccessToken()
    } catch (e) {
      return { valid: false, error: (e as Error).message }
    }

    try {
      const defaultTools = [
        {
          type: "function" as const,
          name: "ping",
          description: "A connectivity verification tool",
          parameters: { type: "object", properties: { message: { type: "string" } } },
        },
      ]

      const res = await this.fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
          store: false,
          stream: true,
          tools: tools ?? defaultTools,
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

      // Parse SSE stream ensuring response.completed is reached and error/failure events are rejected
      const streamText = await res.text().catch(() => "")
      if (!streamText.trim()) {
        return { valid: false, status: 200, error: "Inference response stream was empty." }
      }

      let completed = false
      let failed = false
      let failureError: string | undefined
      let toolCallsCount = 0

      for (const line of streamText.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith("data:")) {
          const payloadStr = trimmed.slice(5).trim()
          if (!payloadStr || payloadStr === "[DONE]") {
            continue
          }
          try {
            const parsed = JSON.parse(payloadStr) as {
              type?: string
              event?: string
              tool_calls?: unknown[]
              error?: { message?: string }
              response?: { status?: string; error?: { message?: string } }
            }
            const eventType = parsed.type ?? parsed.event
            if (eventType === "response.completed") {
              completed = true
            } else if (eventType === "response.failed" || eventType === "error") {
              failed = true
              failureError = parsed.response?.error?.message ?? parsed.error?.message ?? "Inference response failed."
            } else if (eventType === "response.incomplete") {
              failed = true
              failureError = "Inference response incomplete."
            }

            if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
              toolCallsCount += parsed.tool_calls.length
              if (toolExecutor) {
                for (const tc of parsed.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>) {
                  if (tc.function?.name) {
                    let args = {}
                    try {
                      args = JSON.parse(tc.function.arguments ?? "{}")
                    } catch {}
                    await toolExecutor(tc.function.name, args)
                  }
                }
              }
            }
          } catch {
            // Ignore non-json lines
          }
        }
      }

      if (failed) {
        return { valid: false, status: res.status, error: failureError ?? "Inference response failed." }
      }

      if (!completed) {
        return { valid: false, status: res.status, error: "Stream closed before response.completed was received." }
      }

      return { valid: true, status: res.status, toolCallsCount }
    } catch (e) {
      return { valid: false, error: redact((e as Error).message) }
    }
  }
}

/**
 * Resolves a valid ChatGPT access token from an opaque key, session JSON, or auth service.
 * Refreshes token silently if expired.
 */
export async function resolveChatGPTAccessToken(rawKeyOrSession: string | null | undefined, authService?: ChatGPTAuthService): Promise<string> {
  if (authService) {
    return authService.getValidAccessToken()
  }
  if (!rawKeyOrSession) {
    throw new Error("No ChatGPT session found.")
  }
  if (!rawKeyOrSession.startsWith("{")) {
    return rawKeyOrSession
  }
  try {
    const session = JSON.parse(rawKeyOrSession) as ChatGPTSession
    if (session.expiresAt && Date.now() < session.expiresAt - 60_000 && session.accessToken) {
      return session.accessToken
    }
    if (session.refreshToken) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: session.clientId,
        refresh_token: session.refreshToken,
        ext_agent_host_id: session.hostId,
        resource: OPENAI_API_BASE_URL,
      })
      const res = await fetch(CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
      if (res.ok) {
        const data = (await res.json()) as { access_token?: string }
        if (data.access_token) return data.access_token
      }
    }
    return session.accessToken ?? rawKeyOrSession
  } catch {
    return rawKeyOrSession
  }
}
