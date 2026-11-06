import { describe, expect, it } from "vitest"
import { generateKeyPairSync, createSign } from "node:crypto"
import {
  buildAuthorizationUrl,
  ChatGPTAuthService,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_REVOKE_URL,
  CHATGPT_TOKEN_URL,
  DEFAULT_CLIENT_ID,
  generateCodeChallenge,
  generateCodeVerifier,
  generateRandomToken,
  isValidHostId,
  createHostId,
  OPENAI_API_BASE_URL,
  OPENAI_RESPONSES_URL,
  REQUIRED_SCOPES,
  startLoopbackServer,
  verifyIdToken,
  type ChatGPTSession,
} from "../src/main/chatgpt"
import { PROVIDERS, resolveBaseUrl } from "../src/shared/providers"
import { redact } from "../src/main/events/redact"
import { makeModel } from "../src/main/orchestrator/model"
import { listModels, probeModel } from "../src/main/orchestrator/models"

describe("ChatGPT / Codex OAuth provider with token sharing (ADR 0030, Issue #2)", () => {
  it("registers chatgpt as an independent provider preset in PROVIDERS", () => {
    expect(PROVIDERS.chatgpt).toBeDefined()
    expect(PROVIDERS.chatgpt.id).toBe("chatgpt")
    expect(PROVIDERS.chatgpt.kind).toBe("openai")
    expect(PROVIDERS.chatgpt.baseUrl).toBe("https://api.openai.com/v1")
    expect(PROVIDERS.chatgpt.defaultModel).toBe("gpt-4o")
    expect(PROVIDERS.chatgpt.models).toContain("gpt-4o")
    expect(PROVIDERS.chatgpt.models).toContain("o1")
    expect(resolveBaseUrl("chatgpt", "")).toBe("https://api.openai.com/v1")
  })

  describe("PKCE and token utilities (R1.1, R1.2)", () => {
    it("generates an RFC 7636 compliant code verifier between 43 and 128 chars", () => {
      const verifier = generateCodeVerifier(64)
      expect(verifier.length).toBe(64)
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)

      const minVerifier = generateCodeVerifier(10)
      expect(minVerifier.length).toBe(43)

      const maxVerifier = generateCodeVerifier(200)
      expect(maxVerifier.length).toBe(128)
    })

    it("generates an RFC 7636 S256 code challenge from a verifier", () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
      const challenge = generateCodeChallenge(verifier)
      expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    })

    it("generates high-entropy random tokens for state and nonce", () => {
      const t1 = generateRandomToken(32)
      const t2 = generateRandomToken(32)
      expect(t1).not.toBe(t2)
      expect(t1.length).toBeGreaterThanOrEqual(32)
    })
  })

  describe("Host ID format and validation (R2)", () => {
    it("generates valid URN UUID host identifiers and validates format", () => {
      const hostId = createHostId()
      expect(hostId).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(isValidHostId(hostId)).toBe(true)
      expect(isValidHostId("invalid_random_token_123")).toBe(false)
      expect(isValidHostId("")).toBe(false)
      expect(isValidHostId(null)).toBe(false)
    })

    it("upgrades non-URN hostId to valid urn:uuid in ChatGPTAuthService constructor", () => {
      const service = new ChatGPTAuthService({
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => null,
        hostId: "old_random_token_base64",
      })
      expect(service.getHostId()).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    })
  })

  describe("Authorization URL and endpoints (R1.3, R1.5, Official Specs)", () => {
    it("constructs official authorization URL targeting /api/accounts/authorize with required scopes, resource, and agent hint", () => {
      const url = buildAuthorizationUrl({
        redirectUri: "http://127.0.0.1:54321/callback",
        state: "state-xyz",
        nonce: "nonce-123",
        codeChallenge: "challenge-abc",
        hostId: "urn:uuid:12345678-1234-1234-1234-123456789abc",
      })

      const u = new URL(url)
      expect(u.origin).toBe("https://auth.openai.com")
      expect(u.pathname).toBe("/api/accounts/authorize")
      expect(u.searchParams.get("response_type")).toBe("code")
      expect(u.searchParams.get("client_id")).toBe(DEFAULT_CLIENT_ID)
      expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback")
      expect(u.searchParams.get("state")).toBe("state-xyz")
      expect(u.searchParams.get("nonce")).toBe("nonce-123")
      expect(u.searchParams.get("code_challenge")).toBe("challenge-abc")
      expect(u.searchParams.get("code_challenge_method")).toBe("S256")
      expect(u.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:12345678-1234-1234-1234-123456789abc")
      expect(u.searchParams.get("resource")).toBe(OPENAI_API_BASE_URL)
      expect(u.searchParams.get("agent_name_hint")).toBe("Harness for REA")

      const scopes = u.searchParams.get("scope")?.split(" ")
      for (const req of REQUIRED_SCOPES) {
        expect(scopes).toContain(req)
      }
      expect(scopes).toContain("offline_access")
      expect(scopes).toContain("chatgpt.tokens.use.direct")
      expect(scopes).toContain("resource.invoke")
    })

    it("points token and revocation endpoints to /api/accounts/oauth/token and /api/accounts/oauth/revoke", () => {
      expect(CHATGPT_AUTHORIZE_URL).toBe("https://auth.openai.com/api/accounts/authorize")
      expect(CHATGPT_TOKEN_URL).toBe("https://auth.openai.com/api/accounts/oauth/token")
      expect(CHATGPT_REVOKE_URL).toBe("https://auth.openai.com/api/accounts/oauth/revoke")
      expect(OPENAI_RESPONSES_URL).toBe("https://api.openai.com/v1/responses")
    })
  })

  describe("ID Token Cryptographic Validation (R3)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwk = publicKey.export({ format: "jwk" })
    jwk.kid = "test-key-1"

    const makeSignedJwt = (payload: Record<string, unknown>, keyToSign = privateKey, kid = "test-key-1") => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url")
      const claims = Buffer.from(JSON.stringify(payload)).toString("base64url")
      const input = `${header}.${claims}`
      const sign = createSign("RSA-SHA256")
      sign.update(input)
      const sig = sign.sign(keyToSign, "base64url")
      return `${input}.${sig}`
    }

    it("validates authentic ID token with cryptographic RSA-SHA256 signature and JWKS", () => {
      const validJwt = makeSignedJwt({
        iss: "https://auth.openai.com",
        aud: "issued-client-id-888",
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: "expected-nonce-999",
        sub: "user-sub-12345",
        email: "verified@example.com",
        plan: "plus",
      })

      const res = verifyIdToken({
        idToken: validJwt,
        expectedNonce: "expected-nonce-999",
        expectedAudience: "issued-client-id-888",
        jwks: { keys: [jwk as Record<string, unknown>] },
      })

      expect(res.sub).toBe("user-sub-12345")
      expect(res.email).toBe("verified@example.com")
      expect(res.plan).toBe("plus")
    })

    it("rejects ID token with tampered or forged cryptographic signature", () => {
      const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      const forgedJwt = makeSignedJwt(
        {
          iss: "https://auth.openai.com",
          aud: "issued-client-id-888",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: "expected-nonce-999",
          sub: "user-sub-12345",
        },
        otherKey,
      )

      expect(() =>
        verifyIdToken({
          idToken: forgedJwt,
          expectedNonce: "expected-nonce-999",
          expectedAudience: "issued-client-id-888",
          jwks: { keys: [jwk as Record<string, unknown>] },
        }),
      ).toThrow(/signature: cryptographic verification failed/i)
    })

    it("rejects ID token with missing or expired exp claim", () => {
      const noExpJwt = makeSignedJwt({
        iss: "https://auth.openai.com",
        aud: "client-id",
        nonce: "nonce",
        sub: "sub",
      })
      expect(() =>
        verifyIdToken({
          idToken: noExpJwt,
          expectedNonce: "nonce",
          expectedAudience: "client-id",
          jwks: { keys: [jwk as Record<string, unknown>] },
        }),
      ).toThrow(/missing required 'exp'/i)

      const expiredJwt = makeSignedJwt({
        iss: "https://auth.openai.com",
        aud: "client-id",
        exp: Math.floor(Date.now() / 1000) - 100,
        nonce: "nonce",
        sub: "sub",
      })
      expect(() =>
        verifyIdToken({
          idToken: expiredJwt,
          expectedNonce: "nonce",
          expectedAudience: "client-id",
          jwks: { keys: [jwk as Record<string, unknown>] },
        }),
      ).toThrow(/expired/i)
    })

    it("rejects ID token with dynamic_agent_client audience when expected is an issued client ID", () => {
      const jwt = makeSignedJwt({
        iss: "https://auth.openai.com",
        aud: "dynamic_agent_client",
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: "nonce",
        sub: "sub",
      })
      expect(() =>
        verifyIdToken({
          idToken: jwt,
          expectedNonce: "nonce",
          expectedAudience: "issued-client-id-888",
          jwks: { keys: [jwk as Record<string, unknown>] },
        }),
      ).toThrow(/Invalid ID token audience/i)
    })
  })

  describe("Loopback callback server and XSS prevention (P1 #1, P2 #9)", () => {
    it("starts loopback server, validates matching state, and serves sanitized static HTML", async () => {
      let receivedParams: { code?: string; state?: string } = {}
      const loopback = await startLoopbackServer(0, "expected-state-xyz", (params) => {
        receivedParams = params
      })

      expect(loopback.port).toBeGreaterThan(0)
      expect(loopback.redirectUri).toBe(`http://127.0.0.1:${loopback.port}/callback`)

      const res = await fetch(`${loopback.redirectUri}?code=mock_code_123&state=expected-state-xyz`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain("Authentication Complete")
      expect(receivedParams.code).toBe("mock_code_123")
      expect(receivedParams.state).toBe("expected-state-xyz")

      await loopback.close()
    })

    it("rejects callbacks with mismatched state without executing callback", async () => {
      let executed = false
      const loopback = await startLoopbackServer(0, "legitimate-state-abc", () => {
        executed = true
      })

      const res = await fetch(`${loopback.redirectUri}?code=malicious_code&state=wrong-state-mismatch`)
      expect(res.status).toBe(400)
      const text = await res.text()
      expect(text).toContain("state mismatch")
      expect(executed).toBe(false)

      await loopback.close()
    })

    it("serves static HTML on error without reflecting untrusted query markup into response", async () => {
      const loopback = await startLoopbackServer(0, "state-valid", () => {})

      const res = await fetch(
        `${loopback.redirectUri}?error=access_denied&error_description=%3Cb+id%3D%22review-marker%22%3Euntrusted%3C%2Fb%3E&state=state-valid`,
      )
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).not.toContain('<b id="review-marker">untrusted</b>')
      expect(html).toContain("Authentication Cancelled")

      await loopback.close()
    })
  })

  describe("ChatGPTAuthService flow and lifecycle (R3, R5, R6, R8, R9)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwk = publicKey.export({ format: "jwk" })
    jwk.kid = "test-key-1"

    const makeSignedJwt = (payload: Record<string, unknown>) => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key-1" })).toString("base64url")
      const claims = Buffer.from(JSON.stringify(payload)).toString("base64url")
      const input = `${header}.${claims}`
      const sign = createSign("RSA-SHA256")
      sign.update(input)
      const sig = sign.sign(privateKey, "base64url")
      return `${input}.${sig}`
    }

    it("executes complete sign-in flow, verifies real RSA ID token, and registers secrets in redactor", async () => {
      let savedSession: ChatGPTSession | null = null
      let openedUrl = ""

      const fakeFetch: typeof fetch = async (url, init) => {
        const u = String(url)
        if (u.includes("/api/accounts/oauth/token")) {
          const body = new URLSearchParams(String(init?.body))
          expect(body.get("grant_type")).toBe("authorization_code")
          expect(body.get("client_id")).toBe("issued-client-id-888")
          expect(body.get("code_verifier")).toBeDefined()
          expect(body.get("resource")).toBe(OPENAI_API_BASE_URL)

          const nonce = new URL(openedUrl).searchParams.get("nonce")!
          const idToken = makeSignedJwt({
            iss: "https://auth.openai.com",
            aud: "issued-client-id-888",
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce,
            sub: "user-sub-888",
            email: "developer@example.com",
            plan: "pro",
          })

          return new Response(
            JSON.stringify({
              access_token: "opaque-access-token-998877",
              refresh_token: "opaque-refresh-token-445566",
              client_id: "issued-client-id-888",
              expires_in: 3600,
              scope: "openid profile email offline_access chatgpt.tokens.use.direct resource.invoke",
              id_token: idToken,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response("Not found", { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async (url) => {
          openedUrl = url
          const u = new URL(url)
          const redirect = u.searchParams.get("redirect_uri")!
          const state = u.searchParams.get("state")!
          setTimeout(async () => {
            await fetch(`${redirect}?code=auth_code_ok&state=${state}&client_id=issued-client-id-888`)
          }, 10)
          return true
        },
        saveSession: async (session) => {
          savedSession = session
        },
        loadSession: async () => savedSession,
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
        jwks: { keys: [jwk as Record<string, unknown>] },
      })

      const session = await service.startSignIn({ timeoutMs: 5000 })

      expect(session.accessToken).toBe("opaque-access-token-998877")
      expect(session.refreshToken).toBe("opaque-refresh-token-445566")
      expect(session.clientId).toBe("issued-client-id-888")
      expect(session.accountEmail).toBe("developer@example.com")
      expect(session.planType).toBe("pro")

      // Verify secrets were registered in the redactor
      expect(redact("Error with opaque-access-token-998877 leaked")).toBe("Error with [redacted] leaked")
      expect(redact("Error with opaque-refresh-token-445566 leaked")).toBe("Error with [redacted] leaked")
    })

    it("prevents late code exchange from restoring session if cancelled or signed out in-flight (R5)", async () => {
      let savedSession: ChatGPTSession | null = null
      let resolveExchange!: (res: Response) => void
      const exchangePromise = new Promise<Response>((r) => {
        resolveExchange = r
      })

      const fakeFetch: typeof fetch = async (url) => {
        if (String(url).includes("/api/accounts/oauth/token")) {
          return exchangePromise
        }
        return new Response("Not found", { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async (url) => {
          const u = new URL(url)
          const redirect = u.searchParams.get("redirect_uri")!
          const state = u.searchParams.get("state")!
          setTimeout(async () => {
            await fetch(`${redirect}?code=auth_code_delay&state=${state}&client_id=issued-client-123`)
          }, 10)
          return true
        },
        saveSession: async (session) => {
          savedSession = session
        },
        loadSession: async () => savedSession,
        jwks: { keys: [jwk as Record<string, unknown>] },
      })

      // 1. Start sign in
      const signInPromise = service.startSignIn()

      // Wait a moment for loopback callback to arrive and trigger code exchange
      await new Promise((r) => setTimeout(r, 50))

      // 2. User cancels sign in while exchange is in flight
      service.cancelSignIn()

      // 3. Delayed token exchange finishes
      const idToken = makeSignedJwt({
        iss: "https://auth.openai.com",
        aud: "issued-client-123",
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: "test-nonce",
        sub: "user-sub-123",
      })

      resolveExchange(
        new Response(
          JSON.stringify({
            access_token: "resurrected-exchange-token",
            refresh_token: "resurrected-refresh-token",
            client_id: "issued-client-123",
            expires_in: 3600,
            scope: "openid offline_access chatgpt.tokens.use.direct",
            id_token: idToken,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )

      await expect(signInPromise).rejects.toThrow()
      expect(savedSession).toBeNull()
      const st = await service.status()
      expect(st.connected).toBe(false)
    })

    it("rejects client_id mismatch during re-authorization (R6)", async () => {
      const existingSession: ChatGPTSession = {
        accessToken: "tok",
        clientId: "original-client-id",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      }

      const service = new ChatGPTAuthService({
        openUrl: async (url) => {
          const u = new URL(url)
          const redirect = u.searchParams.get("redirect_uri")!
          const state = u.searchParams.get("state")!
          // Callback returns a different client_id
          setTimeout(async () => {
            await fetch(`${redirect}?code=auth_code_ok&state=${state}&client_id=different-client-id`)
          }, 10)
          return true
        },
        saveSession: async () => {},
        loadSession: async () => existingSession,
      })

      await expect(service.startSignIn()).rejects.toThrow(/Client ID mismatch during re-authorization/)
    })

    it("sends resource parameter during refreshSession (R6)", async () => {
      let capturedBody = ""
      const currentSession: ChatGPTSession = {
        accessToken: "tok",
        refreshToken: "ref",
        clientId: "client-abc",
        expiresAt: Date.now() - 1000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      }

      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url).includes("/api/accounts/oauth/token")) {
          capturedBody = String(init?.body)
          return new Response(
            JSON.stringify({
              access_token: "new-access-token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response("Not found", { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => currentSession,
      })

      await service.refreshSession()
      const params = new URLSearchParams(capturedBody)
      expect(params.get("grant_type")).toBe("refresh_token")
      expect(params.get("resource")).toBe(OPENAI_API_BASE_URL)
    })

    it("reports revocation warning if remote endpoint returns error (R9)", async () => {
      const currentSession: ChatGPTSession = {
        accessToken: "tok",
        refreshToken: "ref",
        clientId: "client-abc",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      }

      const fakeFetch: typeof fetch = async (url) => {
        if (String(url).includes("/api/accounts/oauth/revoke")) {
          return new Response("Server error", { status: 500 })
        }
        return new Response("Not found", { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => currentSession,
      })

      const res = await service.signOut()
      expect(res.revokedRemotely).toBe(false)
      expect(res.warning).toContain("HTTP 500")
      expect(res.warning).toContain("OpenAI account security settings")
    })
  })

  describe("Inference helper and stream validation (R4)", () => {
    it("rejects empty response streams", async () => {
      const activeSession: ChatGPTSession = {
        accessToken: "valid-token",
        clientId: "client-id",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      }

      const fakeFetch: typeof fetch = async () => new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } })

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => activeSession,
      })

      const res = await service.validateModelInference("gpt-4o")
      expect(res.valid).toBe(false)
      expect(res.error).toContain("empty")
    })

    it("rejects streams ending without response.completed", async () => {
      const activeSession: ChatGPTSession = {
        accessToken: "valid-token",
        clientId: "client-id",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      }

      const ssePayload = 'data: {"type": "response.created", "id": "resp_123"}\n\n'
      const fakeFetch: typeof fetch = async () => new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream" } })

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => activeSession,
      })

      const res = await service.validateModelInference("gpt-4o")
      expect(res.valid).toBe(false)
      expect(res.error).toContain("response.completed")
    })

    it("rejects streams with response.failed events", async () => {
      const activeSession: ChatGPTSession = {
        accessToken: "valid-token",
        clientId: "client-id",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      }

      const ssePayload = [
        'data: {"type": "response.created", "id": "resp_123"}',
        'data: {"type": "response.failed", "response": {"error": {"message": "Plan quota exceeded"}}}',
      ].join("\n\n")

      const fakeFetch: typeof fetch = async () => new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream" } })

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => activeSession,
      })

      const res = await service.validateModelInference("gpt-4o")
      expect(res.valid).toBe(false)
      expect(res.error).toContain("Plan quota exceeded")
    })

    it("verifies tool execution and successful completion", async () => {
      const activeSession: ChatGPTSession = {
        accessToken: "valid-token",
        clientId: "client-id",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      }

      const ssePayload = [
        'data: {"type": "response.created", "id": "resp_123"}',
        'data: {"type": "response.output_item.added", "item": {"type": "function_call", "name": "ping", "arguments": "{\\"msg\\":\\"hi\\"}"}}',
        'data: {"type": "response.completed", "tool_calls": [{"id": "c1", "function": {"name": "ping", "arguments": "{\\"msg\\":\\"hi\\"}"}}]}',
      ].join("\n\n")

      const fakeFetch: typeof fetch = async () => new Response(ssePayload, { status: 200, headers: { "Content-Type": "text/event-stream" } })

      let executedToolName = ""
      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => activeSession,
      })

      const res = await service.validateModelInference("gpt-4o", undefined, (name) => {
        executedToolName = name
      })
      expect(res.valid).toBe(true)
      expect(executedToolName).toBe("ping")
      expect(res.toolCallsCount).toBe(1)
    })
  })

  describe("Responses API Transport and Model Integration (R1, R7)", () => {
    it("makeModel routes chatgpt to Responses API with store: false, stream: true and Bearer token", async () => {
      const sessionJson = JSON.stringify({
        accessToken: "clean-access-token-999",
        refreshToken: "secret-refresh-should-not-leak",
        clientId: "client-123",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      })

      let calledUrl = ""
      let authHeader = ""
      let requestBody: any = {}

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        calledUrl = String(url)
        authHeader = new Headers(init?.headers).get("Authorization") ?? ""
        requestBody = JSON.parse(String(init?.body ?? "{}"))

        const sse = [
          'data: {"type": "response.text.delta", "delta": "Hello from responses"}',
          'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 5}}}',
        ].join("\n\n")

        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }

      try {
        const model = makeModel({
          provider: "chatgpt",
          apiKey: sessionJson,
          model: "gpt-4o",
          onUsage: () => {},
        })

        const res = await model.invoke("ping")
        expect(res.content).toBe("Hello from responses")
        expect(calledUrl).toBe(OPENAI_RESPONSES_URL)
        expect(authHeader).toBe("Bearer clean-access-token-999")
        expect(authHeader).not.toContain("secret-refresh-should-not-leak")
        expect(authHeader).not.toContain("{")
        expect(requestBody.store).toBe(false)
        expect(requestBody.stream).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("probeModel routes chatgpt to Responses API with store: false, stream: true and valid Bearer token", async () => {
      const sessionJson = JSON.stringify({
        accessToken: "clean-probe-token",
        refreshToken: "refresh-secret",
        clientId: "client-123",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      })

      let calledUrl = ""
      let authHeader = ""
      let requestBody: any = {}

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        calledUrl = String(url)
        authHeader = new Headers(init?.headers).get("Authorization") ?? ""
        requestBody = JSON.parse(String(init?.body ?? "{}"))

        const sse = 'data: {"type": "response.completed"}\n\n'
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }

      try {
        await probeModel({
          provider: "chatgpt",
          baseUrl: "",
          apiKey: sessionJson,
          model: "gpt-4o",
        })

        expect(calledUrl).toBe(OPENAI_RESPONSES_URL)
        expect(authHeader).toBe("Bearer clean-probe-token")
        expect(authHeader).not.toContain("refresh-secret")
        expect(requestBody.store).toBe(false)
        expect(requestBody.stream).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("listModels parses ChatGPT models[].slug and filters visibility: list", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              models: [
                { slug: "gpt-4o", display_name: "GPT-4o", visibility: "list" },
                { slug: "o1", display_name: "OpenAI o1", visibility: "list" },
                { slug: "internal-hidden", display_name: "Internal", visibility: "private" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response("Not found", { status: 404 })
      }

      try {
        const models = await listModels({
          provider: "chatgpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "tok",
        })
        expect(models).toEqual(["gpt-4o", "o1"])
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
