import type { Goal, ProjectRow, Push, TaskRow } from "@shared/types"

/*
  What the project views show and how they follow pushed changes (specs/projects R4): the goal cards with the ideas
  that fit each goal, and the project list and its tasks kept current from the main process's pushes.
*/

export interface GoalCard {
  goal: Goal
  title: string
  description: string
  /** requests the project view offers to start from (R4.3) */
  ideas: string[]
}

export const GOAL_CARDS: GoalCard[] = [
  {
    goal: "understand",
    title: "Understand and map",
    description: "How it is built, what it does, and how its parts and the outside world talk to each other.",
    ideas: ["Map the architecture and its main modules", "Find how it talks to its servers", "List the file formats it reads and writes"],
  },
  {
    goal: "reimplement",
    title: "Reimplement or port",
    description: "Code of your own that behaves as it does, from contracts, constants and test vectors.",
    ideas: ["Recover this algorithm with test vectors I can check", "Port its save or config format to TypeScript", "Reimplement its network protocol client"],
  },
  {
    goal: "integrate",
    title: "Integrate with my code",
    description: "Its interfaces, formats and protocols, and how your code can call or speak them.",
    ideas: ["Describe its public API and how to call it", "Document the protocol between its client and server", "Write an adapter for it in my code"],
  },
  {
    goal: "debug",
    title: "Debug it",
    description: "Why it behaves as it does in the case you describe, and what would change it.",
    ideas: ["Find why it crashes on start", "Trace where this error comes from", "Explain why this feature stopped working"],
  },
]

export function goalCard(goal: Goal): GoalCard {
  return GOAL_CARDS.find((g) => g.goal === goal) ?? GOAL_CARDS[0]
}

/** The project list, newest first, with a pushed project added, replaced or removed. */
export function foldProjects(list: ProjectRow[], p: Push): ProjectRow[] {
  if (p.type === "projectDeleted") return list.filter((x) => x.id !== p.id)
  if (p.type !== "project") return list
  const rest = list.filter((x) => x.id !== p.project.id)
  return [p.project, ...rest].sort((a, b) => b.createdAt - a.createdAt)
}

/** A project's tasks, newest first, from the task list. */
export function tasksOf(tasks: TaskRow[], projectId: string): TaskRow[] {
  return tasks.filter((t) => t.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)
}

/** A project's default name: its target's file or folder name, without an extension. */
export function nameFrom(path: string): string {
  const last =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? ""
  return last.replace(/\.[^.]{1,8}$/, "") || last
}

/** A file size for the eye. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
