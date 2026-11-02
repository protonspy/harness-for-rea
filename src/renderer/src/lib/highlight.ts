import type { Parser } from "@lezer/common"
import { classHighlighter, highlightCode } from "@lezer/highlight"
import { parser as cpp } from "@lezer/cpp"
import { parser as css } from "@lezer/css"
import { parser as go } from "@lezer/go"
import { parser as html } from "@lezer/html"
import { parser as java } from "@lezer/java"
import { parser as javascript } from "@lezer/javascript"
import { parser as json } from "@lezer/json"
import { parser as python } from "@lezer/python"
import { parser as rust } from "@lezer/rust"
import { parser as xml } from "@lezer/xml"
import { parser as yaml } from "@lezer/yaml"

/*
  Syntax colors for the code in a conversation (specs/chat R7.6), one highlighter both apps draw: CodeMirror's Lezer
  parsers turn a code block into lines of tokens, each tagged with Lezer's stable `tok-*` classes and colored from one
  palette, `SYNTAX`, in both apps. Pure, with no DOM, so the TUI imports it as it is.
*/

export interface Token {
  text: string
  /** Lezer's classes for the token, such as `tok-keyword` or `tok-variableName tok-definition`; empty when plain */
  classes: string
  /** the one that picks its color — `keyword`, `string`, `comment`, `definition` — or empty when plain */
  tag: SyntaxTag | ""
}

/**
  The syntax palette both apps draw with, on the desktop app's dark background; a tag absent here is drawn in the
  text color. Listed in the order a token's classes are matched, most specific first.
*/
export const SYNTAX = {
  comment: "#6b7385",
  string: "#9ece6a",
  number: "#ff9e64",
  bool: "#ff9e64",
  atom: "#ff9e64",
  keyword: "#bb9af7",
  definition: "#7dcfff",
  typeName: "#2ac3de",
  className: "#2ac3de",
  namespace: "#2ac3de",
  macroName: "#e0af68",
  propertyName: "#73daca",
  labelName: "#e0af68",
  operator: "#89ddff",
  regexp: "#b4f9f8",
  meta: "#e0af68",
  heading: "#7aa2f7",
  link: "#7aa2f7",
  inserted: "#6fcf97",
  deleted: "#ef6f6c",
  invalid: "#ef6f6c",
  punctuation: "#a9b1d6",
} as const

export type SyntaxTag = keyof typeof SYNTAX

const ORDER = Object.keys(SYNTAX) as SyntaxTag[]

/** The tag of a token's classes that decides its color, or empty. */
export function tagOf(classes: string): SyntaxTag | "" {
  const names = new Set(classes.split(" ").map((c) => c.replace(/^tok-/, "")))
  return ORDER.find((t) => names.has(t)) ?? ""
}

const PARSERS: Record<string, () => Parser> = {
  javascript: () => javascript,
  jsx: () => javascript.configure({ dialect: "jsx" }),
  typescript: () => javascript.configure({ dialect: "ts" }),
  tsx: () => javascript.configure({ dialect: "ts jsx" }),
  python: () => python,
  json: () => json,
  cpp: () => cpp,
  rust: () => rust,
  java: () => java,
  go: () => go,
  html: () => html,
  css: () => css,
  xml: () => xml,
  yaml: () => yaml,
}

const ALIASES: Record<string, keyof typeof PARSERS> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  mts: "typescript",
  py: "python",
  python3: "python",
  jsonc: "json",
  json5: "json",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  "c++": "cpp",
  objc: "cpp",
  "objective-c": "cpp",
  rs: "rust",
  kotlin: "java",
  kt: "java",
  smali: "java",
  golang: "go",
  htm: "html",
  svg: "xml",
  plist: "xml",
  xaml: "xml",
  yml: "yaml",
}

/** Code longer than this is shown plain: parsing it would hold up the view for a block nobody reads whole. */
export const MAX_HIGHLIGHT = 100_000

/** The parser name for a fence's info string (`ts`, `Python`, `c++ title=x`), or null when Lezer has none for it. */
export function languageOf(info: string | null | undefined): string | null {
  const name = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (!name) return null
  if (name in PARSERS) return name
  return ALIASES[name] ?? null
}

const plain = (code: string): Token[][] => code.split("\n").map((text) => (text ? [{ text, classes: "", tag: "" }] : []))

/** A code block as lines of tokens, colored when its language has a parser; plain text otherwise. */
export function highlight(code: string, info?: string | null): Token[][] {
  const lang = languageOf(info)
  if (!lang || code.length > MAX_HIGHLIGHT) return plain(code)
  const parser = PARSERS[lang]()
  const lines: Token[][] = [[]]
  try {
    highlightCode(
      code,
      parser.parse(code),
      classHighlighter,
      (text, classes) => lines[lines.length - 1].push({ text, classes, tag: tagOf(classes) }),
      () => lines.push([]),
    )
  } catch {
    return plain(code)
  }
  return lines
}
