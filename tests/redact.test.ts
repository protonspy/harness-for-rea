import { beforeEach, describe, expect, it } from "vitest"
import { forgetSecrets, redact, redactValue, registerSecret } from "../src/main/events/redact"

/* specs/event-log R1.2: secrets never reach either store. */

describe("redact", () => {
  beforeEach(() => forgetSecrets())

  it("masks OpenRouter and Anthropic keys", () => {
    expect(redact("key sk-or-v1-0123456789abcdef0123 end")).toBe("key [redacted] end")
    expect(redact("sk-ant-api03-AbC_dEf-123456789012345")).toBe("[redacted]")
    expect(redact("sk-ant-oat01-AbCdEf123456789012345")).toBe("[redacted]")
  })

  it("masks bearer tokens but keeps the word", () => {
    expect(redact("Authorization: Bearer eyJhbGciOi.payload.sig")).toBe("Authorization: Bearer [redacted]")
  })

  it("masks a private key block whole", () => {
    const pem = "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----\nb"
    expect(redact(pem)).toBe("a\n[redacted]\nb")
  })

  it("masks OAuth token fields in JSON text", () => {
    const text = '{"accessToken":"abc123secret","refresh_token": "def456secret","name":"x"}'
    const out = redact(text)
    expect(out).not.toContain("abc123secret")
    expect(out).not.toContain("def456secret")
    expect(out).toContain('"name":"x"')
  })

  it("masks a registered secret wherever it appears, even without a known shape", () => {
    registerSecret("hunter2-but-longer")
    expect(redact("the key is hunter2-but-longer!")).toBe("the key is [redacted]!")
  })

  it("ignores registered secrets too short to be one", () => {
    registerSecret("ab")
    expect(redact("abc")).toBe("abc")
  })

  it("leaves ordinary text alone", () => {
    const s = "Read src/main/index.ts:10-20 — the window is sandboxed; tokens: 120"
    expect(redact(s)).toBe(s)
  })

  it("walks nested payloads, keys included, without changing numbers or booleans", () => {
    registerSecret("my-registered-secret")
    const v = { a: ["sk-or-v1-0123456789abcdef0123", { b: "Bearer xyz.abc.def" }], n: 3, ok: true, nil: null, "my-registered-secret": 1 }
    expect(redactValue(v)).toEqual({ a: ["[redacted]", { b: "Bearer [redacted]" }], n: 3, ok: true, nil: null, "[redacted]": 1 })
  })

  it("masks values of secret-named fields in objects", () => {
    expect(redactValue({ apiKey: "anything-at-all", password: "pw", token: "t", other: "keep" })).toEqual({
      apiKey: "[redacted]",
      password: "[redacted]",
      token: "[redacted]",
      other: "keep",
    })
  })
})
