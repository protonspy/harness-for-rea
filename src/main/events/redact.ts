/*
  Secrets out of everything the event log writes: known key and token shapes, private key blocks,
  values of secret-named fields, and any exact secret registered at runtime (the stored OpenRouter
  key). Runs before either store sees the data.
*/

const MASK = "[redacted]"

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, MASK],
  [/\bsk-(?:or|ant)-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${MASK}`],
  [/("(?:access_?token|refresh_?token|id_?token|accessToken|refreshToken|idToken|client_?secret|api_?key|apiKey)"\s*:\s*)"[^"]*"/gi, `$1"${MASK}"`],
]

const SECRET_FIELD = /^(?:api_?key|apikey|password|passwd|secret|client_?secret|token|access_?token|refresh_?token|id_?token|authorization)$/i

const secrets = new Set<string>()

/** Mask this exact value wherever it appears from now on. Values shorter than 8 characters are ignored. */
export function registerSecret(value: string) {
  if (value && value.length >= 8) secrets.add(value)
}

export function forgetSecrets() {
  secrets.clear()
}

export function redact(text: string): string {
  let out = text
  for (const s of secrets) out = out.split(s).join(MASK)
  for (const [re, to] of PATTERNS) out = out.replace(re, to)
  return out
}

/** Redact every string in a JSON-like value, keys included; secret-named fields lose their value. */
export function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redact(v)
  if (Array.isArray(v)) return v.map(redactValue)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[redact(k)] = SECRET_FIELD.test(k) && typeof x === "string" ? MASK : redactValue(x)
    return out
  }
  return v
}
