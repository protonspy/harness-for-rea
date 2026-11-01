import type { BaseMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import type { Question } from "@shared/chat"
import { ContextPackageSchema } from "@shared/context"
import { answerFromPackage, readReply, type Answerer } from "../src/main/orchestrator/answer"

/* specs/specialist-lifecycle R1.1, R1.3: a specialist's question answered from the package, or deferred. */

const pkg = ContextPackageSchema.parse({ brief: "An ARM64 ELF built with clang 18.", objective: "Map the parser in /work/bin", files: ["bin"] })
const yesno: Question = { prompt: "Is the binary stripped?", reason: "It decides the approach.", kind: "yesno", default: false }
const choice: Question = { prompt: "Which arch?", reason: "r", kind: "choice", choices: ["x86_64", "arm64"], default: "x86_64" }

function model(reply: unknown | Error): Answerer & { seen: BaseMessage[][] } {
  const seen: BaseMessage[][] = []
  return {
    seen,
    invoke: async (messages) => {
      seen.push(messages)
      if (reply instanceof Error) throw reply
      return { content: reply }
    },
  }
}

describe("answering a specialist's question from the package (specs/specialist-lifecycle R1)", () => {
  it("makes one call that holds the package and the question, and returns a fitting answer", async () => {
    const m = model('{"answer": "arm64"}')
    expect(await answerFromPackage(m, pkg, choice)).toEqual({ answer: "arm64" })
    expect(m.seen).toHaveLength(1)
    const text = m.seen[0].map((x) => String(x.content)).join("\n")
    expect(text).toContain("ARM64 ELF built with clang 18")
    expect(text).toContain("Which arch?")
    expect(text).toMatch(/defer to the user/)
  })

  it("reads an answer fenced in prose or split into parts", () => {
    expect(readReply('Sure:\n```json\n{"answer": true}\n```', yesno)).toEqual({ answer: true })
    expect(
      readReply(
        [
          { type: "text", text: '{"answer":' },
          { type: "text", text: " false}" },
        ],
        yesno,
      ),
    ).toEqual({ answer: false })
  })

  it("defers when the model defers, does not fit the kind, does not reply in JSON, or fails", async () => {
    expect(readReply('{"defer": "Only the user knows their device."}', yesno)).toEqual({ defer: "Only the user knows their device." })
    expect(readReply('{"answer": "maybe"}', yesno)).toEqual({ defer: expect.stringContaining("does not fit a yesno") })
    expect(readReply('{"answer": "mips"}', choice)).toMatchObject({ defer: expect.any(String) })
    expect(readReply("I think yes.", yesno)).toMatchObject({ defer: expect.any(String) })
    expect(readReply('{"other": 1}', yesno)).toMatchObject({ defer: expect.any(String) })
    expect(await answerFromPackage(model(new Error("402 out of credits")), pkg, yesno)).toEqual({ defer: expect.stringContaining("402 out of credits") })
  })

  it("lets a cancellation through rather than deferring it", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(answerFromPackage(model(new Error("aborted")), pkg, yesno, abort.signal)).rejects.toThrow("aborted")
  })
})
