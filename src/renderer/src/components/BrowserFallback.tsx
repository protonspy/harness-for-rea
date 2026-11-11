export function BrowserFallback() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-neutral-950 p-6 text-center text-neutral-200">
      <div className="max-w-md rounded-lg border border-neutral-800 bg-neutral-900/90 p-6 shadow-xl">
        <div className="mb-3 flex justify-center">
          <span className="rounded-full bg-neutral-800 px-3 py-1 font-mono text-xs text-neutral-400">desktop runtime required</span>
        </div>
        <h1 className="mb-2 text-2xl font-bold tracking-tight text-neutral-100">Harness for REA</h1>
        <p className="mb-4 text-sm leading-relaxed text-neutral-400">
          Este é um aplicativo desktop construído em Electron. Ele não opera diretamente como aplicação web em abas de navegadores externos.
        </p>
        <div className="rounded border border-neutral-800 bg-neutral-950/80 p-3 text-left text-xs text-neutral-400">
          <p className="mb-1 font-semibold text-neutral-300">Como utilizar:</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              A janela desktop do Electron é inicializada via <code className="text-neutral-200">npm run dev</code> ou{" "}
              <code className="text-neutral-200">npm run start</code>.
            </li>
            <li>
              O terminal interativo (TUI) é acessível via <code className="text-neutral-200">npm run tui</code>.
            </li>
            <li>
              O endereço <code className="text-neutral-200">localhost:5173</code> funciona exclusivamente como servidor de assets HMR para a janela nativa do
              Electron.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
