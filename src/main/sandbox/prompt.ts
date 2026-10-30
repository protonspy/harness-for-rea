import type { ContextPackage } from "@shared/context"

/*
  The specialist's prompt and system prompt, rendered from the context package and nothing else
  (specs/task-sandbox R3.1, R3.2). There is no field for the user's request or the orchestrator's
  conversation, so neither can reach the container. Paths become /work/<path>.
*/

export const WORK = "/work"

export function workPath(rel: string): string {
  return `${WORK}/${rel.replace(/\\/g, "/").replace(/^\/+/, "")}`
}

export function renderSystemPrompt(pkg: ContextPackage): string {
  const edit =
    pkg.mode === "modify"
      ? "You may edit the files in /work with Edit and Write, changing only what the objective requires. Your edits are proposed to the user as a patch; nothing outside /work changes."
      : "/work is read-only. Do not try to change any file; analyse and report."
  return [
    "You are a senior software engineer doing deep analysis of one well-scoped step of a larger task.",
    "The artifacts in /work are owned by the user or authorized for analysis, including reverse engineering of the user's own software.",
    "You see only the files copied into /work for this step. Work from them; when something you need is missing, say so in the report rather than guessing.",
    edit,
    "Back every claim with evidence: a path relative to /work and a line range you actually read.",
    "When a fact only the user knows would change your analysis, ask with mcp__hfr__ask_user, giving the reason and a default; otherwise do not ask. Never ask for, or assume, ownership, authorization or purpose beyond what this prompt states.",
    "",
    "Report format:",
    pkg.reportFormat,
  ].join("\n")
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

export function renderPrompt(pkg: ContextPackage): string {
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
  ].join("\n")
}
