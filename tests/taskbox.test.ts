import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ContextPackageSchema } from "../src/shared/context"
import { relativeTo } from "../src/main/orchestrator/tools"
import { renderPrompt, scrubPaths } from "../src/main/sandbox/prompt"
import {
  BUFFER_CAP,
  dockerExecBuffer,
  OUTPUT_CAP,
  TaskBox,
  taskBoxArgs,
  taskBoxName,
  SCRATCH,
  WORKSPACE,
  type BufferResult,
  type ExecBuffer,
} from "../src/main/sandbox/taskbox"
import { SPECIALIST_IMAGE } from "../src/main/sandbox/docker"

/*
  adr:0007-run-the-orchestrators-tools-in-a-task-container: the orchestrator's tools in a read-only
  task container (specs/orchestrator R2.2), and the brief it writes for the specialist
  (specs/task-sandbox R3.1, R3.2).
*/

const limits = { memoryMb: 1024, cpus: 1, pidsLimit: 128 }

describe("task container arguments (R2.2)", () => {
  const args = taskBoxArgs("t1", "C:\\Users\\me\\repo", limits)
  const after = (flag: string) => args.filter((_, i) => args[i - 1] === flag)

  it("binds the whole source folder read-only at /workspace and nothing else", () => {
    // Recursively read-only: a mount nested inside the source folder stays read-only too.
    expect(after("--mount")).toEqual([`type=bind,source=C:\\Users\\me\\repo,target=${WORKSPACE},readonly,bind-propagation=rprivate,bind-recursive=readonly`])
    expect(after("-w")).toEqual([WORKSPACE])
  })

  it("has Docker's default network, root with a writable root to install software, and limits (specs/sandbox-images R4.1, R2.8)", () => {
    expect(args).not.toContain("--network")
    expect(after("--user")).toEqual(["0:0"])
    expect(after("--cap-drop")).toEqual(["ALL"])
    expect(after("--cap-add")).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "KILL"])
    expect(args).not.toContain("--read-only")
    expect(args).not.toContain("--privileged")
    expect(after("--security-opt")).toEqual(["no-new-privileges"])
    expect(args.join(" ")).not.toMatch(/docker\.sock/)
    expect(after("--memory")).toEqual(["1024m"])
    expect(after("--name")).toEqual([taskBoxName("t1")])
    expect(args.slice(-2)).toEqual([SPECIALIST_IMAGE, "infinity"])
    expect(args.join(" ")).not.toMatch(/ -e |--env/)
  })

  it("refuses a source path that would add mount options", () => {
    expect(() => taskBoxArgs("t", "C:/a,b", limits)).toThrow(/comma or quote/)
  })

  it("gives the orchestrator a writable, executable /scratch apart from the read-only source (specs/chat R6.3)", () => {
    expect(after("--tmpfs")).toEqual(["/tmp:rw,nosuid,nodev,size=256m", `${SCRATCH}:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700`])
    expect(SCRATCH).toBe("/scratch")
    expect(after("--mount")).toHaveLength(1)
    expect(after("--mount")[0]).toContain(",readonly")
  })
})

function fake(answers: (args: string[]) => Partial<BufferResult>): { exec: ExecBuffer; calls: string[][] } {
  const calls: string[][] = []
  return { calls, exec: async (args) => (calls.push(args), { code: 0, stdout: Buffer.from(""), stderr: "", ...answers(args) }) }
}

describe("TaskBox", () => {
  it("runs commands in the container and reports output, exit code and truncation", async () => {
    const f = fake((a) =>
      a.some((x) => x.includes("big")) ? { stdout: Buffer.from("x".repeat(OUTPUT_CAP + 5)) } : { code: 2, stdout: Buffer.from("out\n"), stderr: "err\n" },
    )
    const box = new TaskBox(f.exec, "t1")
    expect(await box.execute("ls /workspace")).toEqual({ output: "out\nerr\n", exitCode: 2, truncated: false })
    expect(f.calls[0]).toEqual(["exec", "hfr-orch-t1", "timeout", "-s", "KILL", "110", "sh", "-c", "ls /workspace"])
    const big = await box.execute("echo big")
    expect(big.truncated).toBe(true)
    expect(big.output).toHaveLength(OUTPUT_CAP)
  })

  it("writes uploads under /scratch only, and refuses every other path (specs/chat R6.3, R6.4)", async () => {
    const inputs: (Uint8Array | undefined)[] = []
    const calls: string[][] = []
    const exec: ExecBuffer = async (args, _timeout, input) => {
      calls.push(args)
      inputs.push(input)
      return { code: args.includes("/scratch/deny/x") ? 1 : 0, stdout: Buffer.from(""), stderr: "" }
    }
    const box = new TaskBox(exec, "t1")
    const bytes = new Uint8Array([104, 105])
    expect(
      await box.uploadFiles([
        ["/scratch/probe/run.py", bytes],
        ["/workspace/src/a.ts", bytes],
        ["/scratch/../workspace/a.ts", bytes],
        ["scratch/relative", bytes],
        ["/scratch", bytes],
        ["/scratch/deny/x", bytes],
      ]),
    ).toEqual([
      { path: "/scratch/probe/run.py", error: null },
      { path: "/workspace/src/a.ts", error: "permission_denied" },
      { path: "/scratch/../workspace/a.ts", error: "permission_denied" },
      { path: "scratch/relative", error: "permission_denied" },
      { path: "/scratch", error: "permission_denied" },
      { path: "/scratch/deny/x", error: "permission_denied" },
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0].slice(0, 4)).toEqual(["exec", "-i", "hfr-orch-t1", "sh"])
    expect(calls[0].at(-1)).toBe("/scratch/probe/run.py")
    expect(inputs[0]).toEqual(bytes)
  })

  it("downloads files through cat, reporting what is missing or a directory", async () => {
    const f = fake((a) =>
      a.at(-1) === "/workspace/a"
        ? { stdout: Buffer.from("hi") }
        : a.at(-1) === "/workspace/d"
          ? { code: 1, stderr: "cat: /workspace/d: Is a directory" }
          : { code: 1, stderr: "No such file" },
    )
    const out = await new TaskBox(f.exec, "t1").downloadFiles(["/workspace/a", "/workspace/d", "/workspace/z"])
    expect(Buffer.from(out[0].content!).toString()).toBe("hi")
    expect(out.map((o) => o.error)).toEqual([null, "is_directory", "file_not_found"])
  })

  it("marks output that hit the buffer cap as truncated, and refuses such a download", async () => {
    const f = fake(() => ({ stdout: Buffer.from("partial"), overflow: true }))
    const box = new TaskBox(f.exec, "t1")
    expect((await box.execute("yes")).truncated).toBe(true)
    expect((await box.downloadFiles(["/dev/zero"]))[0]).toEqual({ path: "/dev/zero", content: null, error: "file_not_found" })
  })

  it("stops reading a command whose output passes the cap", async () => {
    const r = await dockerExecBuffer.call(null, ["--version"])
    expect(r.overflow).toBe(false)
    expect(BUFFER_CAP).toBeGreaterThan(OUTPUT_CAP)
  })

  it("sweeps task containers left behind by a previous run", async () => {
    const f = fake((a) => (a[0] === "ps" ? { stdout: Buffer.from("abc\ndef\n") } : {}))
    expect(await TaskBox.sweep(f.exec)).toBe(2)
    expect(f.calls).toEqual([
      ["ps", "-aq", "--filter", "name=^hfr-orch-"],
      ["rm", "-f", "abc", "def"],
    ])
    const none = fake(() => ({ stdout: Buffer.from("") }))
    expect(await TaskBox.sweep(none.exec)).toBe(0)
    expect(none.calls).toHaveLength(1)
  })

  it("starts the container or says why it could not, and removes it", async () => {
    const ok = fake(() => ({}))
    const box = await TaskBox.start(ok.exec, "t1", "C:/repo", limits)
    expect(ok.calls[0].slice(0, 2)).toEqual(["run", "-d"])
    await box.dispose()
    expect(ok.calls.at(-1)).toEqual(["rm", "-f", "hfr-orch-t1"])
    await expect(
      TaskBox.start(fake(() => ({ code: 125, stderr: "docker: Error response from daemon: invalid mount\n" })).exec, "t2", "C:/repo", limits),
    ).rejects.toThrow(/invalid mount/)
  })
})

describe("the orchestrator's brief (task-sandbox R3.1, R3.2)", () => {
  const pkg = (o: Record<string, unknown>) => ContextPackageSchema.parse({ brief: "b", objective: "o", files: ["src/a.ts"], ...o })

  it("is required and rendered first", () => {
    expect(ContextPackageSchema.safeParse({ objective: "o", files: ["a"] }).success).toBe(false)
    const p = renderPrompt(pkg({ brief: "The user owns this billing system and is fixing a rounding bug." }))
    expect(p.startsWith("## Brief\nThe user owns this billing system")).toBe(true)
    expect(p.indexOf("## Brief")).toBeLessThan(p.indexOf("## Objective"))
  })

  it("replaces every host form of the source folder and /workspace with /work", () => {
    const s = scrubPaths(
      pkg({
        brief: "Repo at C:\\Users\\Me\\Repo\\src\\a.ts and c:/users/me/repo/lib; the orchestrator saw /workspace/src/a.ts.",
        objective: "Check C:\\Users\\Me\\Repo",
        questions: ["Why does /workspace/lib fail?"],
        environment: ["Root C:/Users/Me/Repo/"],
        constraints: ["Keep C:\\Users\\Me\\Repository untouched? no: only the repo"],
        excerpts: [{ path: "src/a.ts", startLine: 1, endLine: 2, note: "see C:\\Users\\Me\\Repo\\src" }],
      }),
      "C:\\Users\\Me\\Repo",
    )
    expect(s.brief).toBe("Repo at /work/src/a.ts and /work/lib; the orchestrator saw /work/src/a.ts.")
    expect(s.objective).toBe("Check /work")
    expect(s.questions).toEqual(["Why does /work/lib fail?"])
    expect(s.environment).toEqual(["Root /work/"])
    expect(s.excerpts[0].note).toBe("see /work/src")
    expect(JSON.stringify(s)).not.toMatch(/Users[\\/]+Me[\\/]+Repo[\\/"]/i)
  })

  it("replaces only whole paths, whatever comes before them", () => {
    const s = scrubPaths(pkg({ brief: "İstanbul team: C:\\src\\a and C:\\src2\\b and c:\\SRC" }), "C:\\src")
    expect(s.brief).toBe("İstanbul team: /work/a and C:\\src2\\b and /work")
  })

  it("leaves text without host paths alone", () => {
    const p = pkg({ brief: "Plain words about /usr/lib and workspace settings." })
    expect(scrubPaths(p, "C:\\x\\repo").brief).toBe("Plain words about /usr/lib and workspace settings.")
  })
})

describe("relativeTo", () => {
  it("maps the agent's view of a path to the source folder", () => {
    expect(relativeTo("/workspace", "/workspace/src/a.ts")).toBe("src/a.ts")
    expect(relativeTo("/workspace", "src/a.ts")).toBe("src/a.ts")
    expect(relativeTo("/", "/src/a.ts")).toBe("src/a.ts")
    expect(relativeTo("/workspace", "/workspacex/a")).toBe("workspacex/a")
    expect(relativeTo("/workspace", "\\workspace\\b.ts")).toBe("b.ts")
  })
})

/* Against the real Docker and the built image: HFR_DOCKER=1 npx vitest run tests/taskbox.test.ts */
describe.skipIf(!process.env.HFR_DOCKER)("TaskBox on Docker", () => {
  it("serves the source read-only and runs nothing with network", async () => {
    const src = mkdtempSync(join(tmpdir(), "hfr-box-"))
    mkdirSync(join(src, "src"))
    writeFileSync(join(src, "src", "a.js"), "one\ntwo\n")
    const box = await TaskBox.start(dockerExecBuffer, `smoke-${Date.now()}`, src, limits)
    try {
      expect((await box.read("/workspace/src/a.js")).error).toBeUndefined()
      expect(JSON.stringify(await box.read("/workspace/src/a.js"))).toContain("two")
      const write = await box.execute("echo x > /workspace/new.txt")
      expect(write.exitCode).not.toBe(0)
      expect((await box.execute("getent hosts example.com || echo no-dns")).output).toContain("no-dns")
      expect((await box.execute("id -u")).output.trim()).toBe("1000")
      // the scratch takes writes and runs them; the source still refuses them (specs/chat R6.3)
      expect((await box.write("/scratch/probe.sh", "echo probed")).error).toBeUndefined()
      expect((await box.execute("sh /scratch/probe.sh")).output.trim()).toBe("probed")
      expect((await box.write("/workspace/probe.sh", "x")).error).toBeDefined()
    } finally {
      await box.dispose()
    }
  }, 60_000)
})
