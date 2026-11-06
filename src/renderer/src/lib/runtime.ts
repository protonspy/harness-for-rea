/**
  Runtime environment detection and error formatting for renderer initialization.
*/

export function hasElectronBridge(target?: unknown): boolean {
  if (target !== undefined) {
    if (!target || typeof target !== "object") return false
    return Boolean("hfr" in target && (target as Record<string, unknown>).hfr)
  }

  const g = globalThis as unknown as Record<string, unknown>
  const w = (g["window"] as Record<string, unknown> | undefined) ?? g
  return Boolean(w && typeof w === "object" && "hfr" in w && w["hfr"])
}

export function formatRenderError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string" && error.trim().length > 0) return error
  return "Erro desconhecido"
}
