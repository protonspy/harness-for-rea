import { z } from "zod"

/*
  What the chat shares between main and renderer (specs/chat R4, R5): the tools a task may gate,
  the decisions on a gated call, and the questions either agent asks the user — their kinds, the
  default each carries, and the cap per turn.
*/

/** The orchestrator's tools a task may choose to pause before they run (R4.1). */
export const GATEABLE_TOOLS = ["apply_patch", "delegate_to_specialist", "execute", "write_file", "edit_file"] as const
export type GateableTool = (typeof GATEABLE_TOOLS)[number]
/** Gated on every task, whatever the user chose. */
export const ALWAYS_GATED: GateableTool = "apply_patch"

export const DecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }).strict(),
  /** the replacement arguments the agent runs instead */
  z.object({ type: z.literal("edit"), args: z.record(z.string(), z.unknown()) }).strict(),
  /** returned to the agent in place of the tool's result */
  z.object({ type: z.literal("reject"), message: z.string().trim().max(4000).optional() }).strict(),
])
export type ToolDecision = z.infer<typeof DecisionSchema>

export const QUESTION_KINDS = ["choice", "yesno", "number", "text"] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]
/** Questions an agent may ask within one turn before every further one returns its default (R5.5). */
export const QUESTION_CAP = 5

export const AnswerSchema = z.union([z.string().max(4000), z.number().finite(), z.boolean()])
export type Answer = z.infer<typeof AnswerSchema>

export const QuestionSchema = z.object({
  prompt: z.string().trim().min(1).max(2000).describe("The question, as the user will read it."),
  reason: z.string().trim().min(1).max(1000).describe("Why the answer is needed now and what it changes."),
  kind: z.enum(QUESTION_KINDS).describe("choice: one of `choices`; yesno: true or false; number; text: free text."),
  choices: z.array(z.string().trim().min(1).max(200)).max(10).optional().describe("The options, for kind choice only."),
  default: AnswerSchema.describe("What is used if the user does not answer in time; it must fit the kind."),
})
export type Question = z.infer<typeof QuestionSchema>

/** Who settled a question or a gated call. */
export type Origin = "user" | "timeout" | "cap" | "stopped"

/** Why the question cannot be asked as it stands, or null (R5.3). */
export function questionProblem(q: Question): string | null {
  switch (q.kind) {
    case "choice":
      if (!q.choices || q.choices.length < 2) return "a choice question needs at least two choices"
      return q.choices.includes(String(q.default)) ? null : "the default must be one of the choices"
    case "yesno":
      return typeof q.default === "boolean" ? null : "a yes/no question's default must be true or false"
    case "number":
      return typeof q.default === "number" ? null : "a number question's default must be a number"
    case "text":
      return typeof q.default === "string" ? null : "a text question's default must be text"
  }
}

/** The answer as the kind calls for it; throws when it does not fit. */
export function checkAnswer(q: Question, a: Answer): Answer {
  const fits =
    q.kind === "choice"
      ? typeof a === "string" && (q.choices ?? []).includes(a)
      : q.kind === "yesno"
        ? typeof a === "boolean"
        : q.kind === "number"
          ? typeof a === "number"
          : typeof a === "string"
  if (!fits) throw new Error(`That answer does not fit a ${q.kind} question.`)
  return a
}
