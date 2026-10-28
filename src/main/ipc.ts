import { API_SCHEMAS, type ApiMethod, type Handlers } from "@shared/api"

/*
  Every renderer call goes through `dispatch`: the frame must be the app's page, the method must
  be in the contract, and the arguments must parse against its schema before the handler runs.
*/

export class IpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IpcError"
  }
}

/** Whether `url` is the app's page — same origin and path, any query or hash. */
export function isAppPage(url: string, page: string): boolean {
  try {
    const u = new URL(url)
    const p = new URL(page)
    return u.protocol === p.protocol && u.host === p.host && u.pathname === p.pathname
  } catch {
    return false
  }
}

export function makeDispatcher(handlers: Handlers, page: () => string) {
  return async (frameUrl: string, method: unknown, args: unknown[]): Promise<unknown> => {
    if (!isAppPage(frameUrl, page())) throw new IpcError("Call rejected: it did not come from the app's page.")
    if (typeof method !== "string" || !Object.hasOwn(API_SCHEMAS, method))
      throw new IpcError(`Call rejected: ${String(method).slice(0, 60)} is not an API method.`)
    const m = method as ApiMethod
    const parsed = API_SCHEMAS[m].safeParse(args)
    if (!parsed.success)
      throw new IpcError(
        `Call rejected: invalid arguments for ${m}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"} ${i.message}`).join("; ")}`,
      )
    const handler = handlers[m] as (...a: unknown[]) => unknown
    return handler(...(parsed.data as unknown[]))
  }
}
