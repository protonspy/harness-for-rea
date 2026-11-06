import { describe, expect, it } from "vitest"
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
  OPENAI_API_BASE_URL,
  OPENAI_RESPONSES_URL,
  REQUIRED_SCOPES,
  startLoopbackServer,
  verifyIdToken,
  type ChatGPTSession,
} from "../src/main/chatgpt"
import { PROVIDERS, resolveBaseUrl } from "../src/shared/providers"
import { redact } from "../src/main/events/redact"

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

  describe("Authorization URL and endpoints (R1.3, R1.5, Official Specs)", () => {
    it("constructs official authorization URL targeting /api/accounts/authorize with required scopes, resource, and agent hint", () => {
      const url = buildAuthorizationUrl({
        redirectUri: "http://127.0.0.1:54321/callback",
        state: "state-xyz",
        nonce: "nonce-123",
        codeChallenge: "challenge-abc",
        hostId: "host-uuid-456",
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
      expect(u.searchParams.get("ext_agent_host_id")).toBe("host-uuid-456")
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

  describe("ID Token Validation (P2 #5)", () => {
    const makeJwt = (payload: Record<string, unknown>) => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
      const claims = Buffer.from(JSON.stringify(payload)).toString("base64url")
      return `${header}.${claims}.mock_signature`
    }

    it("validates authentic ID token matching issuer, audience, nonce, and expiration", () => {
      const validJwt = makeJwt({
        iss: "https://auth.openai.com",
        aud: DEFAULT_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: "expected-nonce-999",
        sub: "user-sub-12345",
        email: "verified@example.com",
        plan: "plus",
      })

      const res = verifyIdToken({
        idToken: validJwt,
        expectedNonce: "expected-nonce-999",
        expectedAudience: DEFAULT_CLIENT_ID,
      })

      expect(res.sub).toBe("user-sub-12345")
      expect(res.email).toBe("verified@example.com")
      expect(res.plan).toBe("plus")
    })

    it("rejects ID token with mismatched nonce", () => {
      const tamperedJwt = makeJwt({
        iss: "https://auth.openai.com",
        aud: DEFAULT_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: "tampered-nonce",
        sub: "user-sub-12345",
      })

      expect(() =>
        verifyIdToken({
          idToken: tamperedJwt,
          expectedNonce: "expected-nonce-999",
          expectedAudience: DEFAULT_CLIENT_ID,
        }),
      ).toThrow(/nonce mismatch/i)
    })

    it("rejects ID token with invalid issuer", () => {
      const untrustedJwt = makeJwt({
        iss: "https://untrusted-auth.attacker.com",
        aud: DEFAULT_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: "expected-nonce",
        sub: "user-sub-12345",
      })

      expect(() =>
        verifyIdToken({
          idToken: untrustedJwt,
          expectedNonce: "expected-nonce",
          expectedAudience: DEFAULT_CLIENT_ID,
        }),
      ).toThrow(/invalid ID token issuer/i)
    })

    it("rejects expired ID token", () => {
      const expiredJwt = makeJwt({
        iss: "https://auth.openai.com",
        aud: DEFAULT_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) - 100, // expired
        nonce: "expected-nonce",
        sub: "user-sub-12345",
      })

      expect(() =>
        verifyIdToken({
          idToken: expiredJwt,
          expectedNonce: "expected-nonce",
          expectedAudience: DEFAULT_CLIENT_ID,
        }),
      ).toThrow(/expired/i)
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

  describe("ChatGPTAuthService flow and lifecycle (P1, P2)", () => {
    it("executes complete sign-in flow, captures issued client_id, and registers secrets in redactor", async () => {
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
          const idToken = `header.${Buffer.from(
            JSON.stringify({
              iss: "https://auth.openai.com",
              aud: "issued-client-id-888",
              exp: Math.floor(Date.now() / 1000) + 3600,
              nonce,
              sub: "user-sub-888",
              email: "developer@example.com",
              plan: "pro",
            }),
          ).toString("base64url")}.sig`

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
          // Simulate callback with issued client_id query parameter
          setTimeout(async () => {
            await fetch(`${redirect}?code=auth_code_ok&state=${state}&client_id=issued-client-id-888`)
          }, 10)
          return true
        },
        saveSession: async (session) => {
          savedSession = session
        },
        loadSession: async () => savedSession,
        hostId: "stable-machine-id",
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

    it("prevents late refresh from restoring session after logout (Generational Coordination P2 #7)", async () => {
      let savedSession: ChatGPTSession | null = {
        accessToken: "initial-token",
        refreshToken: "refresh-token",
        clientId: "client-123",
        expiresAt: Date.now() - 1000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "host-1",
      }

      let resolveTokenPromise!: (val: Response) => void
      const slowTokenPromise = new Promise<Response>((r) => {
        resolveTokenPromise = r
      })

      const fakeFetch: typeof fetch = async (url) => {
        if (String(url).includes("/api/accounts/oauth/token")) {
          return slowTokenPromise
        }
        if (String(url).includes("/api/accounts/oauth/revoke")) {
          return new Response("", { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async (s) => {
          savedSession = s
        },
        loadSession: async () => savedSession,
      })

      // 1. Trigger asynchronous refresh
      const refreshPromise = service.refreshSession()

      // 2. User signs out while refresh is still in-flight
      await service.signOut()
      expect(savedSession).toBeNull()

      // 3. Delayed refresh response arrives with new tokens
      resolveTokenPromise(
        new Response(
          JSON.stringify({
            access_token: "resurrected-token-should-be-discarded",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )

      await refreshPromise
      // Verify savedSession was NOT resurrected!
      expect(savedSession).toBeNull()
      const status = await service.status()
      expect(status.connected).toBe(false)
    })

    it("revokes token on auth server with token_type_hint=refresh_token on signOut (P2 #8)", async () => {
      let revokedBody = ""
      let revokedEndpoint = ""

      let savedSession: ChatGPTSession | null = {
        accessToken: "access-token-to-revoke",
        refreshToken: "refresh-token-to-revoke",
        clientId: "issued-client-999",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "host-1",
      }

      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url).includes("/api/accounts/oauth/revoke")) {
          revokedEndpoint = String(url)
          revokedBody = String(init?.body)
          return new Response("", { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async (s) => {
          savedSession = s
        },
        loadSession: async () => savedSession,
      })

      await service.signOut()
      expect(revokedEndpoint).toBe(CHATGPT_REVOKE_URL)
      const params = new URLSearchParams(revokedBody)
      expect(params.get("token")).toBe("refresh-token-to-revoke")
      expect(params.get("token_type_hint")).toBe("refresh_token")
      expect(params.get("client_id")).toBe("issued-client-999")
      expect(savedSession).toBeNull()
    })

    it("handles browser open failure cleanly without unhandledRejection (P2 #6)", async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (err: unknown) => unhandled.push(err)
      process.on("unhandledRejection", onUnhandled)

      try {
        const service = new ChatGPTAuthService({
          openUrl: async () => false, // simulates browser open failure
          saveSession: async () => {},
          loadSession: async () => null,
        })

        await expect(service.startSignIn({ timeoutMs: 30 })).rejects.toThrow(/Could not open system browser/i)
        // Wait past the timeout to ensure no unhandled timer rejection occurs
        await new Promise((r) => setTimeout(r, 60))
        expect(unhandled).toHaveLength(0)
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })

    it("validates model inference with Responses API (store:false, stream:true) and tool verification (P1 #4)", async () => {
      const activeSession: ChatGPTSession = {
        accessToken: "valid-responses-token",
        clientId: "client-id",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "host-1",
      }

      let capturedUrl = ""
      let capturedBody: Record<string, unknown> = {}

      const ssePayload = [
        'data: {"type": "response.created", "id": "resp_123"}',
        'data: {"type": "response.output_item.added", "item": {"type": "function_call", "name": "ping"}}',
        'data: {"type": "response.completed", "tool_calls": [{"id": "call_1", "function": {"name": "ping"}}]}',
        "data: [DONE]",
      ].join("\n\n")

      const fakeFetch: typeof fetch = async (url, init) => {
        capturedUrl = String(url)
        capturedBody = JSON.parse(String(init?.body))
        return new Response(ssePayload, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => activeSession,
      })

      const val = await service.validateModelInference("gpt-4o")
      expect(val.valid).toBe(true)
      expect(capturedUrl).toBe(OPENAI_RESPONSES_URL)
      expect(capturedBody.store).toBe(false)
      expect(capturedBody.stream).toBe(true)
      expect(capturedBody.model).toBe("gpt-4o")
      expect(capturedBody.tools).toBeDefined()
      expect(val.toolCallsCount).toBe(1)
    })
  })
})
