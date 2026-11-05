import { describe, expect, it } from "vitest"
import { RIVER_CONSOLE_KEYS_URL, RIVER_DOCS_INFERENCE_URL, RIVER_MODELS_URL, RiverAuthService, type Fetch } from "../src/main/river"

describe("River authentication investigation (specs/river-auth, adr:0029)", () => {
  it("reports that official browser login is not supported and directs to River Console (R1.1, R1.2, R1.4)", () => {
    const service = new RiverAuthService()
    const cap = service.capability()

    expect(cap.hasOfficialBrowserLogin).toBe(false)
    expect(cap.supportedAuthMethod).toBe("api_key")
    expect(cap.consoleUrl).toBe(RIVER_CONSOLE_KEYS_URL)
    expect(cap.docsUrl).toBe(RIVER_DOCS_INFERENCE_URL)
    expect(cap.message).toContain("No public documented browser authorization")
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

  // Finding 1 regression: keys with newlines/control characters do not cause unhandled header exceptions
  it("rejects keys with newlines or control characters safely without exposing secrets (Finding 1)", async () => {
    let called = false
    const mockFetch: Fetch = async () => {
      called = true
      return new Response("{}", { status: 200 })
    }

    const service = new RiverAuthService(mockFetch)
    const badKey = "rv_FAKE_REVIEW_ONLY\ninvalid"
    const result = await service.validateKey(badKey)

    expect(result.valid).toBe(false)
    expect(result.error).toBe("River API key contains invalid characters.")
    expect(result.error).not.toContain("rv_FAKE_REVIEW_ONLY")
    expect(called).toBe(false)
  })

  // Finding 1 regression: exceptions during fetch containing the secret are redacted
  it("redacts credentials from unexpected transport or header exception messages (Finding 1)", async () => {
    const secretKey = "rv_SECRET_KEY_999888"
    const mockFetch: Fetch = async () => {
      throw new Error(`Headers.append: "Bearer ${secretKey}" is an invalid header value.`)
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey(secretKey)

    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain(secretKey)
    expect(result.error).toContain("[redacted]")
  })

  // Finding 2 regression: requests strictly target the fixed official HTTPS endpoint
  it("always targets the official HTTPS /v1/models endpoint without accepting arbitrary URLs (Finding 2)", async () => {
    let requestedUrl = ""
    let capturedAuth = ""
    const mockFetch: Fetch = async (url, init) => {
      requestedUrl = url
      capturedAuth = String((init.headers as Record<string, string>)["Authorization"])
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_test_key_12345")

    expect(result.valid).toBe(true)
    expect(requestedUrl).toBe(RIVER_MODELS_URL)
    expect(capturedAuth).toBe("Bearer rv_test_key_12345")
  })

  // Finding 3 regression: HTML 200 responses are rejected as invalid non-JSON
  it("rejects HTTP 200 with HTML content as invalid non-JSON response (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response("<html><body>Login Page</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River returned invalid or non-JSON response.")
  })

  // Finding 3 regression: malformed JSON responses are rejected
  it("rejects HTTP 200 with malformed JSON (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response("{ not valid json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River returned invalid or non-JSON response.")
  })

  // Finding 3 regression: unexpected response structure missing data array is rejected
  it("rejects HTTP 200 missing the data array (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ unexpected: "payload" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River response missing models data array.")
  })

  // Finding 3 regression: HTTP 200 containing error payload is handled cleanly
  it("rejects HTTP 200 containing an error object in body (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Internal proxy gateway failure" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_format_key")

    expect(result.valid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toBe("River returned error: Internal proxy gateway failure")
  })

  // Finding 3 regression: valid empty catalog is authenticated and returns modelsCount = 0
  it("distinguishes valid empty catalog as authenticated with modelsCount 0 (Finding 3)", async () => {
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)
    const result = await service.validateKey("rv_valid_key")

    expect(result.valid).toBe(true)
    expect(result.status).toBe(200)
    expect(result.modelsCount).toBe(0)
    expect(result.models).toEqual([])
  })

  // Finding 3 regression: populated catalog with model availability check
  it("validates populated catalog and reports whether selected model is present (Finding 3)", async () => {
    const catalog = [
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "model" },
      { id: "GLM-5.3", object: "model" },
    ]
    const mockFetch: Fetch = async () => {
      return new Response(JSON.stringify({ object: "list", data: catalog }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const service = new RiverAuthService(mockFetch)

    const withModel = await service.validateKey("rv_valid_key", "deepseek-ai/DeepSeek-V4.1-Flash")
    expect(withModel.valid).toBe(true)
    expect(withModel.modelsCount).toBe(2)
    expect(withModel.models).toEqual(["deepseek-ai/DeepSeek-V4.1-Flash", "GLM-5.3"])
    expect(withModel.hasModel).toBe(true)

    const withoutModel = await service.validateKey("rv_valid_key", "non-existent-model")
    expect(withoutModel.valid).toBe(true)
    expect(withoutModel.hasModel).toBe(false)
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
