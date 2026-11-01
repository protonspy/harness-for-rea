import { randomUUID } from "node:crypto"
import type { Contract } from "@shared/contract"
import type { UnknownRow } from "@shared/types"
import { getDb } from "./db"
import { redact } from "./events/redact"

/*
  A project's unknowns ledger (specs/analysis-contract R2): each question an analysis left open, tied
  to the analysis that raised it and, once settled, to the one that closed it with its resolution.
  Fed only from a contract that validated.
*/

type Row = Record<string, unknown>

function unknownRow(r: Row): UnknownRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    question: String(r.question),
    severity: String(r.severity) as UnknownRow["severity"],
    probes: JSON.parse(String(r.probes)) as string[],
    settle: String(r.settle),
    raisedBy: String(r.raised_by),
    closedBy: r.closed_by === null ? null : String(r.closed_by),
    resolution: String(r.resolution),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

/** What a contract did to the ledger: the ids it opened and closed, and the closes it could not apply (R2.3). */
export interface LedgerChange {
  opened: string[]
  closed: string[]
  ignored: { id: string; why: string }[]
}

export class UnknownsLedger {
  constructor(private readonly now: () => number = Date.now) {}

  /** Every unknown of the project, open ones first, each group oldest first (R2.5). */
  list(projectId: string): UnknownRow[] {
    return (getDb().prepare("SELECT * FROM unknowns WHERE project_id = ? ORDER BY closed_by IS NOT NULL, created_at, rowid").all(projectId) as Row[]).map(
      unknownRow,
    )
  }

  /** The project's open unknowns, for the next delegation (R2.4). */
  open(projectId: string): UnknownRow[] {
    return (getDb().prepare("SELECT * FROM unknowns WHERE project_id = ? AND closed_by IS NULL ORDER BY created_at, rowid").all(projectId) as Row[]).map(
      unknownRow,
    )
  }

  /** Apply a validated contract from analysis `stepId`: close what it settles, then add what it opens (R2.1–R2.3). */
  record(projectId: string, stepId: string, contract: Contract): LedgerChange {
    const db = getDb()
    const at = this.now()
    const change: LedgerChange = { opened: [], closed: [], ignored: [] }
    for (const c of contract.closes) {
      const row = db.prepare("SELECT closed_by FROM unknowns WHERE id = ? AND project_id = ?").get(c.id, projectId) as Row | undefined
      if (!row) change.ignored.push({ id: c.id, why: "no such unknown in this project" })
      else if (row.closed_by !== null) change.ignored.push({ id: c.id, why: "already closed" })
      else {
        const resolution = redact(c.source ? `${c.resolution} (${c.source})` : c.resolution)
        db.prepare("UPDATE unknowns SET closed_by = ?, resolution = ?, updated_at = ? WHERE id = ?").run(stepId, resolution, at, c.id)
        change.closed.push(c.id)
      }
    }
    // The same question already open is not added again, so a repeated contract cannot grow the ledger.
    const norm = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase()
    const open = new Set(this.open(projectId).map((u) => norm(u.question)))
    for (const u of contract.unknowns) {
      if (open.has(norm(redact(u.question)))) continue
      open.add(norm(redact(u.question)))
      const id = `unk-${randomUUID().replace(/-/g, "").slice(0, 12)}`
      db.prepare(
        "INSERT INTO unknowns (id, project_id, question, severity, probes, settle, raised_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, projectId, redact(u.question), u.severity, JSON.stringify(u.probes.map(redact)), redact(u.settle ?? ""), stepId, at, at)
      change.opened.push(id)
    }
    return change
  }
}
