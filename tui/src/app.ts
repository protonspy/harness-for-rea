import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"
import type { Api } from "../../src/shared/api"
import { GOALS, type Goal, type Push, type StepRow, type TaskHistory } from "../../src/shared/types"
import { blocks } from "../../src/renderer/src/lib/chat"
import { fold } from "../../src/renderer/src/lib/store"
import { Timeline } from "../../src/renderer/src/lib/timeline"
import { terminalSafe, projectLabel, projectLines, questionLines, readAnswer, readCommand, setupLines, taskLabel, timelineLines, waiting } from "./view"

/*
  The TUI's screens on OpenTUI (specs/tui R2, R3): setup, projects, one project, one task. Each is a header, a
  scrolling body, a list where there is something to pick, and one input line whose meaning follows the screen —
  a command, an answer to the question that waits, or a message to the task. Tab moves between the list and the
  input, Escape goes back, Ctrl+C quits.
*/

type Screen = { kind: "setup" } | { kind: "projects" } | { kind: "project"; id: string } | { kind: "task"; id: string; projectId: string | null }

const PAGE = 400
const HELP: Record<Screen["kind"], string> = {
  setup: "/images · /login · /code <code> · /key <key> · /model <id> · /done · Ctrl+C quits",
  projects: "Enter opens · /new <name> | <goal> | <target path> creates · Tab list/input · Ctrl+C quits",
  project: "type a request to start a task · Enter opens a task · Esc back",
  task: "type a message, or the answer to the question · /stop · /cancel · /continue · /older · Esc back",
}

export class App {
  private screen: Screen = { kind: "projects" }
  private readonly header: TextRenderable
  private readonly body: TextRenderable
  private readonly scroll: ScrollBoxRenderable
  private readonly list: SelectRenderable
  private readonly status: TextRenderable
  private readonly input: InputRenderable
  private listIds: string[] = []
  private history: TaskHistory | null = null
  private timeline: Timeline | null = null

  constructor(
    r: CliRenderer,
    private readonly api: Api,
    private readonly quit: () => void,
  ) {
    const root = new BoxRenderable(r, { id: "root", flexDirection: "column", width: "100%", height: "100%" })
    this.header = new TextRenderable(r, { id: "header", content: "Harness for REA", fg: "#7dd3fc" })
    this.scroll = new ScrollBoxRenderable(r, { id: "scroll", flexGrow: 1, stickyScroll: true, stickyStart: "bottom" })
    this.body = new TextRenderable(r, { id: "body", content: "", wrapMode: "word" })
    this.scroll.add(this.body)
    this.list = new SelectRenderable(r, { id: "list", height: 8, options: [], showDescription: false })
    this.status = new TextRenderable(r, { id: "status", content: "", fg: "#a3a3a3" })
    this.input = new InputRenderable(r, { id: "input", placeholder: "…", width: "100%" })
    const box = new BoxRenderable(r, { id: "inputBox", border: true, height: 3 })
    box.add(this.input)
    for (const n of [this.header, this.scroll, this.list, this.status, box]) root.add(n)
    r.root.add(root)

    this.input.on(InputRenderableEvents.ENTER, (value: string) => {
      this.input.value = ""
      void this.submit(value).catch((e: unknown) => this.say((e as Error).message, true))
    })
    this.list.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => void this.pick(index).catch((e: unknown) => this.say((e as Error).message, true)))
    r.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.ctrl && key.name === "c") this.quit()
      else if (key.name === "tab") (this.input.focused && this.list.visible ? this.list : this.input).focus()
      else if (key.name === "escape") void this.back()
    })
    this.input.focus()
  }

  async start(): Promise<void> {
    const s = await this.api.getSettings()
    await this.go(s.setupCompleted ? { kind: "projects" } : { kind: "setup" })
  }

  /** A change from the core: the open task's history folded in, the screen redrawn when it is affected. */
  onPush(p: Push): void {
    const sc = this.screen
    if (sc.kind === "task" && this.history && this.timeline) {
      if (p.type === "event" && p.event.taskId === sc.id) {
        if (this.timeline.append([p.event])) this.drawTask()
      } else if (p.type === "task" || p.type === "step" || p.type === "patch") {
        this.history = fold(this.history, p)
        this.drawTask()
      }
    } else if (
      (sc.kind === "setup" && (p.type === "sandbox" || p.type === "login")) ||
      (sc.kind === "project" && p.type === "task") ||
      (sc.kind === "projects" && p.type === "task")
    )
      void this.go(sc)
  }

  private say(text: string, bad = false) {
    this.status.content = terminalSafe(text)
    this.status.fg = bad ? "#f87171" : "#a3a3a3"
  }

  private show(lines: string[], items: { name: string; id: string }[] | null) {
    this.body.content = terminalSafe(lines.join("\n"))
    this.list.visible = items !== null
    this.listIds = items?.map((i) => i.id) ?? []
    this.list.options = (items ?? []).map((i) => ({ name: i.name, description: "" }))
    this.say(HELP[this.screen.kind])
  }

  private async go(screen: Screen): Promise<void> {
    this.screen = screen
    switch (screen.kind) {
      case "setup": {
        this.header.content = "Harness for REA — first-run setup"
        this.show(setupLines(await this.api.readiness()), null)
        break
      }
      case "projects": {
        this.header.content = "Harness for REA — projects"
        const projects = await this.api.listProjects()
        this.show(
          projects.length ? [] : ["No project yet: /new <name> | <goal> | <target path>", `Goals: ${GOALS.join(", ")}`],
          projects.map((p) => ({ name: projectLabel(p), id: p.id })),
        )
        break
      }
      case "project": {
        const { project, tasks } = await this.api.getProject(screen.id)
        this.header.content = terminalSafe(`Harness for REA — ${project.name}`)
        this.show(
          projectLines(project),
          tasks.map((t) => ({ name: taskLabel(t), id: t.id })),
        )
        break
      }
      case "task": {
        const h = await this.api.getTask(screen.id, { limit: PAGE })
        this.history = { ...h, events: [] }
        this.timeline = new Timeline(h.steps, h.events, !h.hasOlder)
        this.drawTask()
        break
      }
    }
  }

  private drawTask() {
    const h = this.history
    const t = this.timeline
    if (!h || !t) return
    const state = h.turn ?? h.task.state
    this.header.content = terminalSafe(`[${state}] ${h.task.request.replace(/\s+/g, " ").slice(0, 100)}`)
    const steps: StepRow[] = h.steps
    const q = waiting(t.items)
    const lines = [...(t.fromStart ? [] : ["(older events: /older)"]), ...timelineLines(blocks(t.items), steps, (id) => t.run(id))]
    if (q) lines.push("", ...questionLines(q))
    this.show(lines, null)
    if (q) this.say("Type your answer to the question above.")
  }

  private async pick(index: number) {
    const id = this.listIds[index]
    if (!id) return
    if (this.screen.kind === "projects") await this.go({ kind: "project", id })
    else if (this.screen.kind === "project") await this.go({ kind: "task", id, projectId: this.screen.id })
    this.input.focus()
  }

  private async back() {
    const sc = this.screen
    if (sc.kind === "task") await this.go(sc.projectId ? { kind: "project", id: sc.projectId } : { kind: "projects" })
    else if (sc.kind === "project") await this.go({ kind: "projects" })
  }

  private async submit(line: string): Promise<void> {
    const text = line.trim()
    if (!text) return
    const c = readCommand(text)
    const sc = this.screen
    if (c?.command === "back") return this.back()
    switch (sc.kind) {
      case "setup":
        return this.setup(c)
      case "projects":
        if (c?.command === "new") return this.create(c.arg)
        return this.say("Pick a project with Tab and Enter, or /new <name> | <goal> | <target path>.", true)
      case "project": {
        if (c) return this.say(`Unknown command /${c.command}.`, true)
        const t = await this.api.startTask({ projectId: sc.id, request: text })
        return this.go({ kind: "task", id: t.id, projectId: sc.id })
      }
      case "task":
        return this.task(sc.id, text, c)
    }
  }

  private async setup(c: ReturnType<typeof readCommand>) {
    const api = this.api
    switch (c?.command) {
      case "images":
        await api.buildSandbox()
        this.say("Preparing the sandbox images…")
        break
      case "login": {
        const s = await api.startLogin()
        this.say(s.url ? `Open ${s.url} and paste the code with /code <code>.` : "Starting the sign-in…")
        break
      }
      case "code":
        await api.sendLoginCode(c.arg)
        break
      case "key": {
        const { provider } = await api.getSettings()
        await api.saveKey(c.arg, provider)
        break
      }
      case "model":
        await api.saveSettings({ model: c.arg })
        break
      case "done":
        await api.completeSetup()
        return this.go({ kind: "projects" })
      default:
        return this.say("Use /images, /login, /code, /key, /model or /done.", true)
    }
    await this.go({ kind: "setup" })
  }

  private async create(arg: string) {
    const [name, goal, target] = arg.split("|").map((s) => s.trim())
    if (!name || !target || !GOALS.includes(goal as Goal)) return this.say(`Use /new <name> | <goal: ${GOALS.join(", ")}> | <target path>.`, true)
    const s = await this.api.getSettings()
    const p = await this.api.createProject({
      name,
      goal: goal as Goal,
      target,
      provider: s.provider,
      model: s.model,
      orchestratorEffort: s.orchestratorEffort,
      specialistEffort: s.specialistEffort,
    })
    await this.go({ kind: "project", id: p.id })
  }

  private async task(id: string, text: string, c: ReturnType<typeof readCommand>) {
    const api = this.api
    if (c?.command === "stop") return void (await api.stopTurn(id))
    if (c?.command === "cancel") return void (await api.cancelTask(id))
    if (c?.command === "continue") return void (await api.continueTurn(id))
    if (c?.command === "older") return this.older(id)
    if (c) return this.say(`Unknown command /${c.command}.`, true)
    const q = this.timeline ? waiting(this.timeline.items) : undefined
    if (q) {
      const a = readAnswer(q.question, text)
      if ("error" in a) return this.say(a.error, true)
      await api.answerQuestion(id, q.id, a.answer)
      return
    }
    await api.sendMessage(id, text)
  }

  private async older(id: string) {
    const t = this.timeline
    if (!t || t.fromStart) return this.say("The whole history is shown.")
    const page = await this.api.getTask(id, { beforeEvent: t.firstId, limit: PAGE })
    this.timeline = t.prepend(page.events, page.steps, !page.hasOlder)
    this.drawTask()
  }
}
