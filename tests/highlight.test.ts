import { describe, expect, it } from "vitest"
import { highlight, languageOf, MAX_HIGHLIGHT, SYNTAX, tagOf } from "../src/renderer/src/lib/highlight"

/* specs/chat R7.6: code in a message colored by CodeMirror's Lezer parsers, one highlighter for both apps. */

const text = (lines: ReturnType<typeof highlight>) => lines.map((l) => l.map((t) => t.text).join("")).join("\n")
const tagged = (lines: ReturnType<typeof highlight>, tag: string) =>
  lines
    .flat()
    .filter((t) => t.tag === tag)
    .map((t) => t.text)

describe("the code highlighter", () => {
  it("names the parser for a fence's info string, with aliases, and none for a language Lezer lacks", () => {
    expect(languageOf("ts")).toBe("typescript")
    expect(languageOf("TypeScript title=x.ts")).toBe("typescript")
    expect(languageOf("py")).toBe("python")
    expect(languageOf("c")).toBe("cpp")
    expect(languageOf("smali")).toBe("java")
    expect(languageOf("yml")).toBe("yaml")
    expect(languageOf("asm")).toBeNull()
    expect(languageOf("")).toBeNull()
    expect(languageOf(undefined)).toBeNull()
  })

  it("colors keywords, strings, numbers, comments and definitions, keeping every character and line", () => {
    const code = 'const x: number = 4 // hi\nfunction f(a) {\n  return "s"\n}'
    const lines = highlight(code, "ts")
    expect(text(lines)).toBe(code)
    expect(lines).toHaveLength(4)
    expect(tagged(lines, "keyword")).toEqual(["const", "function", "return"])
    expect(tagged(lines, "string")).toEqual(['"s"'])
    expect(tagged(lines, "number")).toEqual(["4"])
    expect(tagged(lines, "comment")).toEqual(["// hi"])
    expect(tagged(lines, "definition")).toContain("f")
  })

  it("colors the languages a reverse engineer reads: C, Python, Rust, JSON", () => {
    expect(tagged(highlight('int main() { return printf("%d", 1); }', "c"), "typeName")).toEqual(["int"])
    expect(tagged(highlight("def f():\n  return 0x10", "python"), "number")).toEqual(["0x10"])
    expect(tagged(highlight("fn main() { let x = 1; }", "rust"), "keyword")).toEqual(expect.arrayContaining(["fn", "let"]))
    expect(tagged(highlight('{"a": true}', "json"), "bool")).toEqual(["true"])
  })

  it("shows code with no known language, or too long to parse, as plain lines", () => {
    const asm = "mov eax, 1\n\nret"
    const lines = highlight(asm, "asm")
    expect(text(lines)).toBe(asm)
    expect(lines.flat().every((t) => t.tag === "")).toBe(true)
    const big = "x".repeat(MAX_HIGHLIGHT + 1)
    expect(highlight(big, "ts").flat()).toEqual([{ text: big, classes: "", tag: "" }])
  })

  it("picks the most specific colored tag of a token's classes, from one palette", () => {
    expect(tagOf("tok-variableName tok-definition")).toBe("definition")
    expect(tagOf("tok-variableName")).toBe("")
    expect(tagOf("")).toBe("")
    for (const c of Object.values(SYNTAX)) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe("a message as markdown in the desktop app (specs/chat R7.6)", () => {
  it("renders markdown and colored code, never the HTML, links or images the text carries", async () => {
    const { createElement } = await import("react")
    const { renderToStaticMarkup } = await import("react-dom/server")
    // A .tsx view the Node tsconfig does not compile: loaded by path, so only Vitest resolves it.
    const view = "../src/renderer/src/components/Markdown"
    const { default: Markdown } = (await import(/* @vite-ignore */ view)) as { default: (p: { text: string }) => unknown }
    const html = renderToStaticMarkup(
      createElement(Markdown as never, {
        text: "# Title\n\n**bold** and `code`\n\n- [x] done\n\n```ts\nconst x = 1\n```\n\n<script>alert(1)</script>\n\n[site](https://evil.example) ![pixel](https://evil.example/p.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      }),
    )
    expect(html).toContain("<h1>Title</h1>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain('type="checkbox"')
    expect(html).toContain(`style="color:${SYNTAX.keyword}"`)
    expect(html).toContain("<table")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<a ")
    expect(html).not.toContain("<img")
    expect(html).toContain("[image: pixel]")
  })
})
