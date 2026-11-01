import { describe, expect, it } from "vitest"
import { readContract, withoutContract } from "../src/shared/contract"

/* specs/analysis-contract R1.2: the contract read from the end of a report and checked. */

const report = (json: string) => `## Findings\nThe parser splits on spaces.\n\nEvidence\n- a.ts:1-1 — split\n\n\`\`\`json\n${json}\n\`\`\`\n`

describe("the analysis contract (specs/analysis-contract R1.2)", () => {
  it("reads the last json block, filling the lists it leaves out", () => {
    const r = readContract(
      report(
        JSON.stringify({
          functions: [{ name: "parse", inputs: ["s"], outputs: ["tokens"], source: "a.ts:1-3" }],
          constants: [
            { name: "SEP", value: " ", source: "a.ts:1-1" },
            { name: "MAX", value: 64, estimated: true },
          ],
          unknowns: [{ question: "Is input UTF-8?", severity: "medium" }],
        }),
      ),
    )
    expect(r).toEqual({
      contract: {
        functions: [{ name: "parse", inputs: ["s"], outputs: ["tokens"], sideEffects: [], source: "a.ts:1-3" }],
        constants: [
          { name: "SEP", value: " ", source: "a.ts:1-1" },
          { name: "MAX", value: 64, estimated: true },
        ],
        unknowns: [{ question: "Is input UTF-8?", severity: "medium", probes: [] }],
        closes: [],
      },
    })
    expect(readContract(`\`\`\`json\n{"functions": "old"}\n\`\`\`\n${report("{}")}`)).toEqual({
      contract: { functions: [], constants: [], unknowns: [], closes: [] },
    })
  })

  it("refuses a constant with neither a source nor estimated: true", () => {
    const r = readContract(
      report(
        JSON.stringify({
          constants: [
            { name: "K", value: 3 },
            { name: "L", value: 4, estimated: false },
          ],
        }),
      ),
    )
    expect(r).toEqual({ problems: [expect.stringMatching(/^constants\.0: needs a source/), expect.stringMatching(/^constants\.1: needs a source/)] })
  })

  it("says why there is no contract: no block, bad JSON, or a field it does not know", () => {
    expect(readContract("just prose")).toEqual({ problems: [expect.stringContaining("does not end with a contract")] })
    expect(readContract(report("{ not json"))).toEqual({ problems: [expect.stringContaining("not valid JSON")] })
    expect(readContract(report('{"purpose": "x"}'))).toMatchObject({ problems: [expect.stringMatching(/purpose|Unrecognized/i)] })
    expect(readContract(report('{"unknowns": [{"question": "q", "severity": "urgent"}]}'))).toMatchObject({
      problems: [expect.stringMatching(/^unknowns\.0\.severity/)],
    })
  })

  it("drops the contract block from the report it ends", () => {
    expect(withoutContract(report("{}"))).toBe("## Findings\nThe parser splits on spaces.\n\nEvidence\n- a.ts:1-1 — split")
    expect(withoutContract("no block")).toBe("no block")
  })
})
