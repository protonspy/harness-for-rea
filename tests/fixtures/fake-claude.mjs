// A stand-in for Claude Code inside the sandbox container. It takes the same arguments, reads
// stream-json turns on stdin until stdin closes, uses the file tools on its working directory
// (standing in for /work), and prints stream-json like the real CLI.
//
// The test steers it with HFR_FAKE (a mode) and learns what it got from HFR_FAKE_LOG (a JSONL file
// with the arguments, environment names, system prompt and every turn). /work and /run/hfr map to
// the working directory and HFR_RUN.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const mode = process.env.HFR_FAKE ?? "answer"
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const log = (o) => process.env.HFR_FAKE_LOG && appendFileSync(process.env.HFR_FAKE_LOG, `${JSON.stringify(o)}\n`)
const host = (p) => (p.startsWith("/run/hfr/") ? join(process.env.HFR_RUN ?? ".", p.slice(9)) : p.startsWith("/work/") ? join(process.cwd(), p.slice(6)) : p)

if (args[0] === "auth") {
  log({ auth: args.slice(1) })
  if (args[1] === "status") out({ loggedIn: mode !== "logged-out", authMethod: "claude.ai", subscriptionType: "max", email: "user@example.com" })
  if (args[1] === "login") {
    process.stdout.write(
      "Opening browser to sign in…\nBrowser didn't open? Visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ",
    )
    for await (const line of createInterface({ input: process.stdin })) {
      if (line.trim() === "good-code-123") {
        process.stdout.write("\nLogin successful.\n")
        process.exit(0)
      }
      process.stdout.write("\nOAuth error: invalid code\n")
      process.exit(1)
    }
  }
  process.exit(0)
}

const tools = (flag("--tools") ?? "").split(",").filter(Boolean)
const systemFile = flag("--system-prompt-file")
const system = systemFile && existsSync(host(systemFile)) ? readFileSync(host(systemFile), "utf8") : ""
log({ args, env: Object.keys(process.env), cwd: process.cwd(), system })

if (mode === "auth-fail") {
  process.stderr.write("Invalid API key · Please run /login\n")
  process.exit(1)
}

const session = "sess-fake"
out({ type: "system", subtype: "init", session_id: session, model: "claude-opus-test", tools, agents: ["general-purpose"] })
if (mode === "noise") {
  process.stdout.write("this is not json\n")
  out({ type: "brand_new_event", session_id: session })
}

let turn = 0
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const msg = JSON.parse(line)
  const prompt = typeof msg.message?.content === "string" ? msg.message.content : JSON.stringify(msg.message?.content)
  turn++
  log({ turn, prompt })
  if (mode === "hang") continue
  if (mode === "limit") {
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your limit · resets 3pm",
      session_id: session,
      total_cost_usd: 0.01,
      usage: { input_tokens: 5, output_tokens: 1 },
    })
    continue
  }
  const target = /\/work\/([^\s:]+)/.exec(prompt)?.[1]
  const evidence = []
  if (target && tools.includes("Read")) {
    const file = `/work/${target}`
    out({
      type: "assistant",
      session_id: session,
      message: {
        content: [
          { type: "thinking", thinking: "Reading the file first." },
          { type: "tool_use", id: `tu_r${turn}`, name: "Read", input: { file_path: file } },
        ],
      },
    })
    const text = existsSync(host(file)) ? readFileSync(host(file), "utf8") : null
    out({
      type: "user",
      session_id: session,
      message: { content: [{ type: "tool_result", tool_use_id: `tu_r${turn}`, content: text ?? "File does not exist.", is_error: text === null }] },
    })
    evidence.push(`- ${target}:1-1 — the first line is \`${(text ?? "").split("\n")[0]}\``)
    if (mode === "subagent") {
      out({
        type: "assistant",
        session_id: session,
        message: { content: [{ type: "tool_use", id: "tu_agent", name: "Agent", input: { subagent_type: "Explore", prompt: "look around" } }] },
      })
      out({
        type: "assistant",
        session_id: session,
        parent_tool_use_id: "tu_agent",
        message: { content: [{ type: "tool_use", id: "tu_g", name: "Grep", input: { pattern: "x", path: "/work" } }] },
      })
    }
    if (tools.includes("Edit") && text !== null) {
      out({
        type: "assistant",
        session_id: session,
        message: {
          content: [
            {
              type: "tool_use",
              id: `tu_e${turn}`,
              name: "Edit",
              input: { file_path: file, old_string: text.split("\n")[0], new_string: `${text.split("\n")[0]} // fixed` },
            },
          ],
        },
      })
      writeFileSync(host(file), text.replace(text.split("\n")[0], `${text.split("\n")[0]} // fixed`))
      out({
        type: "user",
        session_id: session,
        message: { content: [{ type: "tool_result", tool_use_id: `tu_e${turn}`, content: [{ type: "text", text: "The file has been updated." }] }] },
      })
    }
  }
  const answer = [
    `Turn ${turn}: analysed ${target ?? "nothing"}.${mode === "leak" ? " Found sk-ant-oat01-LEAKEDTOKEN123456 in the config." : ""}`,
    "",
    "Evidence",
    ...evidence,
  ].join("\n")
  out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: answer }] } })
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: answer,
    session_id: session,
    duration_ms: 1500,
    total_cost_usd: 0.42,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    modelUsage: { "claude-opus-test": {} },
  })
}
process.exit(0)
