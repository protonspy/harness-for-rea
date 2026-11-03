/** Public client attribution for Hopper; no user or project identifiers are sent. */
export function attributionHeaders(baseUrl: string): Record<string, string> {
  try {
    if (new URL(baseUrl).origin === "https://api.withhopper.com") return { "X-Hopper-Client": "harness-for-rea" }
  } catch {
    // Invalid base URLs are handled by the provider client.
  }
  return {}
}
