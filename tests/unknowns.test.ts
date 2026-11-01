import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ContractSchema } from "../src/shared/contract"
import { closeDb, getDb, openDb } from "../src/main/db"
import { UnknownsLedger } from "../src/main/unknowns"

/* specs/analysis-contract R2.1–R2.3: the project's unknowns ledger. */

let t = 1000
const ledger = new UnknownsLedger(() => ++t)
const project = (id: string) =>
  getDb()
    .prepare(
      "INSERT INTO projects (id,name,goal,target_path,target_kind,source_root,folder,provider,model,orchestrator_effort,specialist_effort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, id, "understand", "/t", "folder", "/t", "/f", "openrouter", "m", "default", "default", 0, 0)

beforeEach(() => {
  openDb(join(mkdtempSync(join(tmpdir(), "hfr-unk-")), "db.sqlite"))
  project("p1")
  project("p2")
})
afterEach(() => closeDb())

describe("the unknowns ledger (specs/analysis-contract R2)", () => {
  it("adds what a contract opens, tied to its analysis, and lists the open ones", () => {
    const change = ledger.record(
      "p1",
      "step-a",
      ContractSchema.parse({ unknowns: [{ question: "Which cipher?", severity: "high", probes: ["strings"], settle: "the key schedule" }] }),
    )
    expect(change.opened).toHaveLength(1)
    expect(ledger.open("p1")).toEqual([
      expect.objectContaining({
        id: change.opened[0],
        question: "Which cipher?",
        severity: "high",
        probes: ["strings"],
        settle: "the key schedule",
        raisedBy: "step-a",
        closedBy: null,
      }),
    ])
    expect(ledger.open("p2")).toEqual([])
  })

  it("closes an open unknown by id with its resolution and the analysis that closed it", () => {
    const [id] = ledger.record(
      "p1",
      "step-a",
      ContractSchema.parse({
        unknowns: [
          { question: "q", severity: "low" },
          { question: "r", severity: "medium" },
        ],
      }),
    ).opened
    const change = ledger.record("p1", "step-b", ContractSchema.parse({ closes: [{ id, resolution: "AES-128", source: "ev_1" }] }))
    expect(change).toEqual({ opened: [], closed: [id], ignored: [] })
    expect(ledger.open("p1").map((u) => u.question)).toEqual(["r"])
    // open first, then closed
    expect(ledger.list("p1").map((u) => [u.question, u.closedBy, u.resolution])).toEqual([
      ["r", null, ""],
      ["q", "step-b", "AES-128 (ev_1)"],
    ])
  })

  it("leaves the ledger as it was for a close it cannot apply, and says why (R2.3)", () => {
    const [id] = ledger.record("p1", "a", ContractSchema.parse({ unknowns: [{ question: "q", severity: "low" }] })).opened
    ledger.record("p1", "b", ContractSchema.parse({ closes: [{ id, resolution: "x" }] }))
    const change = ledger.record(
      "p2",
      "c",
      ContractSchema.parse({
        closes: [
          { id, resolution: "from another project" },
          { id: "unk-nope", resolution: "y" },
        ],
      }),
    )
    expect(change.ignored).toEqual([
      { id, why: "no such unknown in this project" },
      { id: "unk-nope", why: "no such unknown in this project" },
    ])
    expect(ledger.record("p1", "d", ContractSchema.parse({ closes: [{ id, resolution: "again" }] })).ignored).toEqual([{ id, why: "already closed" }])
    expect(ledger.list("p1")[0]).toMatchObject({ closedBy: "b", resolution: "x" })
  })

  it("redacts secrets a contract carries", () => {
    ledger.record("p1", "a", ContractSchema.parse({ unknowns: [{ question: "Is sk-ant-oat01-LEAKEDTOKEN123456 live?", severity: "low" }] }))
    expect(ledger.open("p1")[0].question).not.toContain("LEAKEDTOKEN")
  })
})
