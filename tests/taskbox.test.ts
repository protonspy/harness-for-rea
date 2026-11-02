import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ContextPackageSchema } from "../src/shared/context"
import { relativeTo } from "../src/main/orchestrator/tools"
import { renderPrompt, scrubPaths } from "../src/main/sandbox/prompt"
import {
  BUFFER_CAP,
  dockerExecBuffer,
  labelled,
  OUTPUT_CAP,
  RESTARTED,
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

describe("task container arguments (R2.2)", () => {
  const args = taskBoxArgs("t1", "C:\\Users\\me\\repo", "C:\\data\\tasks\\t1\\scratch")
  const after = (flag: string) => args.filter((_, i) => args[i - 1] === flag)

  it("binds the whole source folder read-only at /workspace and the task's scratch folder at /scratch, nothing else", () => {
    // Recursively read-only: a mount nested inside the source folder stays read-only too.
    expect(after("--mount")).toEqual([
      `type=bind,source=C:\\Users\\me\\repo,target=${WORKSPACE},readonly,bind-propagation=rprivate,bind-recursive=readonly`,
      `type=bind,source=C:\\data\\tasks\\t1\\scratch,target=${SCRATCH}`,
    ])
    expect(after("-w")).toEqual([WORKSPACE])
  })

  it("has Docker's default network, root with a writable root to install software, and no limit (specs/sandbox-images R4.1, specs/specialist-sandbox R6.1)", () => {
    expect(args).not.toContain("--network")
    expect(after("--user")).toEqual(["0:0"])
    expect(after("--cap-drop")).toEqual(["ALL"])
    expect(after("--cap-add")).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "KILL"])
    expect(args).not.toContain("--read-only")
    expect(args).not.toContain("--privileged")
    expect(after("--security-opt")).toEqual(["no-new-privileges"])
    expect(args.join(" ")).not.toMatch(/docker\.sock/)
    for (const flag of ["--memory", "--memory-swap", "--cpus", "--pids-limit", "--storage-opt"]) expect(args).not.toContain(flag)
    expect(after("--name")).toEqual([taskBoxName("t1")])
    expect(args.slice(-2)).toEqual([SPECIALIST_IMAGE, "infinity"])
    expect(after("--entrypoint")).toEqual(["sleep"])
    // kept when stopped, so what was installed outlives the task's end (specs/task-persistence R3.4)
    expect(args).not.toContain("--rm")
    expect(args).toContain("--init")
    expect(args.join(" ")).not.toMatch(/ -e |--env/)
  })

  it("refuses a source path that would add mount options", () => {
    expect(() => taskBoxArgs("t", "C:/a,b", "C:/s")).toThrow(/comma or quote/)
    expect(() => taskBoxArgs("t", "C:/a", "C:/s,x")).toThrow(/comma or quote/)
  })

  it("gives the orchestrator a writable /scratch on the host apart from the read-only source, with no size cap (specs/chat R6.3, specs/task-persistence R3.2)", () => {
    expect(args).not.toContain("--tmpfs")
    expect(SCRATCH).toBe("/scratch")
    expect(after("--mount")[0]).toContain(",readonly")
    expect(after("--mount")[1]).not.toContain("readonly")
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

  it("stops, and keeps, the task containers a previous run left running (specs/task-persistence R3.4)", async () => {
    const f = fake((a) => (a[0] === "ps" ? { stdout: Buffer.from("hfr-orch-abc\nhfr-orch-def\n") } : {}))
    expect(await TaskBox.sweep(f.exec)).toBe(2)
    expect(f.calls).toEqual([
      ["ps", "--filter", "name=^hfr-orch-", "--format", "{{.Names}}"],
      ["stop", "-t", "2", "hfr-orch-abc", "hfr-orch-def"],
    ])
    const none = fake(() => ({ stdout: Buffer.from("") }))
    expect(await TaskBox.sweep(none.exec)).toBe(0)
    expect(none.calls).toHaveLength(1)
  })

  it("leaves running the task containers of a task a live app has open (specs/shared-data-folder R2.3)", async () => {
    const f = fake((a) => (a[0] === "ps" ? { stdout: Buffer.from("hfr-orch-mine\nhfr-orch-gone\n") } : {}))
    expect(await TaskBox.sweep(f.exec, (id) => id === "mine")).toBe(1)
    expect(f.calls[1]).toEqual(["stop", "-t", "2", "hfr-orch-gone"])
    const all = fake((a) => (a[0] === "ps" ? { stdout: Buffer.from("hfr-orch-mine\n") } : {}))
    expect(await TaskBox.sweep(all.exec, () => true)).toBe(0)
    expect(all.calls).toHaveLength(1)
  })

  it("starts the container Docker still has, creates it when not, says why it could not, and stops it at the end (specs/task-persistence R3.4, R3.5)", async () => {
    const scratch = join(mkdtempSync(join(tmpdir(), "hfr-scr-")), "scratch")
    // what an app of this version made: started again as it is
    const label = labelled(taskBoxArgs("t1", "C:/repo", scratch))[3]
    const kept = fake((a) => (a[0] === "inspect" ? { stdout: Buffer.from(`${label}\n`) } : {}))
    const again = await TaskBox.start(kept.exec, "t1", "C:/repo", scratch)
    expect(kept.calls.map((c) => c[0])).toEqual(["inspect", "start"])
    expect(kept.calls[1]).toEqual(["start", "hfr-orch-t1"])
    expect(again.created).toBe(false)
    const gone = fake((a) => (a[0] === "inspect" ? { code: 1, stderr: "Error: No such object: hfr-orch-t1\n" } : {}))
    const box = await TaskBox.start(gone.exec, "t1", "C:/repo", scratch)
    expect(gone.calls[1].slice(0, 2)).toEqual(["run", "-d"])
    expect(box.created).toBe(true)
    expect(existsSync(scratch)).toBe(true)
    await box.dispose()
    expect(gone.calls.at(-1)).toEqual(["stop", "-t", "2", "hfr-orch-t1"])
    await expect(
      TaskBox.start(
        fake((a) =>
          a[0] === "start" ? { code: 1, stderr: "No such container" } : { code: 125, stderr: "docker: Error response from daemon: invalid mount\n" },
        ).exec,
        "t2",
        "C:/repo",
        scratch,
      ),
    ).rejects.toThrow(/invalid mount/)
    const removed = fake(() => ({}))
    await TaskBox.remove(removed.exec, "t1")
    expect(removed.calls).toEqual([["rm", "-f", "hfr-orch-t1"]])
  })

  it("brings a stopped container up again quietly, and says what was reset when it had to be created (specs/task-persistence R3.5)", async () => {
    const scratch = join(mkdtempSync(join(tmpdir(), "hfr-scr-")), "scratch")
    // stopped: started again, nothing to report
    let state: "up" | "stopped" | "gone" = "up"
    const label = labelled(taskBoxArgs("t1", "C:/repo", scratch))[3]
    const f = fake((a) => {
      if (a[0] === "inspect") return state === "gone" ? { code: 1, stderr: "No such object" } : { stdout: Buffer.from(label) }
      if (a[0] === "start") return state === "gone" ? { code: 1, stderr: "No such container: hfr-orch-t1" } : ((state = "up"), {})
      if (a[0] === "run") return ((state = "up"), {})
      if (a[0] === "exec" && state === "stopped") return { code: 1, stderr: "Error response from daemon: container abc is not running\n" }
      if (a[0] === "exec" && state === "gone") return { code: 1, stderr: "Error response from daemon: No such container: hfr-orch-t1\n" }
      return { stdout: Buffer.from("ok\n") }
    })
    const box = await TaskBox.start(f.exec, "t1", "C:/repo", scratch)
    state = "stopped"
    expect((await box.execute("echo ok")).output).toBe("ok\n")
    state = "gone"
    const r = await box.execute("echo ok")
    expect(r).toMatchObject({ exitCode: 0 })
    expect(r.output).toBe(`${RESTARTED} ok\n`)
    expect(RESTARTED).toMatch(/\/scratch was kept, anything installed is gone/)
    // Once the task ended, a stopped container stays stopped.
    await box.dispose()
    state = "stopped"
    expect((await box.execute("echo ok")).output).toMatch(/is not running/)
  })

  it("creates again, over the same folders, a container an older app made with another image or boundary (specs/task-persistence R3.5)", async () => {
    const scratch = join(mkdtempSync(join(tmpdir(), "hfr-scr-")), "scratch")
    const old = fake((a) => (a[0] === "inspect" ? { stdout: Buffer.from("hfr.config=0123456789abcdef") } : {}))
    const box = await TaskBox.start(old.exec, "t1", "C:/repo", scratch)
    expect(old.calls.map((c) => c[0])).toEqual(["inspect", "rm", "run"])
    expect(old.calls[2]).toEqual(labelled(taskBoxArgs("t1", "C:/repo", scratch)))
    expect(box.created).toBe(true)
    // the label is the fingerprint of every argument: another image or flag gives another one
    expect(labelled(["run", "-d", "a"])[3]).not.toBe(labelled(["run", "-d", "b"])[3])
    expect(labelled(["run", "-d", "a"]).slice(0, 3)).toEqual(["run", "-d", "--label"])
  })

  it("reports a container that cannot be brought up again as the error it was", async () => {
    const f = fake((a) => (a[0] === "run" ? { code: 125, stderr: "no space" } : { code: 1, stderr: "Error response from daemon: No such container: x\n" }))
    const box = new TaskBox(f.exec, "t1", async () => null)
    expect((await box.execute("ls")).output).toMatch(/No such container/)
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
  it("serves the source read-only to root, reaches the internet, and comes back when removed", async () => {
    const src = mkdtempSync(join(tmpdir(), "hfr-box-"))
    mkdirSync(join(src, "src"))
    writeFileSync(join(src, "src", "a.js"), "one\ntwo\n")
    const id = `smoke-${Date.now()}`
    const scratch = join(src, "..", `${id}-scratch`)
    const box = await TaskBox.start(dockerExecBuffer, id, src, scratch)
    try {
      expect((await box.read("/workspace/src/a.js")).error).toBeUndefined()
      expect(JSON.stringify(await box.read("/workspace/src/a.js"))).toContain("two")
      const write = await box.execute("echo x > /workspace/new.txt")
      expect(write.exitCode).not.toBe(0)
      expect((await box.execute("getent hosts example.com || echo no-dns")).output).not.toContain("no-dns")
      expect((await box.execute("id -u")).output.trim()).toBe("0")
      // the scratch takes writes and runs them; the source still refuses them (specs/chat R6.3)
      expect((await box.write("/scratch/probe.sh", "echo probed")).error).toBeUndefined()
      expect((await box.execute("sh /scratch/probe.sh")).output.trim()).toBe("probed")
      expect((await box.write("/workspace/probe.sh", "x")).error).toBeDefined()
      expect((await box.execute("apt-get --version >/dev/null && touch /usr/local/bin/installed && echo ok")).output.trim()).toBe("ok")
      // stopped at the task's end and started on its reopen: scratch and installs both still there
      await box.dispose()
      const reopened = await TaskBox.start(dockerExecBuffer, id, src, scratch)
      expect(reopened.created).toBe(false)
      expect((await reopened.execute("cat /scratch/probe.sh; ls /usr/local/bin/installed")).output).toBe("echo probed/usr/local/bin/installed\n")
      // removed from outside: created again over the same scratch, the installs gone
      await dockerExecBuffer(["rm", "-f", taskBoxName(id)])
      expect((await reopened.execute("cat /scratch/probe.sh; ls /usr/local/bin/installed 2>/dev/null || echo none")).output).toBe(
        `${RESTARTED} echo probednone\n`,
      )
    } finally {
      await TaskBox.remove(dockerExecBuffer, id)
    }
  }, 60_000)
})
