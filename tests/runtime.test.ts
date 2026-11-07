import { describe, expect, it } from "vitest"
import { formatRenderError, hasElectronBridge } from "../src/renderer/src/lib/runtime"

describe("runtime detection and error formatting (Issue #9)", () => {
  it("detects absence of electron bridge when object is undefined or null", () => {
    expect(hasElectronBridge(undefined)).toBe(false)
    expect(hasElectronBridge(null)).toBe(false)
    expect(hasElectronBridge({})).toBe(false)
  })

  it("detects presence of electron bridge when window.hfr is provided", () => {
    const fakeWindow = { hfr: { api: {}, onPush: () => () => undefined } }
    expect(hasElectronBridge(fakeWindow)).toBe(true)
  })

  it("formats Error instances to their message", () => {
    const err = new Error("Failed to load project database")
    expect(formatRenderError(err)).toBe("Failed to load project database")
  })

  it("formats string errors", () => {
    expect(formatRenderError("Network request timed out")).toBe("Network request timed out")
  })

  it("returns default message for unknown or empty errors", () => {
    expect(formatRenderError(null)).toBe("Erro desconhecido")
    expect(formatRenderError(undefined)).toBe("Erro desconhecido")
    expect(formatRenderError("   ")).toBe("Erro desconhecido")
    expect(formatRenderError({})).toBe("Erro desconhecido")
  })
})
