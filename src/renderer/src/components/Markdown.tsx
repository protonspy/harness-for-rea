import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { highlight, SYNTAX } from "@/lib/highlight"
import { cn } from "@/lib/cn"

/*
  A message of the conversation as markdown (specs/chat R7.6): GitHub-flavoured markdown through react-markdown, raw
  HTML never interpreted, links shown rather than followed and images replaced by their text — the agents' words can
  quote the target, and nothing in them may reach the network or the window. Code blocks are colored by the
  highlighter the TUI draws with too.
*/

/** The text under a hast node. */
type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }
const textOf = (n: HastNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""))

export function CodeBlock({ code, lang }: { code: string; lang?: string | null }) {
  const lines = highlight(code.replace(/\n$/, ""), lang)
  return (
    <pre className="my-2 max-h-[480px] overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[12.5px] leading-5">
      <code>
        {lines.map((line, i) => (
          <span key={i} className="block min-h-5 whitespace-pre">
            {line.map((t, j) => (
              <span key={j} style={t.tag ? { color: SYNTAX[t.tag] } : undefined} className={t.tag === "comment" ? "italic" : undefined}>
                {t.text}
              </span>
            ))}
          </span>
        ))}
      </code>
    </pre>
  )
}

const components: Components = {
  pre: ({ node }) => {
    const code = (node?.children?.[0] ?? null) as HastNode | null
    const classes = (code?.properties?.className as string[] | undefined) ?? []
    const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null
    return <CodeBlock code={code ? textOf(code) : ""} lang={lang} />
  },
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12.5px]">{children}</code>,
  a: ({ children, href }) => (
    <span className="text-primary underline decoration-dotted underline-offset-2" title={href}>
      {children}
    </span>
  ),
  img: ({ alt }) => <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
}

export default function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("markdown text-sm leading-relaxed break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
