import { useEffect, useRef, useState } from "react"
import { useApp, useScreen } from "../app/context"
import { openProjects, pickTask } from "../app/pickers"
import { SelectDialog } from "../components/dialogs"
import { safe } from "../components/ui"
import { launchPlan, matchProjects, riskOf } from "../lib/launch"

/*
  What the TUI opens first for the folder it was run in (specs/tui-launch R1, R2): the setup when it is not completed,
  then the folder's project, a choice among several, or the new-project screen prefilled for it, with the typed
  confirmation for a broad folder and the refusal of the data folder.
*/

export function LaunchScreen() {
  const app = useApp()
  const { theme, where } = app
  const [note, setNote] = useState("Opening…")
  const ran = useRef(false)
  useScreen({
    title: safe(where.folder),
    commands: [{ name: "projects", title: "Open any project", run: () => void openProjects(app) }],
  })

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    void (async () => {
      const [settings, projects] = await Promise.all([app.attempt(() => app.api.getSettings()), app.attempt(() => app.api.listProjects())])
      if (!settings || !projects) return setNote("The app could not read its data. /projects lists what it has.")
      const plan = launchPlan({
        folder: where.folder,
        platform: where.platform,
        projects,
        risk: riskOf(where.folder, where),
        setupCompleted: settings.setupCompleted,
        continue: app.args.continue,
        resume: app.args.resume,
      })
      switch (plan.kind) {
        case "setup":
          return app.go({ kind: "setup", then: { kind: "launch" } })
        case "refuse":
          return setNote(`${plan.why} Run harness-for-rea in the folder you want to analyse, or give its path.`)
        case "create":
          return app.go({ kind: "new-project", target: where.folder, confirm: plan.confirm })
        case "open": {
          if (plan.then === "continue") {
            const p = await app.attempt(() => app.api.getProject(plan.projectId))
            const last = p?.tasks[0]
            if (last) return app.go({ kind: "task", id: last.id })
            app.toast("This project has no task to continue yet.", "info")
          } else if (plan.then === "resume") {
            const id = await pickTask(app, plan.projectId)
            if (id) return app.go({ kind: "task", id })
          }
          return app.go({ kind: "project", id: plan.projectId })
        }
        case "pick": {
          const matches = matchProjects(projects, where.folder, where.platform)
          const id = await app.dialog<string>((done) => (
            <SelectDialog
              title="Several projects have this folder as their target"
              items={[
                ...matches.map((p) => ({ id: p.id, label: p.name, detail: `${p.goal} · ${p.model}` })),
                { id: "+new", label: "+ Create another project on it" },
              ]}
              done={done}
            />
          ))
          if (id === "+new") return app.go({ kind: "new-project", target: where.folder, confirm: null })
          if (id) return app.go({ kind: "project", id })
          return setNote("Pick a project with /projects, or create one with /new.")
        }
      }
    })()
    // Run once: the guard keeps a new `app` (a route change) from planning again.
  }, [app, where])

  return (
    <box flexDirection="column">
      <text fg={theme.foreground}>{safe(note)}</text>
    </box>
  )
}
