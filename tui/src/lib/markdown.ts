import type { Nodes, PhrasingContent, RootContent } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"

/*
  A message's markdown as the TUI draws it (specs/tui-conversation R1.2): parsed with the same GFM grammar the desktop
  app's react-markdown uses, then flattened into blocks of styled runs a terminal can lay out — paragraphs, headings,
  list items with their marker and depth, quotes, code, tables and rules. HTML is shown as the text it is, a link as
  its text and address, an image as its description: nothing in a message is followed or loaded.
*/

export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  /** the address of a link, shown after its text */
  link?: string
}

export type MdBlock =
  | { kind: "para"; runs: Run[]; indent: number; marker: string; quote: number }
  | { kind: "heading"; depth: number; runs: Run[]; quote: number }
  | { kind: "code"; lang: string | null; text: string; indent: number; quote: number }
  | { kind: "table"; rows: Run[][][]; quote: number }
  | { kind: "rule"; quote: number }

type Style = Omit<Run, "text">

function runs(nodes: PhrasingContent[], style: Style = {}): Run[] {
  const out: Run[] = []
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out.push({ ...style, text: n.value })
        break
      case "strong":
        out.push(...runs(n.children, { ...style, bold: true }))
        break
      case "emphasis":
        out.push(...runs(n.children, { ...style, italic: true }))
        break
      case "delete":
        out.push(...runs(n.children, { ...style, strike: true }))
        break
      case "inlineCode":
        out.push({ ...style, code: true, text: n.value })
        break
      case "break":
        out.push({ ...style, text: "\n" })
        break
      case "link": {
        const inner = runs(n.children, { ...style, link: n.url })
        out.push(...inner)
        const said = inner.map((r) => r.text).join("")
        if (said !== n.url) out.push({ ...style, text: ` (${n.url})` })
        break
      }
      case "image":
        out.push({ ...style, italic: true, text: `[image${n.alt ? `: ${n.alt}` : ""}]` })
        break
      case "html":
        out.push({ ...style, text: n.value })
        break
      default:
        if ("children" in n) out.push(...runs(n.children as PhrasingContent[], style))
        else if ("value" in n) out.push({ ...style, text: String(n.value) })
    }
  }
  return merge(out)
}

/** Adjacent runs of one style joined, so a terminal draws fewer spans. */
function merge(rs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of rs) {
    const last = out.at(-1)
    if (last && last.bold === r.bold && last.italic === r.italic && last.strike === r.strike && last.code === r.code && last.link === r.link)
      last.text += r.text
    else out.push({ ...r })
  }
  return out
}

function blocks(nodes: RootContent[], ctx: { indent: number; quote: number }, out: MdBlock[]): void {
  for (const n of nodes) {
    switch (n.type) {
      case "paragraph":
        out.push({ kind: "para", runs: runs(n.children), indent: ctx.indent, marker: "", quote: ctx.quote })
        break
      case "heading":
        out.push({ kind: "heading", depth: n.depth, runs: runs(n.children), quote: ctx.quote })
        break
      case "code":
        out.push({ kind: "code", lang: n.lang ?? null, text: n.value, indent: ctx.indent, quote: ctx.quote })
        break
      case "thematicBreak":
        out.push({ kind: "rule", quote: ctx.quote })
        break
      case "blockquote":
        blocks(n.children, { ...ctx, quote: ctx.quote + 1 }, out)
        break
      case "list":
        n.children.forEach((item, i) => {
          const marker = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : n.ordered ? `${(n.start ?? 1) + i}. ` : "• "
          const [first, ...rest] = item.children
          if (first?.type === "paragraph") out.push({ kind: "para", runs: runs(first.children), indent: ctx.indent, marker, quote: ctx.quote })
          else {
            out.push({ kind: "para", runs: [], indent: ctx.indent, marker, quote: ctx.quote })
            if (first) rest.unshift(first)
          }
          blocks(rest, { ...ctx, indent: ctx.indent + 1 }, out)
        })
        break
      case "table":
        out.push({ kind: "table", rows: n.children.map((row) => row.children.map((cell) => runs(cell.children))), quote: ctx.quote })
        break
      case "html":
        out.push({ kind: "para", runs: [{ text: n.value }], indent: ctx.indent, marker: "", quote: ctx.quote })
        break
      default:
        if ("children" in n) blocks((n as { children: RootContent[] }).children, ctx, out)
    }
  }
}

/** A message's markdown as blocks of styled runs. */
export function parseMarkdown(text: string): MdBlock[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Nodes
  const out: MdBlock[] = []
  if (tree.type === "root") blocks(tree.children, { indent: 0, quote: 0 }, out)
  return out
}

/** The plain text of runs, as a line of a table cell or a test reads it. */
export const plainOf = (rs: Run[]) => rs.map((r) => r.text).join("")
