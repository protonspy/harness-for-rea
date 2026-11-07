import { Bug, Check, Code2, FileSearch, FolderOpen, FolderTree, Map as MapIcon, Plug, Rocket, type LucideIcon } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { PROVIDERS, getAvailableEffortsForModel } from "@shared/providers"
import { SPECIALIST_EFFORTS, type Goal, type OrchestratorEffort, type ProjectRow, type Settings, type SpecialistEffort, type TargetInfo } from "@shared/types"
import { ErrorText, Field } from "@/components/common"
import { ModelPicker } from "@/components/setup/ModelPicker"
import { EffortSelect, message } from "@/components/setup/panels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/cn"
import { bytes, GOAL_CARDS, nameFrom } from "@/lib/projects"

/*
  The guided setup of a new project (specs/projects R4.2, R1.6): the target with the kind the app detects, the goal as
  cards, then the name, model, efforts and folder, with the defaults filled in. Create is enabled once the target and
  the goal are chosen.
*/

const GOAL_ICONS: Record<Goal, LucideIcon> = { understand: MapIcon, reimplement: Code2, integrate: Plug, debug: Bug }

export function NewProject({ onCreated }: { onCreated(p: ProjectRow): void }) {
  const api = window.hfr.api
  const [target, setTarget] = useState<TargetInfo | null>(null)
  const [goal, setGoal] = useState<Goal | null>(null)
  const [name, setName] = useState("")
  const [settings, setSettings] = useState<Settings | null>(null)
  const [model, setModel] = useState("")
  const [orchestratorEffort, setOrchestratorEffort] = useState<OrchestratorEffort>("default")
  const [specialistEffort, setSpecialistEffort] = useState<SpecialistEffort>("default")
  const [parentFolder, setParentFolder] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.getSettings().then((s) => {
      setSettings(s)
      setModel(s.model)
      setOrchestratorEffort(s.orchestratorEffort)
      setSpecialistEffort(s.specialistEffort)
    })
    void api.listModels().then(setModels, () => undefined)
  }, [api])

  const choose = async (kind: "file" | "folder") => {
    setError("")
    try {
      const path = await api.pickTarget(kind)
      if (!path) return
      const t = await api.detectTarget(path)
      setTarget(t)
      setName((n) => n || nameFrom(path))
    } catch (e) {
      setError(message(e))
    }
  }

  const create = async () => {
    if (!target || !goal || !settings) return
    setBusy(true)
    setError("")
    try {
      onCreated(
        await api.createProject({
          name: name || nameFrom(target.path),
          goal,
          target: target.path,
          provider: settings.provider,
          model,
          orchestratorEffort,
          specialistEffort,
          parentFolder,
        }),
      )
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A project is one target. Its tasks share its sandboxes, what they extract and everything the specialist finds, so each task starts from what the last
          ones learned.
        </p>
      </header>

      <Section n={1} title="What do you want to look into?" done={!!target}>
        <div className="grid grid-cols-2 gap-3">
          <ChoiceCard
            icon={FileSearch}
            title="A file"
            description="An APK, a binary, a DLL, an archive or a firmware image. The project keeps its own copy."
            onClick={() => choose("file")}
          />
          <ChoiceCard
            icon={FolderTree}
            title="A folder"
            description="An installed app, a repository or an unpacked bundle. Read in place, never written."
            onClick={() => choose("folder")}
          />
        </div>
        {target && (
          <Card className="flex flex-col gap-2 border-primary/40 bg-primary/5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info">{target.label}</Badge>
              {target.isFile && <span className="text-xs text-muted-foreground">{bytes(target.size)}</span>}
              <span className="truncate font-mono text-xs text-muted-foreground" title={target.path}>
                {target.path}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              The specialist will work with
              {target.engines.map((e) => (
                <Badge key={e} variant="neutral">
                  {e}
                </Badge>
              ))}
            </div>
          </Card>
        )}
      </Section>

      <Section n={2} title="What do you want to do with it?" done={!!goal}>
        <div className="grid grid-cols-2 gap-3">
          {GOAL_CARDS.map((g) => (
            <ChoiceCard
              key={g.goal}
              icon={GOAL_ICONS[g.goal]}
              title={g.title}
              description={g.description}
              selected={goal === g.goal}
              onClick={() => setGoal(g.goal)}
            />
          ))}
        </div>
      </Section>

      <Section n={3} title="Name it and choose how it runs" done={!!target && !!goal}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={target ? nameFrom(target.path) : "My project"} maxLength={80} />
          </Field>
          <Field label={`Model (${settings ? PROVIDERS[settings.provider].label : ""})`} hint="The orchestrator's model for this project's tasks.">
            {settings && <ModelPicker provider={settings.provider} value={model} listed={models} onChange={setModel} />}
          </Field>
          <Field label="Orchestrator effort">
            <EffortSelect
              value={orchestratorEffort}
              options={settings ? getAvailableEffortsForModel(settings.provider, model) : []}
              onChange={(v) => setOrchestratorEffort(v)}
            />
          </Field>
          <Field label="Specialist effort" hint="Higher thinks longer and uses more of your Claude plan.">
            <EffortSelect value={specialistEffort} options={SPECIALIST_EFFORTS} onChange={(v) => setSpecialistEffort(v)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <FolderOpen size={14} />
          Saved in
          <span className="font-mono text-xs text-foreground">{parentFolder ? `${parentFolder}\\…` : "a new folder in the app's data"}</span>
          <Button
            size="sm"
            variant="link"
            onClick={async () => {
              const f = await api.pickFolder()
              if (f) setParentFolder(f)
            }}
          >
            Choose a folder…
          </Button>
          {parentFolder && (
            <Button size="sm" variant="ghost" onClick={() => setParentFolder(null)}>
              Use the app's data
            </Button>
          )}
        </div>
      </Section>

      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end">
        <Button size="lg" disabled={!target || !goal || !model.trim() || busy} onClick={create}>
          <Rocket size={15} /> Create the project
        </Button>
      </div>
    </div>
  )
}

function Section({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex size-7 items-center justify-center rounded-full border text-xs font-semibold",
            done ? "border-success/50 text-success" : "border-border",
          )}
        >
          {done ? <Check size={14} /> : n}
        </div>
        <h2 className="font-semibold">{title}</h2>
      </div>
      {children}
    </Card>
  )
}

function ChoiceCard({
  icon: Icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: LucideIcon
  title: string
  description: string
  selected?: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent",
        selected && "border-primary bg-primary/10",
      )}
    >
      <Icon size={18} className={cn("mt-0.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-medium">
          {title}
          {selected && <Check size={14} className="ml-auto text-primary" />}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}
