/* Imports nothing, so the build config can load it too. */

/**
  The Content Security Policy for the renderer: scripts only from the app itself. `dev` allows the
  Vite dev server's origin, its websocket and the inline React refresh preamble, during development only.
*/
export function contentSecurityPolicy(dev?: string): string {
  const self = dev ? `'self' ${dev}` : "'self'"
  const script = dev ? `${self} 'unsafe-inline'` : self
  const connect = dev ? `'self' ${dev} ${dev.replace(/^http/, "ws")}` : "'self'"
  return [
    "default-src 'none'",
    `script-src ${script}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data:`,
    `font-src ${self} data:`,
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ")
}
