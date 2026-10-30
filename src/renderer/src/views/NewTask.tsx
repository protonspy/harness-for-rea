import { FolderOpen, Play } from "lucide-react"
import { useEffect, useState } from "react"
import { ALWAYS_GATED, GATEABLE_TOOLS, type GateableTool } from "@shared/chat"
import type { KeyStatus, SandboxStatus, TaskRow } from "@shared/types"
import { ErrorText, Field } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

/* Start a task: the request, the source folder it is about, and the tools you approve before they run (specs/desktop-ui R2.1, specs/chat R4.1). */

const GATE_LABELS: Record<GateableTool, string> = {
  apply_patch: "Apply a patch to your files — always asked",
  delegate_to_specialist: "Delegate a step to the specialist",
  execute: "Run a command in the task's sandbox",
  write_file: "Write a file in the scratch area",
  edit_file: "Edit a file in the scratch area",
}

export function NewTask({ onStarted, onSettings }: { onStarted(t: TaskRow): void; onSettings(): void }) {
  const [request, setRequest] = useState("")
  const [folder, setFolder] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [gated, setGated] = useState<GateableTool[]>([ALWAYS_GATED])
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
      onStarted(await window.hfr.api.startTask({ request, sourceRoot: folder, gated }))
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
          needs. You stay in the conversation: follow up while it works, answer its questions, and approve what you choose. Nothing in the folder changes
          without your approval.
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
        <Field label="Ask me before" hint="The run pauses at each of these until you approve, edit or reject the call.">
          <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
            {GATEABLE_TOOLS.map((t) => (
              <Label key={t} className="font-normal">
                <Checkbox
                  checked={t === ALWAYS_GATED || gated.includes(t)}
                  disabled={t === ALWAYS_GATED}
                  onCheckedChange={(v) => setGated((g) => (v === true ? [...new Set([...g, t])] : g.filter((x) => x !== t)))}
                />
                {GATE_LABELS[t]}
              </Label>
            ))}
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
