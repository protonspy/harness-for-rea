import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import { checkAnswer, type Answer, type Question } from "@shared/chat"
import type { ContextPackage } from "@shared/context"

/*
  A specialist's question answered by the orchestrator's model before the user is asked
  (specs/specialist-lifecycle R1, adr:0021-answer-the-specialist-from-the-orchestrator-and-let-the-user-decide-a-refusal):
  one call, outside the task's conversation, that sees only the delegation's context package and the
  question. Whatever is not a fitting answer is a deferral to the user.
*/

/** The part of a chat model this needs: one call with messages. */
export interface Answerer {
  invoke(messages: BaseMessage[], options?: { signal?: AbortSignal }): Promise<{ content: unknown }>
}

export type ModelReply = { answer: Answer } | { defer: string }

const INSTRUCTIONS = [
  "You wrote the context package below for a specialist analysing an artifact in a sandbox. The specialist is now asking you a question.",
  "Answer it only from what the package states. If the answer needs a fact only the user has — something about their environment, intent or preferences that the package does not settle — or you are not sure, defer to the user.",
  'Reply with JSON only, one object: {"answer": <value>} or {"defer": "<why the user must answer>"}.',
  "The value must fit the question's kind: one of the choices for choice, true or false for yesno, a number for number, text for text.",
  "Never add a purpose, an authorization or anything about the user that the package does not say.",
].join("\n")

/** The text of a model reply, whatever shape the provider gave it. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("")
  return ""
}

/** The first JSON object in a reply, fenced or not. */
function objectIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as unknown
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Read the model's reply: a fitting answer, or why it goes to the user (R1.3). */
export function readReply(content: unknown, q: Question): ModelReply {
  const o = objectIn(textOf(content))
  if (!o) return { defer: "The orchestrator's model did not reply with an answer." }
  if (typeof o.defer === "string" || o.defer === true)
    return { defer: typeof o.defer === "string" && o.defer.trim() ? o.defer.trim() : "The model deferred to the user." }
  if (!("answer" in o)) return { defer: "The orchestrator's model did not reply with an answer." }
  try {
    return { answer: checkAnswer(q, o.answer as Answer) }
  } catch {
    return { defer: `The model's answer does not fit a ${q.kind} question.` }
  }
}

/** One call of the orchestrator's model for a specialist's question (R1.1); a failed call defers (R1.3). */
export async function answerFromPackage(model: Answerer, pkg: ContextPackage, q: Question, signal?: AbortSignal): Promise<ModelReply> {
  const question = { prompt: q.prompt, reason: q.reason, kind: q.kind, ...(q.choices ? { choices: q.choices } : {}) }
  try {
    const reply = await model.invoke(
      [
        new SystemMessage(INSTRUCTIONS),
        new HumanMessage(`Context package:\n${JSON.stringify(pkg, null, 2)}\n\nThe specialist's question:\n${JSON.stringify(question, null, 2)}`),
      ],
      { signal },
    )
    return readReply(reply.content, q)
  } catch (e) {
    if (signal?.aborted) throw e
    return { defer: `The orchestrator's model could not be asked: ${(e as Error).message}` }
  }
}
