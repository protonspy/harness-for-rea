import { ArrowRight, Bot, CheckCircle2, Circle, Container, Loader2, Sparkles } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type { Readiness, ReadinessStep, Settings } from "@shared/types"
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
  const [settings, setSettings] = useState<Settings | null>(null)
  const [keyRev, setKeyRev] = useState(0)
  const [error, setError] = useState("")
  const [checking, setChecking] = useState(false)
  const checkSeqRef = useRef(0)

  const queryReadiness = useCallback(() => {
    const seq = ++checkSeqRef.current
    return api.readiness().then(
      (nextR) => {
        if (seq === checkSeqRef.current) {
          setR(nextR)
          setError("")
          setChecking(false)
        }
      },
      (e: unknown) => {
        if (seq === checkSeqRef.current) {
          setError(message(e))
          setChecking(false)
        }
      },
    )
  }, [api])

  const check = useCallback(() => {
    setChecking(true)
    return queryReadiness()
  }, [queryReadiness])

  const onSettingsChange = useCallback(
    (updated: Settings) => {
      setSettings(updated)
      setKeyRev((k) => k + 1)
      void check()
    },
    [check],
  )

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void queryReadiness()
    // The image build and the sign-in report as they move; each report may change a step.
    return window.hfr.onPush((p) => {
      if (p.type === "sandbox" || p.type === "login") void queryReadiness()
    })
  }, [api, queryReadiness])

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
        checking={checking}
        what="Docker Engine (or Docker Desktop, including WSL) running, and the images with Claude Code, REA, Ghidra and the Android tools."
      >
        <SandboxPanel onChange={check} />
      </Step>
      <Step
        n={2}
        icon={<Sparkles size={16} />}
        title="Specialist"
        step={
          r?.claude &&
          settings?.specialistProvider &&
          (settings.specialistProvider === "claude" ? !r.claude.provider : r.claude.provider === settings.specialistProvider)
            ? r.claude
            : undefined
        }
        checking={checking}
        what="The model that does the deep analysis: a provider's, Hopper by default, or Claude Code on your Claude plan."
      >
        <SpecialistPanel
          settings={settings}
          onSettingsChange={onSettingsChange}
          keyRev={keyRev}
          onChange={() => {
            setKeyRev((k) => k + 1)
            void check()
          }}
          claude={<ClaudePanel onChange={check} />}
        />
      </Step>
      <Step
        n={3}
        icon={<Bot size={16} />}
        title="The orchestrator's model"
        step={r?.model}
        checking={checking}
        what="An OpenAI-compatible model that plans each task, writes code and briefs the specialist. Hopper is the default provider."
      >
        <ModelPanel
          settings={settings}
          onSettingsChange={onSettingsChange}
          keyRev={keyRev}
          onChange={() => {
            setKeyRev((k) => k + 1)
            void check()
          }}
        />
      </Step>

      <ErrorText>{error}</ErrorText>
      <div className="flex items-center justify-end gap-3">
        {checking && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        <span className="text-sm text-muted-foreground">
          {checking ? "Checking readiness…" : r?.ready ? "Everything is ready." : "Finish each step to continue."}
        </span>
        <Button size="lg" disabled={!r?.ready || checking} onClick={finish}>
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
  checking = false,
  what,
  children,
}: {
  n: number
  icon: ReactNode
  title: string
  step?: ReadinessStep
  checking?: boolean
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
            <Badge variant={ready ? "ok" : checking ? "neutral" : step ? "warn" : "neutral"} className="ml-auto">
              {ready ? "ready" : checking ? "validating…" : step ? "needs you" : "checking"}
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
