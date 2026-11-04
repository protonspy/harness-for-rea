import { describe, expect, it } from "vitest"
import { agentRunArgs, containerName, dockerRunArgs, mcpExecArgs, mcpServers, reaEnv, SPECIALIST_IMAGE } from "../src/main/sandbox/docker"
import type { BufferResult, ExecBuffer } from "../src/main/sandbox/taskbox"
import { ContainerBackend } from "../src/main/specialist/container"

/* Where the DeepAgents specialist's tools run (specs/specialist-providers R2.2, R2.3, R2.4). */

const spec = { id: "1234", workspace: "C:\\data\\workspace\\1234", runDir: "C:\\data\\runs\\1234", out: "C:\\data\\outputs\\1234", mode: "read" as const }
const after = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag)

function recorder(reply: (args: string[]) => Partial<BufferResult> = () => ({})) {
  const calls: { args: string[]; input?: Uint8Array }[] = []
  const exec: ExecBuffer = async (args, _t, input) => {
    calls.push({ args, input })
    return { code: 0, stdout: Buffer.from(""), stderr: "", ...reply(args) }
  }
  return { calls, exec }
}

describe("the agent's own container (R2.3)", () => {
  it("has a delegation's mounts, minus the Claude login volume, detached and idle", () => {
    const args = agentRunArgs(spec)
    expect(after(args, "--mount")).toEqual(after(dockerRunArgs(spec), "--mount").filter((m) => !m.startsWith("type=volume")))
    expect(args.slice(0, 3)).toEqual(["run", "-d", "--rm"])
    expect(after(args, "--name")).toEqual([containerName("1234")])
    expect(after(args, "--entrypoint")).toEqual(["sleep"])
    expect(args.slice(-2)).toEqual([SPECIALIST_IMAGE, "infinity"])
    expect(args.some((a) => /CLAUDE_|ANTHROPIC_/.test(a))).toBe(false)
  })

  it("mounts /work writable only in modify mode", () => {
    expect(agentRunArgs(spec)).toContain("type=bind,source=C:\\data\\workspace\\1234,target=/work,readonly")
    expect(agentRunArgs({ ...spec, mode: "modify" })).toContain("type=bind,source=C:\\data\\workspace\\1234,target=/work")
  })

  it("refuses a mount source that could add mount options", () => {
    expect(() => agentRunArgs({ ...spec, workspace: "C:/a,b" })).toThrow(/comma or quote/)
  })
})

describe("the agent's MCP servers in the container (R2.4)", () => {
  it("starts each server Claude Code gets with docker exec -i, its environment as declared", () => {
    const servers = mcpServers(["cheat-engine"])
    expect(Object.keys(servers)).toEqual(["hfr", "rea", "cheat-engine"])
    const rea = mcpExecArgs("hfr-1234", servers.rea)
    expect(rea.slice(0, 4)).toEqual(["exec", "-i", "-w", "/work"])
    expect(after(rea, "-e")).toEqual(Object.entries(reaEnv()).map(([k, v]) => `${k}=${v}`))
    expect(rea.slice(rea.indexOf("hfr-1234"))).toEqual(["hfr-1234", "node", ...servers.rea.args])
    expect(mcpExecArgs("hfr-1234", servers.hfr)).toEqual(["exec", "-i", "-w", "/work", "hfr-1234", "node", "/opt/hfr/ask-user.mjs", "/run/hfr-ask"])
  })
})

describe("the agent's backend (R2.2)", () => {
  it("runs a command in the container, in /work, under its time limit", async () => {
    const r = recorder(() => ({ stdout: Buffer.from("out\n"), stderr: "err" }))
    const res = await new ContainerBackend(r.exec, "hfr-1234", 30).execute("objdump -d a.out")
    expect(r.calls[0].args).toEqual(["exec", "-w", "/work", "hfr-1234", "timeout", "-s", "KILL", "30", "sh", "-c", "objdump -d a.out"])
    expect(res).toEqual({ output: "out\nerr", exitCode: 0, truncated: false })
  })

  it("writes a file by an absolute normalized path only, its bytes on stdin", async () => {
    const r = recorder()
    const b = new ContainerBackend(r.exec, "hfr-1234")
    const out = await b.uploadFiles([
      ["/root/out/a.txt", new TextEncoder().encode("hi")],
      ["/root/out/../../etc/x", new Uint8Array()],
      ["rel.txt", new Uint8Array()],
    ])
    expect(out.map((o) => o.error)).toEqual([null, "permission_denied", "permission_denied"])
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].args.slice(0, 3)).toEqual(["exec", "-i", "hfr-1234"])
    expect(r.calls[0].args.at(-1)).toBe("/root/out/a.txt")
    expect(new TextDecoder().decode(r.calls[0].input)).toBe("hi")
  })

  it("says a write the read-only /work refused was refused", async () => {
    const r = recorder(() => ({ code: 1, stderr: "Read-only file system" }))
    expect((await new ContainerBackend(r.exec, "hfr-1234").uploadFiles([["/work/a.c", new Uint8Array()]]))[0].error).toBe("permission_denied")
  })

  it("reads a file, and names a missing file or a folder", async () => {
    const r = recorder((args) =>
      args.at(-1) === "/work/a.c"
        ? { stdout: Buffer.from("int x;") }
        : args.at(-1) === "/work"
          ? { code: 1, stderr: "cat: /work: Is a directory" }
          : { code: 1, stderr: "No such file" },
    )
    const out = await new ContainerBackend(r.exec, "hfr-1234").downloadFiles(["/work/a.c", "/work", "/work/nope"])
    expect(new TextDecoder().decode(out[0].content!)).toBe("int x;")
    expect(out.slice(1).map((o) => o.error)).toEqual(["is_directory", "file_not_found"])
  })
})
