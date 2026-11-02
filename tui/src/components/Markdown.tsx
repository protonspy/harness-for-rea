import { TextAttributes } from "@opentui/core"
import { useMemo } from "react"
import { highlight, SYNTAX } from "../../../src/renderer/src/lib/highlight"
import { useApp } from "../app/context"
import { parseMarkdown, plainOf, type MdBlock, type Run } from "../lib/markdown"
import { safe } from "./ui"

/*
  A message drawn as markdown in the terminal (specs/tui-conversation R1.2): the blocks of `parseMarkdown`, with code
  colored by the highlighter and palette the desktop app uses (specs/chat R7.6).
*/

function Runs({ runs }: { runs: Run[] }) {
  const { theme } = useApp()
  return (
    <>
      {runs.map((r, i) => {
        const text = safe(r.text)
        let attributes = 0
        if (r.bold) attributes |= TextAttributes.BOLD
        if (r.italic) attributes |= TextAttributes.ITALIC
        if (r.strike) attributes |= TextAttributes.STRIKETHROUGH
        if (r.link) attributes |= TextAttributes.UNDERLINE
        return (
          <span
            key={i}
            fg={r.code ? theme.warning : r.link ? theme.primary : undefined}
            bg={r.code ? theme.muted : undefined}
            attributes={attributes || undefined}
          >
            {text}
          </span>
        )
      })}
    </>
  )
}

export function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const { theme } = useApp()
  const lines = useMemo(() => highlight(code, lang), [code, lang])
  return (
    <box flexDirection="column" backgroundColor={theme.muted} paddingLeft={1} paddingRight={1} marginTop={0} marginBottom={0}>
      {lang ? (
        <text fg={theme.mutedForeground} attributes={TextAttributes.DIM}>
          {safe(lang)}
        </text>
      ) : null}
      {lines.map((line, i) => (
        <text key={i} wrapMode="char">
          {line.length === 0 ? " " : null}
          {line.map((t, j) => (
            <span key={j} fg={t.tag ? SYNTAX[t.tag] : theme.foreground} attributes={t.tag === "comment" ? TextAttributes.ITALIC : undefined}>
              {safe(t.text)}
            </span>
          ))}
        </text>
      ))}
    </box>
  )
}

function Table({ rows }: { rows: Run[][][] }) {
  const { theme } = useApp()
  const cells = rows.map((r) => r.map((c) => safe(plainOf(c)).replace(/\s+/g, " ")))
  const widths = cells[0]?.map((_, i) => Math.min(40, Math.max(...cells.map((r) => (r[i] ?? "").length)))) ?? []
  const line = (r: string[]) => r.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i])).join(" │ ")
  return (
    <box flexDirection="column">
      {cells.map((r, i) => (
        <box key={i} flexDirection="column">
          <text fg={i === 0 ? theme.primary : theme.foreground} attributes={i === 0 ? TextAttributes.BOLD : undefined} wrapMode="none">
            {line(r)}
          </text>
          {i === 0 ? (
            <text fg={theme.border} wrapMode="none">
              {widths.map((w) => "─".repeat(w)).join("─┼─")}
            </text>
          ) : null}
        </box>
      ))}
    </box>
  )
}

function Block({ b }: { b: MdBlock }) {
  const { theme } = useApp()
  const quote = b.quote ? "│ ".repeat(b.quote) : ""
  const prefix = quote ? <span fg={theme.border}>{quote}</span> : null
  switch (b.kind) {
    case "heading":
      return (
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {prefix}
          <Runs runs={b.runs} />
        </text>
      )
    case "para":
      return (
        <box paddingLeft={b.indent * 2} flexDirection="row">
          {b.marker ? <text fg={theme.primary}>{`${quote}${b.marker}`}</text> : null}
          <text wrapMode="word" fg={b.quote ? theme.mutedForeground : theme.foreground} flexShrink={1}>
            {b.marker ? null : prefix}
            <Runs runs={b.runs} />
          </text>
        </box>
      )
    case "code":
      return (
        <box paddingLeft={b.indent * 2}>
          <CodeBlock code={b.text} lang={b.lang} />
        </box>
      )
    case "table":
      return <Table rows={b.rows} />
    case "rule":
      return <text fg={theme.border}>{`${quote}${"─".repeat(40)}`}</text>
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const item = (b: MdBlock | undefined) => b?.kind === "para" && (b.marker !== "" || b.indent > 0)
  return (
    <box flexDirection="column">
      {blocks.map((b, i) => (
        // A blank line between blocks, as markdown reads, but not between the items of one list.
        <box key={i} marginTop={i > 0 && !(item(b) && item(blocks[i - 1])) ? 1 : 0}>
          <Block b={b} />
        </box>
      ))}
    </box>
  )
}
