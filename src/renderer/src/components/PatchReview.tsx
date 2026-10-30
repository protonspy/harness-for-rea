import { Check, X } from "lucide-react"
import { useState } from "react"
import type { PatchView } from "@shared/types"
import { Mono, PanelHeader } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/cn"
import { diffLines } from "@/lib/format"

/* A proposed patch: its files and diff, approved or rejected by the user (specs/desktop-ui R2.4). */

const LINE: Record<string, string> = {
  add: "bg-success/10 text-success",
  del: "bg-destructive/10 text-destructive",
  hunk: "text-primary",
  file: "text-muted-foreground font-semibold",
  ctx: "text-foreground/80",
}

export function PatchReview({ patch, onDecide }: { patch: PatchView; onDecide(d: "approve" | "reject"): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const decide = async (d: "approve" | "reject") => {
    setBusy(true)
    await onDecide(d)
    setBusy(false)
  }
  return (
    <Card className="border-warning/50">
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <Badge variant="warn">approval needed</Badge> The specialist proposes changes to {patch.files.length} file(s)
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => decide("reject")}>
              <X size={14} /> Reject
            </Button>
            <Button variant="success" size="sm" disabled={busy} onClick={() => decide("approve")}>
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
            <span className="font-mono text-xs text-success">+{f.added}</span>
            <span className="font-mono text-xs text-destructive">-{f.removed}</span>
          </li>
        ))}
      </ul>
      <pre className="m-4 max-h-[420px] overflow-auto rounded-md border border-border bg-background py-2 font-mono text-[12px] leading-5">
        {diffLines(patch.diff).map((l, i) => (
          <div key={i} className={cn("px-3 whitespace-pre", LINE[l.kind])}>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </Card>
  )
}
