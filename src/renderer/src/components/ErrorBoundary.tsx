import { Component, type ErrorInfo, type ReactNode } from "react"
import { formatRenderError } from "../lib/runtime"

export interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
}

export interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Uncaught render error:", error, errorInfo)
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-neutral-950 p-6 text-center text-neutral-200">
          <div className="max-w-md rounded-lg border border-red-900/50 bg-neutral-900/90 p-6 shadow-xl">
            <h1 className="mb-2 text-xl font-bold text-red-400">Erro de Renderização</h1>
            <p className="mb-4 text-sm text-neutral-400">Ocorreu um erro inesperado na interface:</p>
            <pre className="mb-4 max-h-32 overflow-auto rounded bg-neutral-950 p-3 text-left font-mono text-xs text-red-300">
              {formatRenderError(this.state.error)}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="rounded bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-700"
            >
              Recarregar aplicação
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export { BrowserFallback } from "./BrowserFallback"
