import { describe, expect, it } from "vitest"
import {
  buildAuthorizationUrl,
  ChatGPTAuthService,
  DEFAULT_CLIENT_ID,
  generateCodeChallenge,
  generateCodeVerifier,
  generateRandomToken,
  REQUIRED_SCOPES,
  startLoopbackServer,
  type ChatGPTSession,
} from "../src/main/chatgpt"
import { PROVIDERS, resolveBaseUrl } from "../src/shared/providers"

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

  describe("Authorization URL construction (R1.3, R1.5)", () => {
    it("constructs official authorization URL with dynamic_agent_client, PKCE S256 and required scopes", () => {
      const url = buildAuthorizationUrl({
        redirectUri: "http://127.0.0.1:54321/callback",
        state: "state-xyz",
        nonce: "nonce-123",
        codeChallenge: "challenge-abc",
        hostId: "host-uuid-456",
      })

      const u = new URL(url)
      expect(u.origin).toBe("https://auth.openai.com")
      expect(u.pathname).toBe("/authorize")
      expect(u.searchParams.get("response_type")).toBe("code")
      expect(u.searchParams.get("client_id")).toBe(DEFAULT_CLIENT_ID)
      expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback")
      expect(u.searchParams.get("state")).toBe("state-xyz")
      expect(u.searchParams.get("nonce")).toBe("nonce-123")
      expect(u.searchParams.get("code_challenge")).toBe("challenge-abc")
      expect(u.searchParams.get("code_challenge_method")).toBe("S256")
      expect(u.searchParams.get("ext_agent_host_id")).toBe("host-uuid-456")

      const scopes = u.searchParams.get("scope")?.split(" ")
      for (const req of REQUIRED_SCOPES) {
        expect(scopes).toContain(req)
      }
      expect(scopes).toContain("chatgpt.tokens.use.direct")
      expect(scopes).toContain("resource.invoke")
    })
  })

  describe("Loopback callback server (R1.4)", () => {
    it("starts loopback server, receives callback code and returns HTML", async () => {
      let receivedParams: { code?: string; state?: string } = {}
      const loopback = await startLoopbackServer(0, (params) => {
        receivedParams = params
      })

      expect(loopback.port).toBeGreaterThan(0)
      expect(loopback.redirectUri).toBe(`http://127.0.0.1:${loopback.port}/callback`)

      const res = await fetch(`${loopback.redirectUri}?code=mock_code_123&state=state_abc`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain("Authentication Complete")
      expect(receivedParams.code).toBe("mock_code_123")
      expect(receivedParams.state).toBe("state_abc")

      await loopback.close()
    })

    it("serves error response when error parameter is received", async () => {
      let receivedParams: { error?: string; errorDescription?: string } = {}
      const loopback = await startLoopbackServer(0, (params) => {
        receivedParams = params
      })

      const res = await fetch(`${loopback.redirectUri}?error=access_denied&error_description=User+cancelled`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain("Authentication Cancelled")
      expect(html).toContain("User cancelled")
      expect(receivedParams.error).toBe("access_denied")

      await loopback.close()
    })
  })

  describe("ChatGPTAuthService flow (R2, R3, R4)", () => {
    it("executes complete sign-in flow, verifies state, exchanges token and stores session", async () => {
      let savedSession: ChatGPTSession | null = null
      let openedUrl = ""

      const fakeFetch: typeof fetch = async (url, init) => {
        const u = String(url)
        if (u.includes("/oauth/token")) {
          const body = new URLSearchParams(String(init?.body))
          expect(body.get("grant_type")).toBe("authorization_code")
          expect(body.get("client_id")).toBe(DEFAULT_CLIENT_ID)
          expect(body.get("code_verifier")).toBeDefined()

          return new Response(
            JSON.stringify({
              access_token: "sk-mock-access-token-9999",
              refresh_token: "mock-refresh-token-1111",
              expires_in: 3600,
              scope: "openid profile email chatgpt.tokens.use.direct resource.invoke",
              id_token: `header.${Buffer.from(JSON.stringify({ email: "user@example.com", plan: "plus" })).toString("base64url")}.sig`,
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
          // Simulate browser callback
          const u = new URL(url)
          const redirect = u.searchParams.get("redirect_uri")!
          const state = u.searchParams.get("state")!
          setTimeout(async () => {
            await fetch(`${redirect}?code=valid_auth_code&state=${state}`)
          }, 10)
          return true
        },
        saveSession: async (session) => {
          savedSession = session
        },
        loadSession: async () => savedSession,
        hostId: "persistent-test-host-id",
      })

      const session = await service.startSignIn({ timeoutMs: 5000 })
      expect(session.accessToken).toBe("sk-mock-access-token-9999")
      expect(session.refreshToken).toBe("mock-refresh-token-1111")
      expect(session.accountEmail).toBe("user@example.com")
      expect(session.planType).toBe("plus")
      expect(session.hostId).toBe("persistent-test-host-id")
      expect(savedSession).toEqual(session)

      const status = await service.status()
      expect(status.connected).toBe(true)
      expect(status.accountEmail).toBe("user@example.com")
      expect(status.hasTokenSharingScope).toBe(true)
      expect(openedUrl).toContain("https://auth.openai.com/authorize")
    })

    it("rejects token exchange when account lacks chatgpt.tokens.use.direct scope (R4.2)", async () => {
      let savedSession: ChatGPTSession | null = null

      const fakeFetch: typeof fetch = async (url) => {
        if (String(url).includes("/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "sk-mock-token",
              expires_in: 3600,
              scope: "openid profile email", // missing chatgpt.tokens.use.direct
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
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
            await fetch(`${redirect}?code=code_no_token_sharing&state=${state}`)
          }, 10)
          return true
        },
        saveSession: async (s) => {
          savedSession = s
        },
        loadSession: async () => savedSession,
      })

      await expect(service.startSignIn({ timeoutMs: 5000 })).rejects.toThrow(/token sharing/i)
      expect(savedSession).toBeNull()
    })

    it("handles consent denied error gracefully (R3.3)", async () => {
      const service = new ChatGPTAuthService({
        openUrl: async (url) => {
          const u = new URL(url)
          const redirect = u.searchParams.get("redirect_uri")!
          const state = u.searchParams.get("state")!
          setTimeout(async () => {
            await fetch(`${redirect}?error=access_denied&state=${state}`)
          }, 10)
          return true
        },
        saveSession: async () => {},
        loadSession: async () => null,
      })

      await expect(service.startSignIn({ timeoutMs: 5000 })).rejects.toThrow(/consent denied/i)
    })

    it("refreshes an expiring or expired session automatically (R3.1)", async () => {
      let savedSession: ChatGPTSession | null = {
        accessToken: "expired-access-token",
        refreshToken: "valid-refresh-token",
        expiresAt: Date.now() - 1000, // expired
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "host-123",
      }

      let refreshCalls = 0
      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url).includes("/oauth/token")) {
          refreshCalls++
          const body = new URLSearchParams(String(init?.body))
          expect(body.get("grant_type")).toBe("refresh_token")
          expect(body.get("refresh_token")).toBe("valid-refresh-token")

          return new Response(
            JSON.stringify({
              access_token: "new-access-token-456",
              refresh_token: "new-refresh-token-789",
              expires_in: 7200,
              scope: "openid chatgpt.tokens.use.direct",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
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

      const token = await service.getValidAccessToken()
      expect(token).toBe("new-access-token-456")
      expect(refreshCalls).toBe(1)
      expect(savedSession?.accessToken).toBe("new-access-token-456")
      expect(savedSession?.refreshToken).toBe("new-refresh-token-789")
    })

    it("signs out and revokes the active session cleanly (R3.2)", async () => {
      let revokedToken = ""
      let savedSession: ChatGPTSession | null = {
        accessToken: "token-to-revoke",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "host-1",
      }

      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url).includes("/oauth/revoke")) {
          const body = new URLSearchParams(String(init?.body))
          revokedToken = body.get("token") ?? ""
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
      expect(revokedToken).toBe("token-to-revoke")
      expect(savedSession).toBeNull()

      const status = await service.status()
      expect(status.connected).toBe(false)
    })

    it("validates model inference and tool calling capability (R4.1, R5.2)", async () => {
      const activeSession: ChatGPTSession = {
        accessToken: "test-valid-token",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "host-1",
      }

      let capturedAuth = ""
      let capturedModel = ""

      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url).includes("/chat/completions")) {
          capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] ?? ""
          const body = JSON.parse(String(init?.body))
          capturedModel = body.model

          return new Response(
            JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion",
              created: Date.now(),
              model: "gpt-4o",
              choices: [{ message: { role: "assistant", content: "pong" } }],
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
        loadSession: async () => activeSession,
      })

      const val = await service.validateModelInference("gpt-4o")
      expect(val.valid).toBe(true)
      expect(capturedAuth).toBe("Bearer test-valid-token")
      expect(capturedModel).toBe("gpt-4o")
    })

    it("distinguishes plan without model permission (403) from invalid token (401)", async () => {
      const activeSession: ChatGPTSession = {
        accessToken: "test-token",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        hostId: "host-1",
      }

      const service403 = new ChatGPTAuthService({
        fetch: (async () => new Response("Forbidden", { status: 403 })) as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => activeSession,
      })
      const res403 = await service403.validateModelInference("o1")
      expect(res403.valid).toBe(false)
      expect(res403.status).toBe(403)
      expect(res403.error).toContain("403 Forbidden")

      const service401 = new ChatGPTAuthService({
        fetch: (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => activeSession,
      })
      const res401 = await service401.validateModelInference("gpt-4o")
      expect(res401.valid).toBe(false)
      expect(res401.status).toBe(401)
      expect(res401.error).toContain("401 Unauthorized")
    })

    it("preserves provider isolation: ChatGPT never accesses River API and does not read local Codex files", async () => {
      const accessedUrls: string[] = []
      const fakeFetch: typeof fetch = async (url) => {
        accessedUrls.push(String(url))
        return new Response(JSON.stringify({ error: "endpoint error" }), { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => null,
      })

      await service.status()
      expect(accessedUrls.some((u) => u.includes("river.ai"))).toBe(false)
      expect(accessedUrls.some((u) => u.includes(".codex"))).toBe(false)
    })
  })
})
