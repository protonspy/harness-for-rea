import { describe, expect, it } from "vitest"
import { RIVER_API_BASE_URL, RIVER_CONSOLE_KEYS_URL, RIVER_DOCS_INFERENCE_URL, RiverAuthService, type Fetch } from "../src/main/river"

describe("River authentication investigation (specs/river-auth, adr:0029)", () => {
  it("reports that official browser login is not supported and directs to River Console (R1.1, R1.2, R1.4)", () => {
    const service = new RiverAuthService()
    const cap = service.capability()

    expect(cap.hasOfficialBrowserLogin).toBe(false)
    expect(cap.supportedAuthMethod).toBe("api_key")
    expect(cap.consoleUrl).toBe(RIVER_CONSOLE_KEYS_URL)
    expect(cap.docsUrl).toBe(RIVER_DOCS_INFERENCE_URL)
    expect(cap.message).toContain("River does not provide an external browser authorization")
    expect(service.hasOfficialBrowserLoginFlow()).toBe(false)
  })

  it("explicitly rejects browser sign-in requests with the console keys URL (R1.3, R1.4)", async () => {
    const service = new RiverAuthService()
    await expect(service.startBrowserSignIn()).rejects.toThrow(/River AI does not support browser authorization.*https:\/\/console\.river\.ai\/keys/)
  })

  it("rejects empty keys immediately without network calls (R2.3)", async () => {
    let called = false
    const mockFetch: Fetch = async () => {
      called = true
      return new Response("{}", { status: 200 })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("   ")

    expect(result.valid).toBe(false)
    expect(result.error).toBe("River API key cannot be empty.")
    expect(called).toBe(false)
  })

  it("validates valid River API key on 200 OK (R2.3)", async () => {
    let capturedAuth = ""
    let capturedUrl = ""
    const mockFetch: Fetch = async (url, init) => {
      capturedUrl = url
      capturedAuth = String((init.headers as Record<string, string>)["Authorization"])
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_test_key_12345")

    expect(result.valid).toBe(true)
    expect(result.status).toBe(200)
    expect(capturedUrl).toBe(`${RIVER_API_BASE_URL}/models`)
    expect(capturedAuth).toBe("Bearer rv_test_key_12345")
  })

  it("classifies HTTP 401 as invalid key without leaking key content in error (R2.2, R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Invalid API key provided" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    const secretKey = "rv_super_secret_token_abcdef"
    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey(secretKey)

    expect(result.valid).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Invalid River API key.")
    expect(result.error).not.toContain(secretKey)
  })

  it("classifies HTTP 403 as forbidden permissions (R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Permission denied" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key_no_perm")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error).toBe("River account does not have access or permissions for this endpoint.")
  })

  it("classifies HTTP 429 as quota or rate limit exceeded (R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key_quota")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(429)
    expect(result.error).toBe("River rate limit exceeded or credit quota exhausted.")
  })

  it("handles upstream network failures gracefully (R2.3)", async () => {
    const mockFetch: Fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.river.ai")
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key")

    expect(result.valid).toBe(false)
    expect(result.error).toContain("River could not be reached: getaddrinfo ENOTFOUND api.river.ai")
  })
})
