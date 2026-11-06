import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { BrowserFallback, ErrorBoundary } from "./components/ErrorBoundary"
import { TooltipProvider } from "./components/ui/tooltip"
import { hasElectronBridge } from "./lib/runtime"
import "./index.css"

const isElectron = hasElectronBridge()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>{isElectron ? <App /> : <BrowserFallback />}</TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
)
