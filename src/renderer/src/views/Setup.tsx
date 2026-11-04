import { ArrowRight, Bot, CheckCircle2, Circle, Container, Loader2, Sparkles } from "lucide-react"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import type { Readiness, ReadinessStep } from "@shared/types"
import { ErrorText } from "@/components/common"
import { ClaudePanel, message, ModelPanel, SandboxPanel, SpecialistPanel } from "@/components/setup/panels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/cn"

/*
  The first-run setup (specs/onboarding R1): three steps in order — the sandbox, Claude Code on the user's plan,
  and the orchestrator's model — each with its state, what it needs and the panel that readies it. Finishing is
  possible once all three are ready, and opens the projects.
*/

export function SetupView({ onDone, again = false }: { onDone(): void; again?: boolean }) {
  const api = window.hfr.api
  const [r, setR] = useState<Readiness | null>(null)
  const [error, setError] = useState("")
  // A step is "checking" until the first answer comes back.
  const checking = r === null

  const check = useCallback(
    () =>
      api.readiness().then(setR, (e: unknown) => {
        setError(message(e))
      }),
    [api],
  )
  useEffect(() => {
    void check()
    // The image build and the sign-in report as they move; each report may change a step.
    return window.hfr.onPush((p) => {
      if (p.type === "sandbox" || p.type === "login") void check()
    })
  }, [check])

  const finish = async () => {
    setError("")
    try {
      await api.completeSetup()
      onDone()
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-start gap-4">
        <img src="./icon.png" alt="" className="size-12 rounded-xl" onError={(e) => (e.currentTarget.style.display = "none")} />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{again ? "Setup" : "Welcome to Harness for REA"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Three things before your first project: the sandbox the specialist works in, the model the specialist runs on, and the model that plans the work.
          </p>
        </div>
      </header>

      <Step
        n={1}
        icon={<Container size={16} />}
        title="The sandbox"
        step={r?.sandbox}
        what="Docker Desktop running, and the images with Claude Code, REA, Ghidra and the Android tools."
      >
        <SandboxPanel onChange={check} />
      </Step>
      <Step
        n={2}
        icon={<Sparkles size={16} />}
        title="Specialist"
        step={r?.claude}
        what="The model that does the deep analysis: a provider's, Hopper by default, or Claude Code on your Claude plan."
      >
        <SpecialistPanel onChange={check} claude={<ClaudePanel onChange={check} />} />
      </Step>
      <Step
        n={3}
        icon={<Bot size={16} />}
        title="The orchestrator's model"
        step={r?.model}
        what="An OpenAI-compatible model that plans each task, writes code and briefs the specialist. OpenRouter is the default gateway."
      >
        <ModelPanel onChange={check} />
      </Step>

      <ErrorText>{error}</ErrorText>
      <div className="flex items-center justify-end gap-3">
        {checking && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        <span className="text-sm text-muted-foreground">{r?.ready ? "Everything is ready." : "Finish each step to continue."}</span>
        <Button size="lg" disabled={!r?.ready} onClick={finish}>
          {again ? "Done" : "Start using Harness for REA"} <ArrowRight size={15} />
        </Button>
      </div>
    </div>
  )
}

function Step({
  n,
  icon,
  title,
  step,
  what,
  children,
}: {
  n: number
  icon: ReactNode
  title: string
  step?: ReadinessStep
  what: string
  children: ReactNode
}) {
  const ready = step?.ready === true
  return (
    <Card className={cn("overflow-hidden transition-colors", ready && "border-success/40")}>
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
            ready ? "border-success/50 text-success" : "border-border",
          )}
        >
          {ready ? <CheckCircle2 size={16} /> : n}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{icon}</span>
            <h2 className="font-semibold">{title}</h2>
            <Badge variant={ready ? "ok" : step ? "warn" : "neutral"} className="ml-auto">
              {ready ? "ready" : step ? "needs you" : "checking"}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{what}</p>
          {step && !ready && step.reason && (
            <p className="mt-1.5 flex items-center gap-1.5 text-sm text-warning">
              <Circle size={8} className="fill-current" /> {step.reason}
            </p>
          )}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </Card>
  )
}
