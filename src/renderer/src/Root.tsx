import { App } from "./App"
import { BrowserFallback } from "./components/BrowserFallback"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { TooltipProvider } from "./components/ui/tooltip"
import { hasElectronBridge } from "./lib/runtime"

export interface RootProps {
  isElectron?: boolean
}

export function Root({ isElectron = hasElectronBridge() }: RootProps) {
  return (
    <ErrorBoundary>
      <TooltipProvider>{isElectron ? <App /> : <BrowserFallback />}</TooltipProvider>
    </ErrorBoundary>
  )
}
