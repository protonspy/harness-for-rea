import { Check, X } from "lucide-react"
import { useState } from "react"
import type { PatchView } from "@shared/types"
import { Badge, Button, Card, CardHeader, Mono } from "@/components/ui"
import { cn } from "@/lib/cn"
import { diffLines } from "@/lib/format"

/* A proposed patch: its files and diff, approved or rejected by the user (specs/desktop-ui R2.4). */

const LINE: Record<string, string> = {
  add: "bg-ok/10 text-ok",
  del: "bg-bad/10 text-bad",
  hunk: "text-accent",
  file: "text-muted font-semibold",
  ctx: "text-ink/80",
}

export function PatchReview({ patch, onDecide }: { patch: PatchView; onDecide(d: "approve" | "reject"): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const decide = async (d: "approve" | "reject") => {
    setBusy(true)
    await onDecide(d)
    setBusy(false)
  }
  return (
    <Card className="border-warn/50">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Badge tone="warn">approval needed</Badge> The specialist proposes changes to {patch.files.length} file(s)
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Button variant="bad" size="sm" disabled={busy} onClick={() => decide("reject")}>
              <X size={14} /> Reject
            </Button>
            <Button variant="ok" size="sm" disabled={busy} onClick={() => decide("approve")}>
              <Check size={14} /> Approve and apply
            </Button>
          </div>
        }
      />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-sm">
        {patch.files.map((f) => (
          <li key={f.path} className="flex items-center gap-1.5">
            <Badge>{f.status}</Badge>
            <Mono>{f.path}</Mono>
            <span className="font-mono text-xs text-ok">+{f.added}</span>
            <span className="font-mono text-xs text-bad">-{f.removed}</span>
          </li>
        ))}
      </ul>
      <pre className="m-4 max-h-[420px] overflow-auto rounded-md border border-line bg-bg py-2 font-mono text-[12px] leading-5">
        {diffLines(patch.diff).map((l, i) => (
          <div key={i} className={cn("px-3 whitespace-pre", LINE[l.kind])}>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </Card>
  )
}
