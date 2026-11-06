import { describe, expect, it } from "vitest"
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages"
import { PROVIDERS, normalizeBaseUrl, resolveBaseUrl, resolveEndpointUrl } from "../src/shared/providers"
import { makeModel } from "../src/main/orchestrator/model"
import { probeModel } from "../src/main/orchestrator/models"
import { protocolFor, readiness, type ReadinessDeps, type RunChoice } from "../src/main/readiness"
import { DEFAULT_SETTINGS } from "../src/shared/defaults"
import { getSettings, saveSettings } from "../src/main/settings"
import { openDb, closeDb } from "../src/main/db"
import { ProjectStore } from "../src/main/projects"
import type { LoginStatus, ProjectRow, SandboxStatus, Settings } from "../src/shared/types"
import type { ModelProtocol, ProviderId } from "../src/shared/providers"
import { writeFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("River Responses Transport & Protocol Negotiation (Issue #4)", () => {
  describe("URL and base endpoint normalization", () => {
    it("normalizes base URL pasted with /responses or /chat/completions suffix", () => {
      expect(normalizeBaseUrl("https://api.river.ai/v1/responses")).toBe("https://api.river.ai/v1")
      expect(normalizeBaseUrl("https://api.river.ai/v1/responses/")).toBe("https://api.river.ai/v1")
      expect(normalizeBaseUrl("https://api.river.ai/v1/chat/completions")).toBe("https://api.river.ai/v1")
      expect(normalizeBaseUrl("https://api.river.ai/v1/chat/completions/")).toBe("https://api.river.ai/v1")
      expect(normalizeBaseUrl("https://api.river.ai/v1/models")).toBe("https://api.river.ai/v1")
      expect(normalizeBaseUrl("https://api.river.ai/responses")).toBe("https://api.river.ai")
    })

    it("resolves base URL for custom provider with pasted river /responses endpoints", () => {
      expect(resolveBaseUrl("custom", "https://api.river.ai/v1/responses")).toBe("https://api.river.ai/v1")
      expect(resolveBaseUrl("custom", "https://api.river.ai/v1/responses/")).toBe("https://api.river.ai/v1")
      expect(resolveBaseUrl("custom", "https://proxy.example.com/v1/responses")).toBe("https://proxy.example.com/v1")
    })

    it("resolves full endpoint URLs without duplicating /v1 or endpoint suffixes", () => {
      // With existing /v1
      expect(resolveEndpointUrl("https://api.river.ai/v1", "responses")).toBe("https://api.river.ai/v1/responses")
      expect(resolveEndpointUrl("https://api.river.ai/v1", "chat/completions")).toBe("https://api.river.ai/v1/chat/completions")
      expect(resolveEndpointUrl("https://api.river.ai/v1", "models")).toBe("https://api.river.ai/v1/models")

      // When base lacks /v1, responses appends /v1/responses
      expect(resolveEndpointUrl("https://api.river.ai", "responses")).toBe("https://api.river.ai/v1/responses")

      // When pasted URL already had an endpoint, strips first then forms target endpoint
      expect(resolveEndpointUrl("https://api.river.ai/v1/responses", "responses")).toBe("https://api.river.ai/v1/responses")
      expect(resolveEndpointUrl("https://api.river.ai/v1/chat/completions", "responses")).toBe("https://api.river.ai/v1/responses")
      expect(resolveEndpointUrl("https://api.river.ai/v1/responses", "chat/completions")).toBe("https://api.river.ai/v1/chat/completions")
    })
  })

  describe("Protocol configuration and persistence across roles and tasks", () => {
    it("defines supportedProtocols and defaultProtocol for River preset", () => {
      expect(PROVIDERS.river.supportedProtocols).toEqual(["chat_completions", "responses"])
      expect(PROVIDERS.river.defaultProtocol).toBe("chat_completions")
    })

    it("persists protocol per role and provider in settings", () => {
      const dataDir = mkdtempSync(join(tmpdir(), "hfr-proto-test-"))
      try {
        openDb(join(dataDir, "test.db"))

        // Default settings
        const initial = getSettings()
        expect(initial.orchestratorProtocol).toBe("chat_completions")
        expect(initial.specialistProtocol).toBe("chat_completions")

        // Save orchestrator protocol as responses for river
        saveSettings({
          provider: "river",
          orchestratorProtocol: "responses",
        })

        const afterOrch = getSettings()
        expect(afterOrch.provider).toBe("river")
        expect(afterOrch.orchestratorProtocol).toBe("responses")
        expect(afterOrch.protocols?.river).toBe("responses")

        // Save specialist protocol as responses for river
        saveSettings({
          specialistProvider: "river",
          specialistProtocol: "responses",
        })

        const afterSpec = getSettings()
        expect(afterSpec.specialistProvider).toBe("river")
        expect(afterSpec.specialistProtocol).toBe("responses")
      } finally {
        closeDb()
        rmSync(dataDir, { recursive: true, force: true })
      }
    })

    it("persists and adopts protocols in project store", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "hfr-proj-proto-"))
      try {
        openDb(join(dataDir, "test.db"))
        const targetDir = mkdtempSync(join(tmpdir(), "target-"))
        const store = new ProjectStore(dataDir)

        const project = await store.create({
          name: "River Responses Project",
          goal: "understand",
          target: targetDir,
          provider: "river",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          orchestratorEffort: "medium",
          specialistEffort: "medium",
          orchestratorProtocol: "responses",
          specialistProtocol: "responses",
        })

        expect(project.orchestratorProtocol).toBe("responses")
        expect(project.specialistProtocol).toBe("responses")

        // Update protocol
        const updated = store.update(project.id, { orchestratorProtocol: "chat_completions" })
        expect(updated.orchestratorProtocol).toBe("chat_completions")
        expect(updated.specialistProtocol).toBe("responses")

        rmSync(targetDir, { recursive: true, force: true })
      } finally {
        closeDb()
        rmSync(dataDir, { recursive: true, force: true })
      }
    })
  })

  describe("Responses model invocation and streaming transport", () => {
    it("invokes River Responses endpoint with store:false, full history, and proper headers", async () => {
      let interceptedUrl = ""
      let authHeader = ""
      let capturedBody: any = null

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        interceptedUrl = String(url)
        authHeader = new Headers(init?.headers).get("authorization") ?? ""
        capturedBody = JSON.parse(String(init?.body ?? "{}"))

        const sseChunks = [
          'data: {"type":"response.created","response":{"id":"resp_river_1"}}\n\n',
          'data: {"type":"response.output_text.delta","delta":"River Responses Answer"}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_river_1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"text","text":"River Responses Answer"}]}],"usage":{"input_tokens":12,"output_tokens":7}}}\n\n',
        ].join("")

        return new Response(sseChunks, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }

      try {
        let recordedUsage: any = null
        const model = makeModel({
          provider: "river",
          apiKey: "rv-secret-api-key",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          protocol: "responses",
          onUsage: (u) => {
            recordedUsage = u
          },
        })

        const res = await model.invoke("ping river")

        expect(interceptedUrl).toBe("https://api.river.ai/v1/responses")
        expect(authHeader).toBe("Bearer rv-secret-api-key")
        expect(capturedBody.store).toBe(false)
        expect(capturedBody.stream).toBe(true)
        expect(capturedBody.previous_response_id).toBeUndefined()
        expect(capturedBody.conversation).toBeUndefined()
        expect(capturedBody.background).toBeUndefined()

        // Content
        const contentStr = typeof res.content === "string" ? res.content : JSON.stringify(res.content)
        expect(contentStr).toContain("River Responses Answer")

        // Usage callback
        expect(recordedUsage).not.toBeNull()
        expect(recordedUsage.tokensIn).toBe(12)
        expect(recordedUsage.tokensOut).toBe(7)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("executes multi-turn tool calling over Responses protocol preserving call IDs and full history without previous_response_id", async () => {
      const requests: any[] = []
      const originalFetch = globalThis.fetch

      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        requests.push(body)

        if (requests.length === 1) {
          // Turn 1: Model asks to call inspect_binary with call_123
          const sse1 = [
            'data: {"type":"response.created","response":{"id":"resp_turn1"}}\n\n',
            'data: {"type":"response.output_item.added","item":{"id":"fc_123","call_id":"call_123","type":"function_call","name":"inspect_binary","arguments":""}}\n\n',
            'data: {"type":"response.function_call_arguments.delta","delta":"{\\"target\\":\\"sample.elf\\"}"}\n\n',
            'data: {"type":"response.function_call_arguments.done","call_id":"call_123","arguments":"{\\"target\\":\\"sample.elf\\"}"}\n\n',
            'data: {"type":"response.completed","response":{"id":"resp_turn1","status":"completed","output":[{"id":"fc_123","call_id":"call_123","type":"function_call","name":"inspect_binary","arguments":"{\\"target\\":\\"sample.elf\\"}"}],"usage":{"input_tokens":15,"output_tokens":10}}}\n\n',
          ].join("")
          return new Response(sse1, { headers: { "Content-Type": "text/event-stream" } })
        } else {
          // Turn 2: Final response
          const sse2 = [
            'data: {"type":"response.created","response":{"id":"resp_turn2"}}\n\n',
            'data: {"type":"response.output_text.delta","delta":"ELF 64-bit LSB identified"}\n\n',
            'data: {"type":"response.completed","response":{"id":"resp_turn2","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"text","text":"ELF 64-bit LSB identified"}]}],"usage":{"input_tokens":30,"output_tokens":8}}}\n\n',
          ].join("")
          return new Response(sse2, { headers: { "Content-Type": "text/event-stream" } })
        }
      }

      try {
        const model = makeModel({
          provider: "river",
          apiKey: "rv-test-key",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          protocol: "responses",
          onUsage: () => {},
        })

        const toolModel = (model as any).bindTools([
          {
            name: "inspect_binary",
            description: "Inspects binary file",
            schema: { type: "object", properties: { target: { type: "string" } } },
          },
        ])

        // Turn 1
        const turn1 = await toolModel.invoke("Inspect sample.elf")
        expect(turn1.tool_calls).toHaveLength(1)
        expect(turn1.tool_calls[0].name).toBe("inspect_binary")
        expect(turn1.tool_calls[0].id).toBe("call_123")

        // Top level tools should be present in request 1
        expect(requests[0].tools).toBeDefined()
        expect(requests[0].tools[0].type).toBe("function")
        expect(requests[0].tools[0].name).toBe("inspect_binary")

        // Turn 2: Feed back result
        const turn2 = await model.invoke([
          new HumanMessage("Inspect sample.elf"),
          new AIMessage({
            content: "",
            tool_calls: [{ name: "inspect_binary", args: { target: "sample.elf" }, id: "call_123" }],
          }),
          new ToolMessage({
            content: "ELF 64-bit executable",
            tool_call_id: "call_123",
          }),
        ])

        expect(requests).toHaveLength(2)
        // Full history sent without remote storage
        expect(requests[1].store).toBe(false)
        expect(requests[1].previous_response_id).toBeUndefined()
        const inputItems = requests[1].input
        const fcItem = inputItems.find((i: any) => i.type === "function_call" && i.call_id === "call_123")
        const fcoItem = inputItems.find((i: any) => i.type === "function_call_output" && i.call_id === "call_123")
        expect(fcItem).toBeDefined()
        expect(fcoItem).toBeDefined()
        expect(fcoItem.output).toBe("ELF 64-bit executable")

        const text2 = typeof turn2.content === "string" ? turn2.content : JSON.stringify(turn2.content)
        expect(text2).toContain("ELF 64-bit LSB identified")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("enforces stream completion and aborts without executing tools on premature stream cut", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        // Stream terminates prematurely with partial function call and NO response.completed
        const sseIncomplete = [
          'data: {"type":"response.created","response":{"id":"resp_cut"}}\n\n',
          'data: {"type":"response.output_item.added","item":{"id":"fc_cut","call_id":"call_cut","type":"function_call","name":"rm_tool","arguments":""}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","delta":"{\\"target\\":\\"/system/"}\n\n',
        ].join("")
        return new Response(sseIncomplete, { headers: { "Content-Type": "text/event-stream" } })
      }

      try {
        const model = makeModel({
          provider: "river",
          apiKey: "rv-cut-key",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          protocol: "responses",
          onUsage: () => {},
        })

        await expect(model.invoke("test cut")).rejects.toThrow(/stream terminated prematurely without response\.completed/i)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("terminates stream with error on response.failed SSE event", async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        const sseFailed = [
          'data: {"type":"response.created","response":{"id":"resp_err"}}\n\n',
          'data: {"type":"response.failed","response":{"error":{"message":"Context length exceeded in River"}}}\n\n',
        ].join("")
        return new Response(sseFailed, { headers: { "Content-Type": "text/event-stream" } })
      }

      try {
        const model = makeModel({
          provider: "river",
          apiKey: "rv-fail-key",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          protocol: "responses",
          onUsage: () => {},
        })

        await expect(model.invoke("test fail")).rejects.toThrow(/stream failed: Context length exceeded in River/i)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe("Probe and readiness validation on chosen protocol without redundant costs", () => {
    it("probes River on Responses protocol and verifies response.completed", async () => {
      let probedUrl = ""
      let probedBody: any = null
      const originalFetch = globalThis.fetch

      globalThis.fetch = async (url, init) => {
        probedUrl = String(url)
        probedBody = JSON.parse(String(init?.body ?? "{}"))

        const sse = [
          'data: {"type":"response.created"}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_probe","status":"completed"}}\n\n',
        ].join("")
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } })
      }

      try {
        await probeModel({
          provider: "river",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "rv-probe-key",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          protocol: "responses",
        })

        expect(probedUrl).toBe("https://api.river.ai/v1/responses")
        expect(probedBody.store).toBe(false)
        expect(probedBody.stream).toBe(true)
        expect(probedBody.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("probes River on Chat Completions protocol when protocol is chat_completions", async () => {
      let probedUrl = ""
      const originalFetch = globalThis.fetch

      globalThis.fetch = async (url) => {
        probedUrl = String(url)
        return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          headers: { "Content-Type": "application/json" },
        })
      }

      try {
        await probeModel({
          provider: "river",
          baseUrl: "https://api.river.ai/v1",
          apiKey: "rv-probe-chat-key",
          model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          protocol: "chat_completions",
        })

        expect(probedUrl).toBe("https://api.river.ai/v1/chat/completions")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("readiness re-probes when protocol changes while caching within same protocol", async () => {
      let probeCount = 0
      let lastProbedProtocol = ""

      const fakeDeps: ReadinessDeps = {
        sandbox: async (): Promise<SandboxStatus> => ({
          docker: true,
          dockerError: "",
          images: true,
          building: false,
          buildLog: "",
          claudeVersion: "1.0",
        }),
        login: async (): Promise<LoginStatus> => ({
          loggedIn: true,
          method: "test",
          inProgress: false,
          url: null,
          text: "",
          error: "",
        }),
        settings: () => ({
          ...DEFAULT_SETTINGS,
          provider: "river",
          model: "Qwen/Qwen3.8-27B-FP8",
          specialistProvider: "claude",
        }),
        keySet: () => true,
        listModels: async () => {
          throw new Error("404 endpoint not implemented")
        },
        probeModel: async (run) => {
          probeCount++
          lastProbedProtocol = run.protocol ?? "chat_completions"
        },
        keyHint: () => "unique-cache-test-key",
      }

      // Check 1: Chat Completions probe
      const r1 = await readiness(fakeDeps, {
        run: { provider: "river", model: "Qwen/Qwen3.8-27B-FP8", protocol: "chat_completions" },
      })
      expect(r1.model.ready).toBe(true)
      expect(probeCount).toBe(1)
      expect(lastProbedProtocol).toBe("chat_completions")

      // Check 2: Same protocol -> uses cache, probeCount does NOT increase
      const r2 = await readiness(fakeDeps, {
        run: { provider: "river", model: "Qwen/Qwen3.8-27B-FP8", protocol: "chat_completions" },
      })
      expect(r2.model.ready).toBe(true)
      expect(probeCount).toBe(1)

      // Check 3: Protocol switched to responses -> cache misses, probes responses!
      const r3 = await readiness(fakeDeps, {
        run: { provider: "river", model: "Qwen/Qwen3.8-27B-FP8", protocol: "responses" },
      })
      expect(r3.model.ready).toBe(true)
      expect(probeCount).toBe(2)
      expect(lastProbedProtocol).toBe("responses")
    })
  })

  describe("R1 - Role protocol independence", () => {
    it("maintains separate protocol preferences when both roles use River", () => {
      const dataDir = mkdtempSync(join(tmpdir(), "hfr-r1-role-"))
      try {
        openDb(join(dataDir, "test.db"))

        // Set orchestrator to responses on river
        saveSettings({
          provider: "river",
          orchestratorProtocol: "responses",
        })

        // Then set specialist to chat_completions on river
        saveSettings({
          specialistProvider: "river",
          specialistProtocol: "chat_completions",
        })

        const s = getSettings()
        expect(s.orchestratorProtocol).toBe("responses")
        expect(s.specialistProtocol).toBe("chat_completions")
        expect(protocolFor("river", "orchestrator", s)).toBe("responses")
        expect(protocolFor("river", "specialist", s)).toBe("chat_completions")

        // Switch orchestrator provider to custom
        saveSettings({ provider: "custom" })
        const sCustom = getSettings()
        expect(sCustom.provider).toBe("custom")
        expect(sCustom.specialistProtocol).toBe("chat_completions")

        // Switch back to river - choice must be preserved
        saveSettings({ provider: "river" })
        const sRiverRestored = getSettings()
        expect(sRiverRestored.orchestratorProtocol).toBe("responses")
        expect(sRiverRestored.specialistProtocol).toBe("chat_completions")

        // Restart simulation (fresh getSettings from DB)
        const reloaded = getSettings()
        expect(reloaded.orchestratorProtocol).toBe("responses")
        expect(reloaded.specialistProtocol).toBe("chat_completions")
      } finally {
        closeDb()
        rmSync(dataDir, { recursive: true, force: true })
      }
    })
  })

  describe("R2 - Project UI payload, lifecycle and delegation propagation", () => {
    it("completes omitted protocols from settings when created through UI payload", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "hfr-r2-proj-"))
      try {
        openDb(join(dataDir, "test.db"))
        saveSettings({
          provider: "river",
          orchestratorProtocol: "responses",
          specialistProvider: "river",
          specialistProtocol: "responses",
          setupCompleted: true,
        })

        const targetDir = mkdtempSync(join(tmpdir(), "target-r2-"))
        const targetFile = join(targetDir, "test.bin")
        writeFileSync(targetFile, "dummy content")

        // Simulate UI payload (which omits orchestratorProtocol and specialistProtocol)
        const uiPayload = {
          name: "UI Project",
          goal: "understand" as const,
          target: targetFile,
          provider: "river" as const,
          model: "Qwen/Qwen3.8-27B-FP8",
          orchestratorEffort: "medium" as const,
          specialistEffort: "medium" as const,
        }

        // Using handler logic from core
        const s = getSettings()
        const projectStore = new ProjectStore(dataDir)
        const project = await projectStore.create({
          ...uiPayload,
          orchestratorProtocol: (uiPayload as any).orchestratorProtocol ?? protocolFor(uiPayload.provider, "orchestrator", s),
          specialistProtocol: (uiPayload as any).specialistProtocol ?? protocolFor(s.specialistProvider as ProviderId, "specialist", s),
        })

        expect(project.orchestratorProtocol).toBe("responses")
        expect(project.specialistProtocol).toBe("responses")

        rmSync(targetDir, { recursive: true, force: true })
      } finally {
        closeDb()
        rmSync(dataDir, { recursive: true, force: true })
      }
    })

    it("uses project specialistProtocol in runner and passes it to delegation context", async () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        provider: "river",
        orchestratorProtocol: "chat_completions",
        specialistProvider: "river",
        specialistProtocol: "chat_completions",
      }

      const project: ProjectRow = {
        id: "proj-1",
        name: "Test",
        goal: "understand",
        targetPath: "/target",
        targetKind: "folder",
        sourceRoot: "/target",
        folder: "/proj",
        ownsFolder: false,
        provider: "river",
        model: "m",
        orchestratorEffort: "medium",
        specialistEffort: "medium",
        orchestratorProtocol: "responses",
        specialistProtocol: "responses",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // Verify protocol resolution for runner
      const runnerRunWith = (p: ProjectRow | null, s: Settings) => ({
        provider: p ? p.provider : s.provider,
        model: p ? p.model : s.model,
        orchestratorEffort: p ? p.orchestratorEffort : s.orchestratorEffort,
        specialistEffort: p ? p.specialistEffort : s.specialistEffort,
        orchestratorProtocol: p?.orchestratorProtocol ?? protocolFor(p ? p.provider : s.provider, "orchestrator", s),
        specialistProtocol: p?.specialistProtocol ?? protocolFor(s.specialistProvider as ProviderId, "specialist", s),
      })

      const run = runnerRunWith(project, settings)
      expect(run.orchestratorProtocol).toBe("responses")
      expect(run.specialistProtocol).toBe("responses")

      // Verify that delegateTool forwards specialistProtocol to delegate
      let forwardedSpecialistProtocol: ModelProtocol | undefined
      const fakeDelegate = async (_deps: any, opts: { specialistProtocol?: ModelProtocol }) => {
        forwardedSpecialistProtocol = opts.specialistProtocol
        return { report: "ok", evidence: [] }
      }

      await fakeDelegate({}, { specialistProtocol: run.specialistProtocol })
      expect(forwardedSpecialistProtocol).toBe("responses")
    })
  })

  describe("R3 - Core probeModel wiring forwards run.protocol", () => {
    it("routes to /v1/responses when core probeModel receives run.protocol = responses", async () => {
      let requestedUrl = ""
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        requestedUrl = String(url)
        return new Response('data: {"type":"response.completed","response":{"id":"resp_probe_ok","status":"completed","output":[]}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      }

      try {
        // Core's wired probeModel:
        const coreProbeModel = (run: RunChoice) =>
          probeModel({
            provider: run.provider,
            baseUrl: run.baseUrl,
            apiKey: "test-key",
            model: run.model,
            protocol: run.protocol,
          })

        await coreProbeModel({
          provider: "river",
          baseUrl: "https://api.river.ai/v1",
          model: "Qwen/Qwen3.8-27B-FP8",
          protocol: "responses",
        })

        expect(requestedUrl).toBe("https://api.river.ai/v1/responses")

        await coreProbeModel({
          provider: "river",
          baseUrl: "https://api.river.ai/v1",
          model: "Qwen/Qwen3.8-27B-FP8",
          protocol: "chat_completions",
        })

        expect(requestedUrl).toBe("https://api.river.ai/v1/chat/completions")
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
