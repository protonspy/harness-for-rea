import { API_SCHEMAS } from "../src/shared/api"
import { describe, expect, it } from "vitest"
import { generateKeyPairSync, createSign } from "node:crypto"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import {
  buildAuthorizationUrl,
  ChatGPTAuthService,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_JWKS_URL,
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
  CHATGPT_REFRESH_LEAD_MS,
  CHATGPT_AUTO_REFRESH_INTERVAL_MS,
  CHATGPT_STATUS_REFRESH_RETRY_MS,
  type ChatGPTSession,
} from "../src/main/chatgpt"
import { PROVIDERS, resolveBaseUrl } from "../src/shared/providers"
import { redact } from "../src/main/events/redact"
import { makeModel } from "../src/main/orchestrator/model"
import { groupModels } from "../src/shared/providers"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import { readiness } from "../src/main/readiness"
import { listChatGPTModels, listModels, probeModel } from "../src/main/orchestrator/models"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCore } from "../src/main/core"
import type { KeyStore } from "../src/main/credentials"

const memory = (init: Record<string, string> = {}): KeyStore => {
  const slots = new Map(Object.entries(init))
  return {
    available: () => true,
    read: async (k: string) => slots.get(k) ?? null,
    write: async (k: string, v: string | null) => {
      if (v === null) {
        slots.delete(k)
      } else {
        slots.set(k, v)
      }
    },
  }
}

describe("ChatGPT / Codex OAuth provider with token sharing (ADR 0030, Issue #2)", () => {
  it("registers chatgpt as an independent provider preset in PROVIDERS", () => {
    expect(PROVIDERS.chatgpt).toBeDefined()
    expect(PROVIDERS.chatgpt.id).toBe("chatgpt")
    expect(PROVIDERS.chatgpt.kind).toBe("openai")
    expect(PROVIDERS.chatgpt.baseUrl).toBe("https://api.openai.com/v1")
    expect(PROVIDERS.chatgpt.defaultModel).toBe("")
    expect(PROVIDERS.chatgpt.models).toEqual([])
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
      expect(CHATGPT_JWKS_URL).toBe("https://auth.openai.com/.well-known/jwks.json")
    })
  })

  describe("ID Token Cryptographic Validation and JWKS Discovery (R3, C1)", () => {
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

  describe("ChatGPTAuthService production flow and JWKS discovery (C1, C5, C6)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwk = publicKey.export({ format: "jwk" })
    jwk.kid = "prod-key-1"

    const makeSignedJwt = (payload: Record<string, unknown>) => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "prod-key-1" })).toString("base64url")
      const claims = Buffer.from(JSON.stringify(payload)).toString("base64url")
      const input = `${header}.${claims}`
      const sign = createSign("RSA-SHA256")
      sign.update(input)
      const sig = sign.sign(privateKey, "base64url")
      return `${input}.${sig}`
    }

    it("executes complete sign-in with production host wiring, fetching JWKS automatically (C1)", async () => {
      let savedSession: ChatGPTSession | null = null
      let openedUrl = ""

      const fakeFetch: typeof fetch = async (url, init) => {
        const u = String(url)
        if (u.includes("/.well-known/jwks.json")) {
          return new Response(JSON.stringify({ keys: [jwk] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
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

      // Initialized WITHOUT pre-injecting jwks or publicKey (exact production host wiring C1)
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

    it("rejects first registration if callback omits client_id (C6)", async () => {
      const service = new ChatGPTAuthService({
        openUrl: async (url) => {
          const u = new URL(url)
          const redirect = u.searchParams.get("redirect_uri")!
          const state = u.searchParams.get("state")!
          // Callback without client_id on first registration
          setTimeout(async () => {
            await fetch(`${redirect}?code=auth_code_ok&state=${state}`)
          }, 10)
          return true
        },
        saveSession: async () => {},
        loadSession: async () => null,
      })

      await expect(service.startSignIn({ timeoutMs: 2000 })).rejects.toThrow(/returned no client_id/i)
    })

    it("enforces timeout deadline through the code exchange phase (C5)", async () => {
      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url).includes("/api/accounts/oauth/token")) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(new Response(JSON.stringify({ access_token: "late_token" }), { status: 200 }))
            }, 500)
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(init.signal?.reason || new Error("Authentication timed out."))
            })
          })
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
            await fetch(`${redirect}?code=auth_code_ok&state=${state}&client_id=issued-client-id`)
          }, 10)
          return true
        },
        saveSession: async () => {},
        loadSession: async () => null,
      })

      // Timeout set to 80ms, fetch takes 500ms
      await expect(service.startSignIn({ timeoutMs: 80 })).rejects.toThrow(/timed out/i)
    })

    it("enforces timeout deadline during the JWKS fetch phase and prevents late session saves (D5)", async () => {
      let saved = false
      const fakeFetch: typeof fetch = async (url, init) => {
        if (String(url).includes("/api/accounts/oauth/token")) {
          // Token responds immediately with valid ID token signed by simulated key
          return new Response(
            JSON.stringify({
              access_token: "tok_quick",
              refresh_token: "ref_quick",
              id_token: "header.payload.signature",
              scope: "openid chatgpt.tokens.use.direct",
            }),
            { status: 200 },
          )
        }
        if (String(url).includes("/.well-known/jwks.json")) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 }))
            }, 500)
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(init.signal?.reason || new Error("Authentication timed out."))
            })
          })
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
            await fetch(`${redirect}?code=auth_code_ok&state=${state}&client_id=issued-client-id`)
          }, 10)
          return true
        },
        saveSession: async () => {
          saved = true
        },
        loadSession: async () => null,
      })

      // Timeout at 80ms, JWKS fetch delayed by 500ms
      await expect(service.startSignIn({ timeoutMs: 80 })).rejects.toThrow(/timed out/i)
      expect(saved).toBe(false)
    })

    it("refreshes JWKS automatically on key rotation when token contains an unknown kid (D5)", async () => {
      const { publicKey: pub1 } = generateKeyPairSync("rsa", { modulusLength: 2048 })
      const { publicKey: pub2, privateKey: priv2 } = generateKeyPairSync("rsa", { modulusLength: 2048 })

      const pubJwk1 = pub1.export({ format: "jwk" }) as Record<string, unknown>
      pubJwk1.kid = "key_v1"
      pubJwk1.alg = "RS256"
      pubJwk1.use = "sig"

      const pubJwk2 = pub2.export({ format: "jwk" }) as Record<string, unknown>
      pubJwk2.kid = "key_v2"
      pubJwk2.alg = "RS256"
      pubJwk2.use = "sig"

      let jwksFetchCount = 0
      let rotatedJwt = ""
      const fakeFetch: typeof fetch = async (url) => {
        if (String(url).includes("/api/accounts/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "tok_rot",
              refresh_token: "ref_rot",
              id_token: rotatedJwt,
              scope: "openid chatgpt.tokens.use.direct",
            }),
            { status: 200 },
          )
        }
        if (String(url).includes("/.well-known/jwks.json")) {
          jwksFetchCount++
          // First fetch returns only key_v1. Forced refresh returns key_v2.
          if (jwksFetchCount === 1) {
            return new Response(JSON.stringify({ keys: [pubJwk1] }), { status: 200 })
          } else {
            return new Response(JSON.stringify({ keys: [pubJwk1, pubJwk2] }), { status: 200 })
          }
        }
        return new Response("Not found", { status: 404 })
      }

      const service = new ChatGPTAuthService({
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        openUrl: async () => true,
        saveSession: async () => {},
        loadSession: async () => null,
      })

      // Populate cache with key_v1
      await service.getJwks()
      expect(jwksFetchCount).toBe(1)

      // Generate a token signed with key_v2
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key_v2" })).toString("base64url")
      const payload = Buffer.from(
        JSON.stringify({
          iss: "https://auth.openai.com",
          sub: "user-123",
          aud: "client-abc",
          nonce: "nonce_ok",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url")
      const signer = createSign("RSA-SHA256")
      signer.update(`${header}.${payload}`)
      const signature = signer.sign(priv2, "base64url")
      rotatedJwt = `${header}.${payload}.${signature}`

      // Execute code exchange directly with rotatedJwt
      const session = await (service as any).exchangeCode({
        code: "auth_code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:0/callback",
        clientId: "client-abc",
        expectedNonce: "nonce_ok",
      })

      // Must have triggered a forced refresh and succeeded with 2 fetches
      expect(jwksFetchCount).toBe(2)
      expect(session.clientId).toBe("client-abc")
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

  describe("Responses API Native Streaming, Text, and Full Tool Cycle (C2, C3)", () => {
    it("handles native Responses API streaming events (response.output_text.delta) in invoke and stream (C2)", async () => {
      const sessionJson = JSON.stringify({
        accessToken: "responses-stream-token",
        refreshToken: "ref-secret",
        clientId: "client-123",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      })

      let interceptedUrl = ""
      let authHeader = ""
      let capturedBody: any = {}

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        interceptedUrl = String(url)
        authHeader = new Headers(init?.headers).get("Authorization") ?? ""
        capturedBody = JSON.parse(String(init?.body ?? "{}"))

        const sseChunks = [
          'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
          'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
          'data: {"type":"response.output_text.delta","delta":"review!"}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"text","text":"Hello review!"}]}],"usage":{"input_tokens":5,"output_tokens":4}}}\n\n',
        ].join("")

        return new Response(sseChunks, { headers: { "Content-Type": "text/event-stream" } })
      }

      try {
        const model = makeModel({
          provider: "chatgpt",
          apiKey: sessionJson,
          model: "gpt-4o",
          onUsage: () => {},
        })

        // Test invoke
        const res = await model.invoke("ping")
        expect(interceptedUrl).toBe(OPENAI_RESPONSES_URL)
        expect(authHeader).toBe("Bearer responses-stream-token")
        expect(capturedBody.store).toBe(false)
        expect(capturedBody.stream).toBe(true)

        // Verify content extracted properly
        const text =
          typeof res.content === "string"
            ? res.content
            : Array.isArray(res.content)
              ? res.content.map((b: any) => (typeof b === "string" ? b : b.text)).join("")
              : (res.content as any)[0]?.text
        expect(text).toContain("Hello review!")

        // Test stream
        const stream = await model.stream("ping")
        let streamedText = ""
        for await (const chunk of stream) {
          const chunkStr = typeof chunk.content === "string" ? chunk.content : ((chunk.content as any)[0]?.text ?? "")
          streamedText += chunkStr
        }
        expect(streamedText).toContain("Hello review!")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("executes full two-way tool calling cycle with function_call and function_call_output (C3)", async () => {
      const sessionJson = JSON.stringify({
        accessToken: "tool-cycle-token",
        clientId: "client-123",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      })

      const requests: any[] = []
      const originalFetch = globalThis.fetch

      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        requests.push(body)

        if (requests.length === 1) {
          // Turn 1: Model asks to call tool ping with call_review
          const sse1 = [
            'data: {"type":"response.created","response":{"id":"resp_fc"}}\n\n',
            'data: {"type":"response.output_item.added","item":{"id":"fc_review","call_id":"call_review","type":"function_call","name":"ping","arguments":""}}\n\n',
            'data: {"type":"response.function_call_arguments.delta","delta":"{\\"message\\":\\"test\\"}"}\n\n',
            'data: {"type":"response.function_call_arguments.done","call_id":"call_review","arguments":"{\\"message\\":\\"test\\"}"}\n\n',
            'data: {"type":"response.completed","response":{"id":"resp_fc","status":"completed","output":[{"id":"fc_review","call_id":"call_review","type":"function_call","name":"ping","arguments":"{\\"message\\":\\"test\\"}"}],"usage":{"input_tokens":10,"output_tokens":8}}}\n\n',
          ].join("")
          return new Response(sse1, { headers: { "Content-Type": "text/event-stream" } })
        } else {
          // Turn 2: Model receives tool result and produces final answer
          const sse2 = [
            'data: {"type":"response.created","response":{"id":"resp_final"}}\n\n',
            'data: {"type":"response.output_text.delta","delta":"Tool result acknowledged: pong"}\n\n',
            'data: {"type":"response.completed","response":{"id":"resp_final","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"text","text":"Tool result acknowledged: pong"}]}],"usage":{"input_tokens":20,"output_tokens":6}}}\n\n',
          ].join("")
          return new Response(sse2, { headers: { "Content-Type": "text/event-stream" } })
        }
      }

      try {
        const model = makeModel({
          provider: "chatgpt",
          apiKey: sessionJson,
          model: "gpt-4o",
          onUsage: () => {},
        })

        // 1. Initial invocation with tool definition
        const toolModel = (model as any).bindTools([
          {
            name: "ping",
            description: "A connectivity verification tool",
            schema: { type: "object", properties: { message: { type: "string" } } },
          },
        ])

        const turn1Response = await toolModel.invoke("Please run ping")
        expect(turn1Response.tool_calls).toHaveLength(1)
        expect(turn1Response.tool_calls[0].name).toBe("ping")
        expect(turn1Response.tool_calls[0].id).toBe("call_review")

        // 2. Client executes tool and passes result back to the model
        const turn2Response = await model.invoke([
          new HumanMessage("Please run ping"),
          new AIMessage({
            content: "",
            tool_calls: [{ name: "ping", args: { message: "test" }, id: "call_review" }],
          }),
          new ToolMessage({
            content: "pong output",
            tool_call_id: "call_review",
          }),
        ])

        // Verify request 2 includes function_call and function_call_output
        expect(requests).toHaveLength(2)
        const input2 = requests[1].input
        const fcItem = input2.find((i: any) => i.type === "function_call" && i.call_id === "call_review")
        const fcoItem = input2.find((i: any) => i.type === "function_call_output" && i.call_id === "call_review")

        expect(fcItem).toBeDefined()
        expect(fcItem.name).toBe("ping")
        expect(fcoItem).toBeDefined()
        expect(fcoItem.output).toBe("pong output")

        const finalContent = typeof turn2Response.content === "string" ? turn2Response.content : (turn2Response.content as any)[0]?.text
        expect(finalContent).toContain("Tool result acknowledged: pong")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("adapts request body for ChatGPT Responses API keeping tools top-level and ensuring all input items have roles", async () => {
      const sessionJson = JSON.stringify({
        accessToken: "siwc-policy-token",
        clientId: "client-123",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      })

      let interceptedBody: any = null
      const originalFetch = globalThis.fetch

      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        interceptedBody = body

        // Strict transport validation reflecting official OpenAI Responses API schema
        if (body.temperature !== undefined) {
          return new Response(JSON.stringify({ error: { message: "temperature is not supported on Responses routes" } }), { status: 400 })
        }
        if (Array.isArray(body.input)) {
          // Every input item must have a role
          for (let idx = 0; idx < body.input.length; idx++) {
            const item = body.input[idx]
            if (!item?.role) {
              return new Response(JSON.stringify({ error: { message: `Missing required parameter: 'input[${idx}].role'` } }), { status: 400 })
            }
          }
          const hasSystem = body.input.some((i: any) => i && i.type === "message" && i.role === "system")
          if (hasSystem) {
            return new Response(JSON.stringify({ error: { message: "system role is not permitted; use developer" } }), { status: 400 })
          }
        }

        const sse = [
          'data: {"type":"response.created","response":{"id":"resp_siwc"}}\n\n',
          'data: {"type":"response.output_text.delta","delta":"Responses API constraints verified"}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_siwc","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"text","text":"Responses API constraints verified"}]}],"usage":{"input_tokens":5,"output_tokens":3}}}\n\n',
        ].join("")

        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } })
      }

      try {
        const model = makeModel({
          provider: "chatgpt",
          apiKey: sessionJson,
          model: "gpt-4o",
          onUsage: () => {},
        })

        const toolModel = (model as any).bindTools([
          {
            name: "test_tool",
            description: "A test tool",
            schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ])

        const res = await toolModel.invoke([new SystemMessage("You are a system reviewer"), new HumanMessage("Verify Responses API compliance")])

        // Verify body conformed to Responses API restrictions
        expect(interceptedBody.temperature).toBeUndefined()
        expect(interceptedBody.top_p).toBeUndefined()
        expect(interceptedBody.store).toBe(false)
        expect(interceptedBody.stream).toBe(true)

        // System message mapped to developer role
        const devMsg = interceptedBody.input.find((i: any) => i.type === "message" && i.role === "developer")
        expect(devMsg).toBeDefined()
        expect(devMsg.content).toContain("You are a system reviewer")

        // Tools must remain at the top level, never injected into input without role
        expect(Array.isArray(interceptedBody.tools)).toBe(true)
        expect(interceptedBody.tools[0].name).toBe("test_tool")
        expect(interceptedBody.tools[0].strict).toBeUndefined()

        // Input must only contain messages with a role
        for (let idx = 0; idx < interceptedBody.input.length; idx++) {
          expect(interceptedBody.input[idx].role).toBeDefined()
        }

        const text = typeof res.content === "string" ? res.content : (res.content as any)[0]?.text
        expect(text).toContain("Responses API constraints verified")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("rejects invoke and stream when stream ends with EOF without response.completed (D2)", async () => {
      const sessionJson = JSON.stringify({
        accessToken: "eof-stream-token",
        clientId: "client-123",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      })

      const originalFetch = globalThis.fetch

      // Stream ending with EOF after output delta without response.completed
      globalThis.fetch = async () => {
        const incompleteSse = [
          'data: {"type":"response.created","response":{"id":"resp_premature"}}\n\n',
          'data: {"type":"response.output_text.delta","delta":"Partial answer"}\n\n',
        ].join("")
        return new Response(incompleteSse, { headers: { "Content-Type": "text/event-stream" } })
      }

      try {
        const model = makeModel({
          provider: "chatgpt",
          apiKey: sessionJson,
          model: "gpt-4o",
          onUsage: () => {},
        })

        // invoke must reject
        await expect(model.invoke("test")).rejects.toThrow(/terminated prematurely without response\.completed/i)

        // stream must throw
        const stream = await model.stream("test")
        await expect(async () => {
          for await (const chunk of stream) {
            void chunk
          }
        }).rejects.toThrow(/terminated prematurely without response\.completed/i)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("rejects invoke and stream when stream emits response.failed or response.incomplete (D2)", async () => {
      const sessionJson = JSON.stringify({
        accessToken: "failed-stream-token",
        clientId: "client-123",
        expiresAt: Date.now() + 3600_000,
        scopes: ["openid"],
        hostId: "urn:uuid:11111111-2222-3333-4444-555555555555",
      })

      const originalFetch = globalThis.fetch

      try {
        const model = makeModel({
          provider: "chatgpt",
          apiKey: sessionJson,
          model: "gpt-4o",
          onUsage: () => {},
        })

        // 1. response.failed
        globalThis.fetch = async () => {
          const failedSse = [
            'data: {"type":"response.created","response":{"id":"resp_fail"}}\n\n',
            'data: {"type":"response.failed","response":{"error":{"message":"Safety policy triggered"}}}\n\n',
          ].join("")
          return new Response(failedSse, { headers: { "Content-Type": "text/event-stream" } })
        }
        await expect(model.invoke("test")).rejects.toThrow(/ChatGPT Responses stream failed: Safety policy triggered/i)

        // 2. response.incomplete
        globalThis.fetch = async () => {
          const incompleteSse = [
            'data: {"type":"response.created","response":{"id":"resp_inc"}}\n\n',
            'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
          ].join("")
          return new Response(incompleteSse, { headers: { "Content-Type": "text/event-stream" } })
        }
        await expect(model.invoke("test")).rejects.toThrow(/ChatGPT Responses stream incomplete: max_output_tokens/i)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe("Probe Model and List Models (C4, R7)", () => {
    it("probeModel succeeds when response contains error: null (C4)", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (String(url) === OPENAI_RESPONSES_URL) {
          const sse = 'data: {"type":"response.completed","response":{"status":"completed","error":null}}\n\n'
          return new Response(sse, { headers: { "Content-Type": "text/event-stream" } })
        }
        return new Response("Not found", { status: 404 })
      }

      try {
        await probeModel({
          provider: "chatgpt",
          baseUrl: "",
          apiKey: "tok",
          model: "gpt-4o",
        })
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("probeModel fails when response.failed is received", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (String(url) === OPENAI_RESPONSES_URL) {
          const sse = 'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"Model unavailable"}}}\n\n'
          return new Response(sse, { headers: { "Content-Type": "text/event-stream" } })
        }
        return new Response("Not found", { status: 404 })
      }

      try {
        await expect(
          probeModel({
            provider: "chatgpt",
            baseUrl: "",
            apiKey: "tok",
            model: "gpt-4o",
          }),
        ).rejects.toThrow(/Model unavailable/)
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

    it("groupModels for chatgpt preserves exact server order, contains zero static presets, and does not sort alphabetically", () => {
      const input = ["account-model-z", "account-model-a"]
      const groups = groupModels("chatgpt", input)
      expect(groups).toEqual([{ label: "Models", models: ["account-model-z", "account-model-a"] }])
      expect(groups[0].models).not.toContain("gpt-4o")
      expect(groups[0].models[0]).toBe("account-model-z")
      expect(groups[0].models[1]).toBe("account-model-a")
    })

    it("listChatGPTModels returns slug and displayName, preserves order, and filters visibility === list", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              models: [
                { slug: "model-zeta", display_name: "Model Zeta", visibility: "list" },
                { slug: "model-alpha", display_name: "Model Alpha", visibility: "list" },
                { slug: "hidden-beta", display_name: "Hidden Beta", visibility: "none" },
                { slug: "no-visibility", display_name: "No Visibility" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        return new Response("Not found", { status: 404 })
      }

      try {
        const options = await listChatGPTModels({ apiKey: "tok" })
        expect(options).toEqual([
          { slug: "model-zeta", displayName: "Model Zeta" },
          { slug: "model-alpha", displayName: "Model Alpha" },
        ])
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("listChatGPTModels refuses generic body.data fallback and throws", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "generic-gpt" }] }), { status: 200, headers: { "Content-Type": "application/json" } })
        }
        return new Response("Not found", { status: 404 })
      }

      try {
        await expect(listChatGPTModels({ apiKey: "tok" })).rejects.toThrow(/did not return a ChatGPT model list/)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("readiness validates ChatGPT specialist model against account catalog and requires account connection", async () => {
      const fakeDeps = (accountModels: string[], keySet = true) => ({
        sandbox: async () => ({ docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "1.0" }),
        login: async () => ({ loggedIn: true, method: "claude.ai", inProgress: false, url: null, text: "", error: "" }),
        settings: () => ({
          ...DEFAULT_SETTINGS,
          specialistProvider: "chatgpt" as const,
          specialistModel: "custom-slug-1",
        }),
        keySet: () => keySet,
        listModels: async () => accountModels,
        probeModel: async () => undefined,
      })

      const rNotConnected = await readiness(fakeDeps(["custom-slug-1"], false))
      expect(rNotConnected.claude.ready).toBe(false)
      expect(rNotConnected.claude.reason).toBe("Connect your ChatGPT account: the specialist runs on it.")

      const rInvalidModel = await readiness(fakeDeps(["different-model"]))
      expect(rInvalidModel.claude.ready).toBe(false)
      expect(rInvalidModel.claude.reason).toContain("custom-slug-1")
      expect(rInvalidModel.claude.reason).toContain("not available for the connected ChatGPT account")

      const rValid = await readiness(fakeDeps(["custom-slug-1"]))
      expect(rValid.claude.ready).toBe(true)
      expect(rValid.claude.reason).toBe("")
    })

    it("readiness validates ChatGPT orchestrator model against account catalog without generic fallback", async () => {
      const fakeDeps = (accountModels: string[], keySet = true) => ({
        sandbox: async () => ({ docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "1.0" }),
        login: async () => ({ loggedIn: true, method: "claude.ai", inProgress: false, url: null, text: "", error: "" }),
        settings: () => ({
          ...DEFAULT_SETTINGS,
          provider: "chatgpt" as const,
          model: "unavailable-slug",
          specialistProvider: "claude" as const,
        }),
        keySet: () => keySet,
        listModels: async () => accountModels,
        probeModel: async () => undefined,
      })

      const rNoKey = await readiness(fakeDeps(["other"], false))
      expect(rNoKey.model.ready).toBe(false)
      expect(rNoKey.model.reason).toBe("Connect your ChatGPT account.")

      const rBadModel = await readiness(fakeDeps(["other"]))
      expect(rBadModel.model.ready).toBe(false)
      expect(rBadModel.model.reason).toContain("not available for the connected ChatGPT account")

      const rOk = await readiness(fakeDeps(["unavailable-slug"]))
      expect(rOk.model.ready).toBe(true)
    })
    it("R1: SettingsPatch and saveSettings accept empty model for ChatGPT pending discovery, but reject empty model for other providers", async () => {
      // Verify SettingsPatch allows model: ""
      const patchChatgpt = API_SCHEMAS.saveSettings.parse([{ provider: "chatgpt", model: "" }])
      expect(patchChatgpt[0].model).toBe("")

      const patchSpecialist = API_SCHEMAS.saveSettings.parse([{ specialistProvider: "chatgpt", specialistModel: "" }])
      expect(patchSpecialist[0].specialistModel).toBe("")
    })

    it("R2: expectedProvider prevents stale async catalog discovery from corrupting another provider", async () => {
      const patchWithGuard = API_SCHEMAS.saveSettings.parse([{ model: "custom-chatgpt-slug", expectedProvider: "chatgpt" }])
      expect(patchWithGuard[0].expectedProvider).toBe("chatgpt")
      expect(patchWithGuard[0].model).toBe("custom-chatgpt-slug")
    })

    it("R4: readiness with list: false still validates ChatGPT orchestrator and specialist models", async () => {
      const fakeDeps = (accountModels: string[]) => ({
        sandbox: async () => ({ docker: true, dockerError: "", images: true, building: false, buildLog: "", claudeVersion: "1.0" }),
        login: async () => ({ loggedIn: true, method: "claude.ai", inProgress: false, url: null, text: "", error: "" }),
        settings: () => ({
          ...DEFAULT_SETTINGS,
          provider: "chatgpt" as const,
          model: "unlisted-model",
          specialistProvider: "chatgpt" as const,
          specialistModel: "unlisted-specialist",
        }),
        keySet: () => true,
        listModels: async () => accountModels,
        probeModel: async () => undefined,
      })

      // Even with list: false, ChatGPT models MUST be validated
      const r = await readiness(fakeDeps(["account-model-1"]), { list: false })
      expect(r.model.ready).toBe(false)
      expect(r.model.reason).toContain("unlisted-model")
      expect(r.claude.ready).toBe(false)
      expect(r.claude.reason).toContain("unlisted-specialist")
    })

    it("R1 behavioral: saveSettings rejects empty model for non-ChatGPT providers in real handler", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hfr-core-r1-"))
      const core = await startCore({
        app: "desktop",
        version: "1.0.0",
        dataDir: dir,
        sandboxDir: dir,
        push: () => {},
        keys: memory(),
      })

      try {
        await expect(core.handlers.saveSettings({ provider: "hopper", model: "" })).rejects.toThrow(/A model must be provided for Hopper/)
        await expect(core.handlers.saveSettings({ specialistProvider: "hopper", specialistModel: "" })).rejects.toThrow(/A model must be provided for Hopper/)
      } finally {
        await core.shutdown()
      }
    })

    it("R2 behavioral: saveSettings with suspended model validation discards patch when provider changes concurrently", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hfr-core-r2-"))
      const keyStore = memory({
        "chatgpt.key": JSON.stringify({
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "tok",
          refreshToken: "ref",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() + 3600_000,
        }),
      })
      const core = await startCore({
        app: "desktop",
        version: "1.0.0",
        dataDir: dir,
        sandboxDir: dir,
        push: () => {},
        keys: keyStore,
      })

      try {
        await core.handlers.saveSettings({ provider: "chatgpt", model: "" })
        const initial = await core.handlers.getSettings()
        expect(initial.provider).toBe("chatgpt")

        let resolveModels: (res: Response) => void
        const modelPromise = new Promise<Response>((resolve) => {
          resolveModels = resolve
        })

        const originalFetch = globalThis.fetch
        globalThis.fetch = async (url) => {
          if (String(url).endsWith("/models")) {
            return modelPromise
          }
          return new Response("Not found", { status: 404 })
        }

        try {
          const pendingSave = core.handlers.saveSettings({
            model: "chatgpt-account-only",
            expectedProvider: "chatgpt",
          })

          await core.handlers.saveSettings({
            provider: "hopper",
            model: "deepseek-coder",
          })
          const switched = await core.handlers.getSettings()
          expect(switched.provider).toBe("hopper")
          expect(switched.model).toBe("deepseek-coder")

          resolveModels!(
            new Response(
              JSON.stringify({
                models: [{ slug: "chatgpt-account-only", display_name: "Account Only", visibility: "list" }],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          )

          const res = await pendingSave
          expect(res.provider).toBe("hopper")
          expect(res.model).toBe("deepseek-coder")

          const current = await core.handlers.getSettings()
          expect(current.provider).toBe("hopper")
          expect(current.model).toBe("deepseek-coder")
        } finally {
          globalThis.fetch = originalFetch
        }
      } finally {
        await core.shutdown()
      }
    })

    it("R3 behavioral: chatGPTLogout advances generation, rejecting in-flight discovery and keeping cache empty", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hfr-core-r3-"))
      const keyStore = memory({
        "chatgpt.key": JSON.stringify({
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "tok",
          refreshToken: "ref",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() + 3600_000,
        }),
      })
      const core = await startCore({
        app: "desktop",
        version: "1.0.0",
        dataDir: dir,
        sandboxDir: dir,
        push: () => {},
        keys: keyStore,
      })

      try {
        let resolveDiscovery: (res: Response) => void
        const discoveryPromise = new Promise<Response>((resolve) => {
          resolveDiscovery = resolve
        })

        const originalFetch = globalThis.fetch
        globalThis.fetch = async (url) => {
          if (String(url).endsWith("/models")) {
            return discoveryPromise
          }
          if (String(url) === CHATGPT_REVOKE_URL) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          return new Response("Not found", { status: 404 })
        }

        try {
          const inFlightDiscovery = core.handlers.listChatGPTModels()

          await core.handlers.chatGPTLogout()

          resolveDiscovery!(
            new Response(
              JSON.stringify({
                models: [{ slug: "gpt-4o", display_name: "GPT-4o", visibility: "list" }],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          )

          await expect(inFlightDiscovery).rejects.toThrow(/ChatGPT session changed during model discovery/)

          await expect(core.handlers.listChatGPTModels()).rejects.toThrow(/Connect your ChatGPT account to list available models/)
        } finally {
          globalThis.fetch = originalFetch
        }
      } finally {
        await core.shutdown()
      }
    })

    describe("ChatGPT proactive refresh and status auto-healing (Issue #21)", () => {
      it("auto-heals expired session when refreshToken is present", async () => {
        let refreshCalls = 0
        const initialSession: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "expired_token",
          refreshToken: "valid_refresh",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() - 1000,
        }

        let storedSession: ChatGPTSession | null = { ...initialSession }
        const fakeFetch = async (url: string | URL | Request) => {
          if (String(url) === CHATGPT_TOKEN_URL) {
            refreshCalls++
            return new Response(
              JSON.stringify({
                access_token: "new_token",
                refresh_token: "new_refresh",
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
          saveSession: async (s) => {
            storedSession = s
          },
          loadSession: async () => storedSession,
        })

        const status = await service.status()
        expect(refreshCalls).toBe(1)
        expect(status.connected).toBe(true)
        expect(status.accountEmail).toBe("user@example.com")
        expect(storedSession?.accessToken).toBe("new_token")
      })

      it("auto-heals when access token is within lead window (CHATGPT_REFRESH_LEAD_MS)", async () => {
        let refreshCalls = 0
        const nearingExpirySession: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "near_expired_token",
          refreshToken: "valid_refresh",
          accountEmail: "user@example.com",
          planType: "pro",
          expiresAt: Date.now() + CHATGPT_REFRESH_LEAD_MS - 5000,
        }

        let storedSession: ChatGPTSession | null = { ...nearingExpirySession }
        const fakeFetch = async (url: string | URL | Request) => {
          if (String(url) === CHATGPT_TOKEN_URL) {
            refreshCalls++
            return new Response(
              JSON.stringify({
                access_token: "fresh_token",
                refresh_token: "fresh_refresh",
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
          saveSession: async (s) => {
            storedSession = s
          },
          loadSession: async () => storedSession,
        })

        const status = await service.status()
        expect(refreshCalls).toBe(1)
        expect(status.connected).toBe(true)
        expect(storedSession?.accessToken).toBe("fresh_token")
      })

      it("does not auto-heal when access token is far from expiring (> CHATGPT_REFRESH_LEAD_MS)", async () => {
        let refreshCalls = 0
        const freshSession: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "valid_token",
          refreshToken: "valid_refresh",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() + 3000_000,
        }

        const fakeFetch = async () => {
          refreshCalls++
          return new Response("ok")
        }

        const service = new ChatGPTAuthService({
          fetch: fakeFetch as unknown as typeof globalThis.fetch,
          openUrl: async () => true,
          saveSession: async () => {},
          loadSession: async () => freshSession,
        })

        const status = await service.status()
        expect(refreshCalls).toBe(0)
        expect(status.connected).toBe(true)
      })

      it("reports expired when no refreshToken exists to heal session", async () => {
        let refreshCalls = 0
        const expiredNoRefresh: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "expired_token",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() - 5000,
        }

        const fakeFetch = async () => {
          refreshCalls++
          return new Response("ok")
        }

        const service = new ChatGPTAuthService({
          fetch: fakeFetch as unknown as typeof globalThis.fetch,
          openUrl: async () => true,
          saveSession: async () => {},
          loadSession: async () => expiredNoRefresh,
        })

        const status = await service.status()
        expect(refreshCalls).toBe(0)
        expect(status.connected).toBe(false)
        expect(status.error).toContain("Session expired")
      })

      it("throttles failed refresh retries via CHATGPT_STATUS_REFRESH_RETRY_MS", async () => {
        let refreshAttempts = 0
        const expiredSession: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "expired_token",
          refreshToken: "bad_refresh",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() - 1000,
        }

        const fakeFetch = async () => {
          refreshAttempts++
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
        }

        const service = new ChatGPTAuthService({
          fetch: fakeFetch as unknown as typeof globalThis.fetch,
          openUrl: async () => true,
          saveSession: async () => {},
          loadSession: async () => expiredSession,
        })

        // First status call attempts refresh and fails
        const s1 = await service.status()
        expect(refreshAttempts).toBe(1)
        expect(s1.connected).toBe(false)

        // Immediate second status call is throttled and does not hit token endpoint again
        const s2 = await service.status()
        expect(refreshAttempts).toBe(1)
        expect(s2.connected).toBe(false)
      })

      it("differentiates transient 503 failure from invalid_grant on expired session status", async () => {
        let refreshAttempts = 0
        const expiredSession: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "expired_token",
          refreshToken: "good_refresh",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() - 1000,
        }

        const fakeFetch = async () => {
          refreshAttempts++
          return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 })
        }

        const service = new ChatGPTAuthService({
          fetch: fakeFetch as unknown as typeof globalThis.fetch,
          openUrl: async () => true,
          saveSession: async () => {},
          loadSession: async () => expiredSession,
        })

        const status = await service.status()
        expect(refreshAttempts).toBe(1)
        expect(status.connected).toBe(false)
        expect(status.warning).toContain("Session renewal temporarily unavailable")
        expect(status.error).toBeUndefined()
      })

      it("reports error when refresh fails with invalid_grant", async () => {
        let refreshAttempts = 0
        const expiredSession: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "expired_token",
          refreshToken: "revoked_refresh",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() - 1000,
        }

        const fakeFetch = async () => {
          refreshAttempts++
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
        }

        const service = new ChatGPTAuthService({
          fetch: fakeFetch as unknown as typeof globalThis.fetch,
          openUrl: async () => true,
          saveSession: async () => {},
          loadSession: async () => expiredSession,
        })

        const status = await service.status()
        expect(refreshAttempts).toBe(1)
        expect(status.connected).toBe(false)
        expect(status.error).toContain("Session expired. Please reconnect your account.")
        expect(status.warning).toBeUndefined()
      })

      it("startAutoRefresh sets background timer and stopAutoRefresh clears it", async () => {
        expect(CHATGPT_AUTO_REFRESH_INTERVAL_MS).toBe(300_000)
        expect(CHATGPT_STATUS_REFRESH_RETRY_MS).toBe(60_000)
        const freshSession: ChatGPTSession = {
          scopes: ["chatgpt.tokens.use.direct"],
          hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
          clientId: "client_123",
          accessToken: "valid_token",
          refreshToken: "valid_refresh",
          accountEmail: "user@example.com",
          planType: "plus",
          expiresAt: Date.now() + 3600_000,
        }

        const service = new ChatGPTAuthService({
          fetch: (async () => new Response("ok")) as unknown as typeof globalThis.fetch,
          openUrl: async () => true,
          saveSession: async () => {},
          loadSession: async () => freshSession,
        })

        service.startAutoRefresh(1000)
        expect((service as any).autoRefreshTimer).not.toBeNull()

        service.stopAutoRefresh()
        expect((service as any).autoRefreshTimer).toBeNull()
      })

      it("signOut clears auto-refresh timer and resets failed refresh throttle", async () => {
        const service = new ChatGPTAuthService({
          fetch: (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof globalThis.fetch,
          openUrl: async () => true,
          saveSession: async () => {},
          loadSession: async () => null,
        })

        service.startAutoRefresh(1000)
        ;(service as any).lastFailedRefreshAt = Date.now()

        await service.signOut()

        expect((service as any).autoRefreshTimer).toBeNull()
        expect((service as any).lastFailedRefreshAt).toBeNull()
      })
    })
  })
})
