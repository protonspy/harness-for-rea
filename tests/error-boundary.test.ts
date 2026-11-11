// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { createRoot, type Root as ReactRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { BrowserFallback } from "@/components/BrowserFallback"
import { Root } from "@/Root"

/* specs/renderer: ErrorBoundary and browser fallback component integration tests (Issue #9, PR #10) */

function ThrowingComponent({ message = "Fatal render explosion" }: { message?: string }): ReactNode {
  throw new Error(message)
}

describe("ErrorBoundary and BrowserFallback component integration", () => {
  let container: HTMLDivElement
  let root: ReactRoot

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    try {
      flushSync(() => {
        root.unmount()
      })
    } catch {
      // ignore unmount errors if already unmounted
    }
    container.remove()
    delete (window as unknown as Record<string, unknown>).hfr
    vi.restoreAllMocks()
  })

  it("mounts ErrorBoundary around healthy children and renders them normally", () => {
    flushSync(() => {
      root.render(createElement(ErrorBoundary, null, createElement("div", { id: "healthy-child" }, "Normal Component Content")))
    })

    const child = container.querySelector("#healthy-child")
    expect(child).not.toBeNull()
    expect(child?.textContent).toBe("Normal Component Content")
    expect(container.textContent).not.toContain("Erro de Renderização")
  })

  it("catches render-time errors in children and displays the recovery screen", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

    flushSync(() => {
      root.render(createElement(ErrorBoundary, null, createElement(ThrowingComponent, { message: "Database connection failed unexpectedly" })))
    })

    expect(container.textContent).toContain("Erro de Renderização")
    expect(container.textContent).toContain("Database connection failed unexpectedly")
    expect(container.textContent).toContain("Recarregar aplicação")
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it("triggers window reload when the reload action button is clicked", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const reloadMock = vi.fn()
    window.location.reload = reloadMock

    flushSync(() => {
      root.render(createElement(ErrorBoundary, null, createElement(ThrowingComponent, { message: "Fatal crash" })))
    })

    const reloadButton = container.querySelector("button")
    expect(reloadButton).not.toBeNull()
    expect(reloadButton?.textContent).toBe("Recarregar aplicação")

    reloadButton?.click()
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it("mounts BrowserFallback component directly and renders desktop runtime guidance", () => {
    flushSync(() => {
      root.render(createElement(BrowserFallback))
    })

    expect(container.textContent).toContain("desktop runtime required")
    expect(container.textContent).toContain("Harness for REA")
    expect(container.textContent).toContain("Este é um aplicativo desktop construído em Electron")
    expect(container.textContent).toContain("npm run dev")
  })

  it("renders BrowserFallback and avoids mounting App or calling IPC when bridge is absent", () => {
    delete (window as unknown as Record<string, unknown>).hfr

    flushSync(() => {
      root.render(createElement(Root, { isElectron: false }))
    })

    expect(container.textContent).toContain("desktop runtime required")
    expect(container.textContent).toContain("Harness for REA")
    expect(container.textContent).toContain("Este é um aplicativo desktop construído em Electron")
    expect(container.textContent).not.toContain("Erro de Renderização")
  })

  it("preserves App rendering path and interacts with bridge when bridge is present", async () => {
    const apiMock = {
      getSettings: vi.fn().mockResolvedValue({ setupCompleted: false }),
      listTasks: vi.fn().mockResolvedValue([]),
      listProjects: vi.fn().mockResolvedValue([]),
      readiness: vi.fn().mockResolvedValue({ ready: true }),
    }
    const onPushMock = vi.fn().mockReturnValue(() => undefined)

    ;(window as unknown as Record<string, unknown>).hfr = {
      api: apiMock,
      onPush: onPushMock,
    }

    flushSync(() => {
      root.render(createElement(Root, { isElectron: true }))
    })

    // BrowserFallback should NOT be in the document
    expect(container.textContent).not.toContain("desktop runtime required")

    // App should have called the initial API queries
    expect(apiMock.getSettings).toHaveBeenCalled()
    expect(apiMock.listTasks).toHaveBeenCalledWith({ limit: 200 })
    expect(apiMock.listProjects).toHaveBeenCalled()
    expect(onPushMock).toHaveBeenCalled()
  })
})
