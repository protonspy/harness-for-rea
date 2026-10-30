import { Check, Pencil, ShieldAlert, X } from "lucide-react"
import { useState } from "react"
import type { ToolDecision } from "@shared/chat"
import type { PatchView } from "@shared/types"
import { ErrorText, Mono } from "@/components/common"
import { PatchReview } from "@/components/PatchReview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { parseArgs, type ApprovalItem, type GatedCall } from "@/lib/chat"

/*
  Gated tool calls waiting on the user (specs/chat R4.3, R7.3): each shown with its arguments and
  approved, edited or rejected; a patch shows its diff and is approved or rejected as proposed.
*/

type Decide = (callId: string, d: ToolDecision) => Promise<void>

export function ApprovalCard({ item, patches, onDecide }: { item: ApprovalItem; patches: PatchView[]; onDecide: Decide }) {
  return (
    <div className="ml-10 flex flex-col gap-2">
      {item.calls.map((c) => {
        const patch = c.name === "apply_patch" ? patches.find((p) => p.id === c.args.patchId) : undefined
        if (c.decision) return <Decided key={c.callId} call={c} />
        if (patch) return <PatchReview key={c.callId} patch={patch} onDecide={(d) => onDecide(c.callId, { type: d })} />
        return <PendingCall key={c.callId} call={c} onDecide={onDecide} />
      })}
    </div>
  )
}

function Decided({ call }: { call: GatedCall }) {
  const d = call.decision!
  const variant = d.type === "approve" ? "ok" : d.type === "edit" ? "info" : "bad"
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <ShieldAlert size={13} />
      <Mono className="text-foreground">{call.name}</Mono>
      <Badge variant={variant}>{d.type === "approve" ? "approved" : d.type === "edit" ? "edited" : "rejected"}</Badge>
      {call.origin && call.origin !== "user" && <span>({call.origin})</span>}
      {d.type === "reject" && d.message && <span className="truncate">“{d.message}”</span>}
    </div>
  )
}

function PendingCall({ call, onDecide }: { call: GatedCall; onDecide: Decide }) {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view")
  const [args, setArgs] = useState(() => JSON.stringify(call.args, null, 2))
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const decide = async (d: ToolDecision) => {
    setBusy(true)
    setError("")
    try {
      await onDecide(call.callId, d)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const saveEdit = () => {
    const parsed = parseArgs(args)
    if ("error" in parsed) setError(parsed.error)
    else void decide({ type: "edit", args: parsed.args })
  }

  return (
    <Card className="border-warning/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Badge variant="warn">approval needed</Badge>
          <span>
            The orchestrator wants to run <Mono>{call.name}</Mono>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {mode === "edit" ? (
          <Textarea
            aria-label="Arguments"
            rows={Math.min(14, args.split("\n").length + 1)}
            className="font-mono text-xs"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        ) : (
          <pre className="max-h-64 overflow-auto rounded border bg-background p-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap break-all">
            {JSON.stringify(call.args, null, 2)}
          </pre>
        )}
        {mode === "reject" && (
          <Input
            autoFocus
            aria-label="Why"
            placeholder="Why not, or what to do instead (optional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        )}
        <ErrorText>{error}</ErrorText>
      </CardContent>
      <CardFooter className="justify-end">
        {mode === "view" && (
          <>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setMode("reject")}>
              <X size={14} /> Reject
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setMode("edit")}>
              <Pencil size={13} /> Edit
            </Button>
            <Button size="sm" variant="success" disabled={busy} onClick={() => decide({ type: "approve" })}>
              <Check size={14} /> Approve
            </Button>
          </>
        )}
        {mode !== "view" && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => (setMode("view"), setError(""))}>
            Back
          </Button>
        )}
        {mode === "edit" && (
          <Button size="sm" variant="default" disabled={busy} onClick={saveEdit}>
            <Check size={14} /> Run with these arguments
          </Button>
        )}
        {mode === "reject" && (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => decide(message.trim() ? { type: "reject", message: message.trim() } : { type: "reject" })}
          >
            <X size={14} /> Reject
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
