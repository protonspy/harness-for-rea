import { cva, type VariantProps } from "class-variance-authority"
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react"
import { cn } from "@/lib/cn"
import type { Tone } from "@/lib/format"

/* The handful of primitives the views share, in the shadcn/ui style. */

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-accent text-bg hover:bg-accent/85",
        ghost: "text-ink hover:bg-raised",
        outline: "border border-line text-ink hover:bg-raised",
        ok: "bg-ok/90 text-bg hover:bg-ok",
        bad: "border border-bad/60 text-bad hover:bg-bad/10",
      },
      size: { sm: "h-7 px-2.5", md: "h-9 px-3.5" },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
)

export function Button({ className, variant, size, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...p} />
}

const tones: Record<Tone, string> = {
  neutral: "bg-raised text-muted border-line",
  info: "bg-accent/10 text-accent border-accent/30",
  warn: "bg-warn/10 text-warn border-warn/30",
  ok: "bg-ok/10 text-ok border-ok/30",
  bad: "bg-bad/10 text-bad border-bad/30",
}

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide", tones[tone], className)}>
      {children}
    </span>
  )
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-panel", className)} {...p} />
}

export function CardHeader({ title, actions, className }: { title: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-line px-4 py-2.5", className)}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {actions}
    </div>
  )
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn("h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none placeholder:text-muted focus:border-accent", className)}
      {...p}
    />
  )
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent", className)}
      {...p}
    />
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}

export function Mono({ className, ...p }: HTMLAttributes<HTMLElement>) {
  return <code className={cn("font-mono text-[12px]", className)} {...p} />
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{children}</p> : null
}
