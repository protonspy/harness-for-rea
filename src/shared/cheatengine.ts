import { z } from "zod"
import type { IntegrationInfo, IntegrationTool } from "./integrations"

/*
  The Cheat Engine integration (specs/cheat-engine): its setting, its target — one process by PID — its
  install action and its catalog. Every tool but `status` is one method of the app's bridge,
  sandbox/cheat-engine/hfr-bridge.lua, which answers these methods and three of its own and nothing else.
*/

export const CHEAT_ENGINE = "cheat-engine"
/** The bridge's version, which its `ping` answers with; a bridge that answers another is out of date. */
export const BRIDGE_VERSION = "hfr-1"
/** The bridge's own pipe, never the upstream bridge's (adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations). */
export const BRIDGE_PIPE = "\\\\.\\pipe\\hfr-cheat-engine"
/** The bridge script's file name, in the app's `sandbox/cheat-engine/` and in Cheat Engine's `autorun/`. */
export const BRIDGE_FILE = "hfr-bridge.lua"
/** The bridge's methods the app calls itself and no agent does. */
export const BRIDGE_INTERNAL = ["ping", "open_process", "get_opened_process_id"] as const
/** The most bytes one `read_memory` returns. */
export const READ_MEMORY_CAP = 64 * 1024

export const CheatEngineConfigSchema = z
  .object({
    // Empty, or a local .exe: never a network path, which the checks would reach out to.
    executablePath: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (p) => p === "" || (/^([A-Za-z]:[\\/]|\/(?![\\/]))/.test(p) && /\.exe$/i.test(p)),
        "Give the local path to Cheat Engine's .exe, not a network path.",
      ),
  })
  .strict()
export type CheatEngineConfig = z.infer<typeof CheatEngineConfigSchema>

/** The approved process, by PID (R3.1). */
export const ProcessTargetSchema = z.object({ pid: z.number().int().positive().max(0xffffffff).describe("The process id, from get_process_list.") }).strict()
export type ProcessTarget = z.infer<typeof ProcessTargetSchema>

/**
  An address as Cheat Engine reads one: a number, or text such as `0x14000100`, `game.exe+1A2B` or `[[game.exe+10]+8]`.
  No parentheses, quotes, commas or semicolons, so the text is an address expression and nothing more.
*/
const Address = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w .+\-*[\]:!@$?#]+$/, "An address is a number, a hex string or module+offset, with no parentheses, quotes, commas or semicolons."),
])
/** A module or symbol name: no brackets, so no pointer dereference, and none of an address's other syntax beyond `+`. */
const Name = z
  .string()
  .trim()
  .min(1)
  .max(260)
  .regex(/^[\w .+\-:!@$?#<>~]+$/, "A name is a module or symbol name, such as kernel32.dll or kernel32.CreateFileW.")
const Pattern = z
  .string()
  .trim()
  .min(2)
  .max(600)
  .regex(/^[0-9A-Fa-f?* ]+$/, "A pattern is hex bytes separated by spaces, with ?? for a wildcard.")
const Protection = z
  .string()
  .regex(/^[+\-*][WXC+\-*]{0,8}$/)
  .optional()
  .describe("Cheat Engine's protection filter, such as +X (executable) or +W-C (writable, not copy-on-write).")
const Offset = z.number().int().min(0).max(10_000_000).optional().describe("Start index, for paging.")
const Limit = z.number().int().min(1).max(1000).optional().describe("Most items returned (default 100).")
const Offsets = z.array(z.number().int().min(-0x7fffffff).max(0x7fffffff)).max(16)
const VALUE_TYPES = ["byte", "word", "dword", "qword", "float", "double", "string"] as const
const SCAN_VALUE = z.string().max(200).optional()

type ToolDef = Omit<IntegrationTool, "schema" | "target" | "orchestratorDefault"> & {
  shape: z.ZodRawShape
  target?: boolean
  orchestratorDefault?: boolean
}

/** A tool on the approved process, unless it says otherwise; checked for the specialist alone unless it says otherwise. */
const define = (d: ToolDef): IntegrationTool => ({
  name: d.name,
  description: d.description,
  schema: z.object(d.shape).strict(),
  target: d.target ?? true,
  orchestratorDefault: d.orchestratorDefault ?? false,
})

/** The catalog: the tools of R2.1, `status` (R2.4), and the defaults of R2.5 and R3.2. */
export const CHEAT_ENGINE_TOOLS: IntegrationTool[] = [
  define({
    name: "status",
    description: "Whether Cheat Engine and its bridge are connected, their versions, and the names of this integration's tools. Reads no process memory.",
    shape: {},
    target: false,
    orchestratorDefault: true,
  }),
  define({
    name: "get_process_list",
    description: "The processes running on the user's Windows machine, each with its pid and name. Reads no process memory.",
    shape: {},
    target: false,
    orchestratorDefault: true,
  }),
  define({
    name: "enum_modules",
    description: "The modules (EXE and DLLs) loaded in the process, with their base addresses and sizes.",
    shape: { offset: Offset, limit: Limit },
  }),
  define({ name: "get_module_size", description: "The in-memory size of one loaded module.", shape: { module_name: Name } }),
  define({
    name: "enum_memory_regions_full",
    description: "The process's memory regions with their base, size, protection and state.",
    shape: { offset: Offset, limit: Limit },
  }),
  define({
    name: "read_memory",
    description: `Read raw bytes from the process's memory, as hex. At most ${READ_MEMORY_CAP} bytes per call.`,
    shape: { address: Address, size: z.number().int().min(1).max(READ_MEMORY_CAP).optional() },
  }),
  define({
    name: "read_integer",
    description: "Read one number from the process's memory.",
    shape: { address: Address, type: z.enum(["byte", "word", "dword", "qword", "float", "double"]).optional() },
  }),
  define({
    name: "read_string",
    description: "Read a string from the process's memory.",
    shape: {
      address: Address,
      max_length: z.number().int().min(1).max(4096).optional(),
      encoding: z.enum(["ascii", "utf8", "utf16le", "raw"]).optional(),
    },
  }),
  define({
    name: "read_pointer_chain",
    description: "Follow a pointer chain from a base address through each offset, and report every step.",
    shape: { base: Address, offsets: Offsets },
  }),
  define({
    name: "validate_pointer_chains",
    description: "Resolve candidate pointer chains and report which land on the target address now.",
    shape: {
      chains: z
        .array(z.object({ base: Address, offsets: Offsets }).strict())
        .min(1)
        .max(100),
      target_address: Address,
      include_misses: z.boolean().optional(),
    },
  }),
  define({
    name: "aob_scan",
    description: "Scan the process's memory for a byte pattern, such as '48 89 5C 24 ?? 57'.",
    shape: { pattern: Pattern, protection: Protection, limit: Limit },
  }),
  define({
    name: "aob_scan_unique",
    description: "Scan for a byte pattern that must match exactly once; returns its address, or the count when it does not.",
    shape: { pattern: Pattern, protection: Protection },
  }),
  define({
    name: "aob_scan_module",
    description: "Scan one module's memory for a byte pattern.",
    shape: { pattern: Pattern, module_name: Name, protection: Protection },
  }),
  define({
    name: "aob_scan_module_unique",
    description: "Scan one module's memory for a byte pattern that must match exactly once.",
    shape: { pattern: Pattern, module_name: Name, protection: Protection },
  }),
  define({
    name: "search_string",
    description: "Search the process's memory for a text string.",
    shape: { string: z.string().min(1).max(200), wide: z.boolean().optional(), limit: Limit },
  }),
  define({
    name: "scan_all",
    description:
      "First value scan of the process's memory: exact, unknown, between, bigger or smaller. Narrow the results with next_scan and read them with get_scan_results.",
    shape: {
      value: SCAN_VALUE,
      type: z.enum(VALUE_TYPES).optional(),
      protection: Protection,
      scan_option: z.enum(["exact", "unknown", "between", "bigger", "smaller"]).optional(),
      value2: SCAN_VALUE,
    },
  }),
  define({
    name: "next_scan",
    description: "Narrow the last scan_all's results by the values now in memory.",
    shape: {
      value: SCAN_VALUE,
      scan_option: z
        .enum(["exact", "between", "bigger", "smaller", "increased", "increased_by", "decreased", "decreased_by", "changed", "unchanged"])
        .optional(),
      value2: SCAN_VALUE,
    },
  }),
  define({ name: "get_scan_results", description: "The addresses and values the last scan left.", shape: { offset: Offset, limit: Limit } }),
  define({
    name: "disassemble",
    description: "Disassemble instructions starting at an address.",
    shape: { address: Address, count: z.number().int().min(1).max(500).optional(), offset: Offset, limit: Limit },
  }),
  define({ name: "get_instruction_info", description: "One instruction's size, bytes and opcode.", shape: { address: Address } }),
  define({
    name: "find_function_boundaries",
    description: "The start and end of the function holding an address.",
    shape: { address: Address, max_search: z.number().int().min(16).max(65536).optional() },
  }),
  define({ name: "analyze_function", description: "The calls a function makes.", shape: { address: Address } }),
  define({
    name: "find_references",
    description: "Instructions that reference an address.",
    shape: { address: Address, offset: Offset, limit: Limit },
  }),
  define({
    name: "find_call_references",
    description: "Instructions that call a function.",
    shape: { address: Address, offset: Offset, limit: Limit },
  }),
  define({ name: "get_symbol_address", description: "The address of a symbol, such as 'kernel32.CreateFileW'.", shape: { symbol: Name } }),
  define({ name: "get_symbol_info", description: "A known symbol's address, module and size.", shape: { name: Name } }),
  define({
    name: "get_address_info",
    description: "The symbol, module and section an address belongs to.",
    shape: {
      address: Address,
      include_modules: z.boolean().optional(),
      include_symbols: z.boolean().optional(),
      include_sections: z.boolean().optional(),
    },
  }),
  define({ name: "get_rtti_classname", description: "The C++ class of the object at an address, from its RTTI.", shape: { address: Address } }),
  define({
    name: "dissect_structure",
    description: "Guess the fields of the structure at an address with Cheat Engine's structure dissector.",
    shape: { address: Address, size: z.number().int().min(1).max(4096).optional() },
  }),
]

/** The bridge method behind a tool, and its parameters, where they differ from the tool's own. */
export function bridgeCall(tool: string, args: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  if (tool === "validate_pointer_chains") {
    const { target_address, ...rest } = args
    return { method: tool, params: { ...rest, target: target_address } }
  }
  return { method: tool, params: args }
}

/** The bridge methods the catalog needs: every tool but `status`, which the app answers itself. */
export const BRIDGE_METHODS = CHEAT_ENGINE_TOOLS.filter((t) => t.name !== "status").map((t) => t.name)

export const CHEAT_ENGINE_INFO: IntegrationInfo = {
  id: CHEAT_ENGINE,
  title: "Cheat Engine",
  description:
    "Reads the live memory of a Windows process you approve, through Cheat Engine on this machine and the read-only bridge the app installs in it. Cheat Engine must be open for the agents to use it.",
  settingsSchema: CheatEngineConfigSchema,
  defaultConfig: { executablePath: "" },
  fields: [
    {
      key: "executablePath",
      label: "Cheat Engine executable",
      hint: "The full path, such as C:\\Program Files\\Cheat Engine 7.6\\cheatengine-x86_64.exe. The bridge goes into the autorun folder beside it.",
    },
  ],
  targetSchema: ProcessTargetSchema,
  targetDescription: "one Windows process, given by its pid",
  actions: [
    {
      id: "install-bridge",
      label: "Install the bridge",
      description: "Copy the app's read-only bridge script into Cheat Engine's autorun folder; restart Cheat Engine after.",
    },
  ],
  tools: CHEAT_ENGINE_TOOLS,
}
