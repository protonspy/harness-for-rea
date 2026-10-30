import { FolderOpen, Play } from "lucide-react"
import { useEffect, useState } from "react"
import type { KeyStatus, SandboxStatus, TaskRow } from "@shared/types"
import { ErrorText, Field } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

/* Start a task: the request and the source folder it is about; every tool call runs without asking (specs/desktop-ui R2.1, specs/chat R4.1). */

export function NewTask({ onStarted, onSettings }: { onStarted(t: TaskRow): void; onSettings(): void }) {
  const [request, setRequest] = useState("")
  const [folder, setFolder] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState<KeyStatus | null>(null)
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)

  useEffect(() => {
    void window.hfr.api.keyStatus().then(setKey)
    void window.hfr.api.sandboxStatus().then(setSandbox)
  }, [])

  const pick = async () => {
    const f = await window.hfr.api.pickFolder()
    if (f) setFolder(f)
  }

  const start = async () => {
    setBusy(true)
    setError("")
    try {
      onStarted(await window.hfr.api.startTask({ request, sourceRoot: folder }))
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method 'api': (Error: )?/, ""))
    } finally {
      setBusy(false)
    }
  }

  const missing = [!key?.set && "an OpenRouter key", sandbox && !(sandbox.docker && sandbox.images) && "a running Docker with the sandbox images"].filter(
    Boolean,
  )

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New task</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the engineering task. The orchestrator plans it and delegates every analysis to Claude Opus in a sandbox that sees only the files each step
          needs. You stay in the conversation: follow up while it works, stop it, and answer its questions. Every tool call runs without asking, including
          patches to the folder.
        </p>
      </div>
      {missing.length > 0 && (
        <Card className="flex items-center justify-between gap-3 border-warning/40 px-4 py-3 text-sm">
          <span>Before delegating, set up {missing.join(" and ")}.</span>
          <Button size="sm" onClick={onSettings}>
            Open settings
          </Button>
        </Card>
      )}
      <Card className="flex flex-col gap-4 p-5">
        <Field label="Request">
          <Textarea
            rows={8}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="e.g. The invoice export rounds totals wrong for multi-currency orders. Find the cause in the legacy billing module and propose a fix."
          />
        </Field>
        <Field label="Source folder" hint="Read-only for the orchestrator; the specialist gets copies of the files it is given.">
          <div className="flex gap-2">
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\path\to\repository" />
            <Button onClick={pick} aria-label="Pick folder">
              <FolderOpen size={15} />
            </Button>
          </div>
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end">
          <Button variant="default" disabled={busy || !request.trim() || !folder.trim()} onClick={start}>
            <Play size={14} /> Start task
          </Button>
        </div>
      </Card>
    </div>
  )
}
