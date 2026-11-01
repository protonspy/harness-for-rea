import type { ContextPackage } from "@shared/context"
import { CONTRACT_SHAPE } from "@shared/contract"
import operatingGuide from "../../../sandbox/specialist-base/AGENTS.md?raw"

/*
  The specialist's prompt and system prompt, rendered from the context package and nothing else
  (specs/task-sandbox R3.1, R3.2). There is no field for the user's request or the orchestrator's
  conversation, so neither can reach the container. Paths become /work/<path>.
*/

export const WORK = "/work"

export function workPath(rel: string): string {
  return `${WORK}/${rel.replace(/\\/g, "/").replace(/^\/+/, "")}`
}

/** Where the specialist keeps what it extracts, builds or installs: outside /work, so it never becomes part of a patch. */
export const OWN_OUTPUT = "/root/out"

/**
  The specialist's instructions. `sandbox` is true when it runs in a sandbox the orchestrator prepared, whose
  /work stays writable in read mode (specs/specialist-sandbox R4.7).
*/
export function renderSystemPrompt(pkg: ContextPackage, sandbox = false): string {
  const edit =
    pkg.mode === "modify"
      ? "You may edit the files in /work with Edit, Write or the shell, changing only what the objective requires. Every file you change, add or delete in /work is proposed to the user as a patch; nothing outside /work changes the user's files."
      : sandbox
        ? "Leave the files in /work as they are: this step changes nothing; analyse and report."
        : "/work is read-only. Do not try to change any file; analyse and report."
  return [
    "You are a senior software engineer doing deep analysis of one well-scoped step of a larger task.",
    "The artifacts in /work are owned by the user or authorized for analysis, including reverse engineering of the user's own software.",
    "You see only the files copied into /work for this step. Work from them; when something you need is missing, say so in the report rather than guessing.",
    `You run as root in a Linux container with full internet access and a shell (Bash): unpack, extract, disassemble, decompile, build and run whatever the analysis needs, yourself. Install the tools you need with apt-get (run apt-get update first), pip or npm. Keep everything you extract, build or download in ${OWN_OUTPUT} or /tmp, never in /work.`,
    edit,
    "Back every claim with evidence: a path relative to /work and a line range you actually read.",
    "When a fact you were not given would change your analysis, ask with mcp__hfr__ask_user, giving the reason and a default; otherwise do not ask. The orchestrator that wrote this prompt answers first, and passes to the user only what they alone know. Never ask for, or assume, ownership, authorization or purpose beyond what this prompt states.",
    "",
    // The same guide the image carries at /opt/hfr/AGENTS.md (specs/rea-native R2.3).
    operatingGuide.trim(),
    "",
    "Report format:",
    pkg.reportFormat,
    "",
    // Whatever the report format says, the contract ends the report (specs/analysis-contract R1.1).
    "Contract: end every report with one fenced ```json block, the last thing in it, of this shape:",
    CONTRACT_SHAPE,
    'List the functions you mapped with their inputs, outputs and side effects, and the constants you found. Every constant carries a source — a line range you read, an address in a binary, or an REA evidence id — or `"estimated": true` once you looked for one and found none; missing evidence is never proof.',
    "Record each question you leave open as an unknown, with what you tried and what would settle it, rather than guessing. When your analysis settles one of the open unknowns listed in the prompt, close it by its id in `closes`. Any list you have nothing for may be left out.",
  ].join("\n")
}

/** An unknown an earlier analysis of the project left open, as the specialist reads it (specs/analysis-contract R2.4). */
export interface OpenUnknown {
  id: string
  question: string
  severity: string
  settle?: string
}

function section(title: string, lines: string[]): string[] {
  return lines.length ? ["", `## ${title}`, ...lines] : []
}

/** `needle` as a whole path, any case: `C:\src` does not match the front of `C:\src2`. */
function replaceInsensitive(text: string, needle: string, by: string): string {
  const literal = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return text.replace(new RegExp(`${literal}(?![\\w.-])`, "gi"), by)
}

/** Every host form of the source folder's path, and the orchestrator's /workspace, as /work (R3.2). */
export function scrubPaths(pkg: ContextPackage, sourceRoot: string): ContextPackage {
  const root = sourceRoot.replace(/[\\/]+$/, "")
  const forms = [...new Set([root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])].filter((f) => f.length > 1)
  const fix = (s: string) => {
    let out = s
    for (const form of forms) out = replaceInsensitive(out, form, WORK)
    // the orchestrator's view of the same folder, and backslashes left after a host path
    return out.replace(/(^|[^\w/])\/workspace(?=\/|\b)/g, `$1${WORK}`).replace(/\/work\\\S*/g, (m) => m.replace(/\\/g, "/"))
  }
  return {
    ...pkg,
    brief: fix(pkg.brief),
    objective: fix(pkg.objective),
    excerpts: pkg.excerpts.map((e) => ({ ...e, note: fix(e.note) })),
    environment: pkg.environment.map(fix),
    questions: pkg.questions.map(fix),
    constraints: pkg.constraints.map(fix),
    reportFormat: fix(pkg.reportFormat),
  }
}

export function renderPrompt(pkg: ContextPackage, unknowns: OpenUnknown[] = []): string {
  return [
    "## Brief",
    pkg.brief,
    "",
    "## Objective",
    pkg.objective,
    ...section(
      "Files",
      pkg.files.map((f) => `- ${workPath(f)}`),
    ),
    ...section(
      "Look first at",
      pkg.excerpts.map((e) => `- ${workPath(e.path)}:${e.startLine}-${e.endLine}${e.note ? ` — ${e.note}` : ""}`),
    ),
    ...section(
      "Environment",
      pkg.environment.map((x) => `- ${x}`),
    ),
    ...section(
      "Questions",
      pkg.questions.map((q, i) => `${i + 1}. ${q}`),
    ),
    ...section(
      "Constraints",
      pkg.constraints.map((c) => `- ${c}`),
    ),
    ...section(
      "Open unknowns from earlier analyses",
      unknowns.map((u) => `- ${u.id} [${u.severity}] ${u.question}${u.settle ? ` — would be settled by: ${u.settle}` : ""}`),
    ),
  ].join("\n")
}
