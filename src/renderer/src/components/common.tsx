import type { HTMLAttributes, ReactNode } from "react"
import { CardAction, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/cn"

/* The app's own small pieces, composed from the shadcn/ui components. */

/** A card's header row: a title and, on the right, its actions. */
export function PanelHeader({ title, actions, className }: { title: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <CardHeader className={className}>
      <CardTitle>{title}</CardTitle>
      {actions && <CardAction>{actions}</CardAction>}
    </CardHeader>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Label className="flex-col items-stretch gap-1.5 leading-normal">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs leading-snug text-muted-foreground">{hint}</span>}
    </Label>
  )
}

export function Mono({ className, ...p }: HTMLAttributes<HTMLElement>) {
  return <code className={cn("font-mono text-[12px]", className)} {...p} />
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{children}</p> : null
}
