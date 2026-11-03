import { z } from "zod"
import type { IntegrationInfo, IntegrationTool } from "./integrations"

/*
  The IDA Pro integration (specs/ida-pro): its setting, its target — one database by the SHA-256 of its input file —
  its install action and its catalog. Every tool but `status` is one tool of the app's plugin, sandbox/ida-pro/,
  which answers these tools and two methods of its own and nothing else
  (adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe). The schemas mirror upstream's parameters, bounded by
  upstream's own maxima.
*/

export const IDA_PRO = "ida-pro"
/** The plugin's version, which its `ping` answers with; a plugin that answers another is out of date. */
export const PLUGIN_VERSION = "hfr-ida-1"
/** The plugin's own pipe. */
export const PLUGIN_PIPE = "\\\\.\\pipe\\hfr-ida"
/** The plugin's entry file and package, in the app's `sandbox/ida-pro/` and in IDA's user `plugins/`. */
export const PLUGIN_ENTRY = "hfr_ida_plugin.py"
export const PLUGIN_PACKAGE = "hfr_ida"
/** The plugin's methods the app calls itself and no agent does. */
export const PLUGIN_INTERNAL = ["ping", "get_database"] as const

export const IdaProConfigSchema = z
  .object({
    // Empty for %APPDATA%\Hex-Rays\IDA Pro, or a local folder: never a network path, which the checks would reach out to.
    userDir: z
      .string()
      .trim()
      .max(1000)
      .refine((p) => p === "" || /^([A-Za-z]:[\\/]|\/(?![\\/]))/.test(p), "Give the local path to IDA's user folder, not a network path."),
  })
  .strict()
export type IdaProConfig = z.infer<typeof IdaProConfigSchema>

/** The approved database, by its input file's SHA-256 (R3.1). */
export const DatabaseTargetSchema = z
  .object({
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .transform((s) => s.toLowerCase())
      .describe("The SHA-256 of the database's input file, from status."),
  })
  .strict()
export type DatabaseTarget = z.infer<typeof DatabaseTargetSchema>

/** An address or a name, as upstream resolves it: `0x401000`, `4198400` or `main`. */
const Addr = z.string().trim().min(1).max(1000)
/** One address or name, a list, or a comma-separated string, as upstream's `normalize_list_input` takes them. */
const Addrs = z.union([Addr, z.array(Addr).min(1).max(100)])
const Text = z.string().max(1000)
const Count = (max: number) => z.number().int().min(0).max(max)
const Offset = z.number().int().min(0).max(100_000_000)
/** One query, or several, as upstream's `list[X] | X`. */
const oneOrMany = (o: z.ZodObject<z.ZodRawShape>) => z.union([o, z.array(o).min(1).max(50)])
const query = (shape: z.ZodRawShape) => oneOrMany(z.object(shape).strict())

const Paging = { offset: Offset.optional(), count: Count(100_000).optional().describe("Max results (0 = all).") }

type ToolDef = Omit<IntegrationTool, "schema" | "target" | "orchestratorDefault"> & {
  shape: z.ZodRawShape
  target?: boolean
  orchestratorDefault?: boolean
}

/** A tool on the approved database, unless it says otherwise; checked for the specialist alone unless it says otherwise. */
const define = (d: ToolDef): IntegrationTool => ({
  name: d.name,
  description: d.description,
  schema: z.object(d.shape).strict(),
  target: d.target ?? true,
  orchestratorDefault: d.orchestratorDefault ?? false,
})

/** The catalog: upstream's read-only profile (R2.1), `status` (R2.4), and the defaults of R2.5 and R3.2. */
export const IDA_PRO_TOOLS: IntegrationTool[] = [
  define({
    name: "status",
    description:
      "Whether IDA Pro and its plugin are connected, their versions, the open database's input file name, database file name and SHA-256, and the names of this integration's tools. Reads nothing else from the database.",
    shape: {},
    target: false,
    orchestratorDefault: true,
  }),
  define({
    name: "int_convert",
    description: "Convert numbers between hex, decimal, binary and ASCII. Use it rather than converting bases yourself.",
    shape: {
      inputs: query({ text: z.string().min(1).max(200).describe("The number to convert."), size: z.number().int().min(1).max(64).optional() }),
    },
    target: false,
  }),
  define({ name: "server_health", description: "The plugin's health and the open database's state: path, auto-analysis, decompiler.", shape: {} }),

  // Listings and queries
  define({
    name: "list_funcs",
    description: "List functions with an optional glob filter and offset/count paging.",
    shape: { queries: query({ filter: Text.optional(), ...Paging }) },
  }),
  define({
    name: "func_query",
    description: "Query functions by name, size and type, sorted and paged.",
    shape: {
      queries: query({
        filter: Text.optional(),
        name_regex: Text.optional(),
        min_size: z.number().int().min(0).optional(),
        max_size: z.number().int().min(0).optional(),
        has_type: z.boolean().optional(),
        ...Paging,
        sort_by: z.enum(["addr", "name", "size"]).optional(),
        descending: z.boolean().optional(),
      }),
    },
  }),
  define({ name: "lookup_funcs", description: "Get functions by address or name.", shape: { queries: Addrs } }),
  define({
    name: "list_globals",
    description: "List global variables with an optional glob filter and offset/count paging.",
    shape: { queries: query({ filter: Text.optional(), ...Paging }) },
  }),
  define({
    name: "entity_query",
    description: "Query functions, globals, imports, strings or names with filters, address bounds, projection and paging.",
    shape: {
      queries: query({
        kind: z.enum(["functions", "globals", "imports", "strings", "names"]),
        filter: Text.optional(),
        regex: Text.optional(),
        min_addr: Addr.optional(),
        max_addr: Addr.optional(),
        segment: Text.optional(),
        module: Text.optional(),
        ...Paging,
        sort_by: z.enum(["addr", "name", "size", "length"]).optional(),
        descending: z.boolean().optional(),
        fields: z.array(z.string().max(100)).max(50).optional(),
      }),
    },
  }),
  define({
    name: "imports",
    description: "List imports with their modules, paged by offset and count (0 returns all).",
    shape: { offset: Offset, count: Count(100_000) },
  }),
  define({
    name: "imports_query",
    description: "Query imports by name and module, paged.",
    shape: { queries: query({ filter: Text.optional(), module: Text.optional(), ...Paging }) },
  }),
  define({
    name: "find_regex",
    description: "Search the database's strings by case-insensitive regex, paged.",
    shape: { pattern: z.string().min(1).max(500), limit: Count(500).optional(), offset: Offset.optional() },
  }),

  // Decompilation, disassembly and cross-references
  define({
    name: "decompile",
    description: "Decompile a function. Follow cursor.next for more lines; references appear on the first page.",
    shape: {
      addr: Addr,
      include_addresses: z.boolean().optional(),
      max_lines: z.number().int().min(1).max(5000).optional(),
      offset: Offset.optional(),
    },
  }),
  define({
    name: "disasm",
    description: "Disassemble a function, paged by offset and max_instructions.",
    shape: {
      addr: Addr,
      max_instructions: z.number().int().min(1).max(50_000).optional(),
      offset: Offset.optional(),
      include_total: z.boolean().optional(),
    },
  }),
  define({
    name: "func_profile",
    description: "Profile functions with summary metrics and optional callers, callees, strings and constants.",
    shape: {
      queries: query({
        addr: Addr.optional(),
        filter: Text.optional(),
        ...Paging,
        sort_by: z.enum(["addr", "name", "size"]).optional(),
        descending: z.boolean().optional(),
        include_lists: z.boolean().optional(),
        max_items: Count(10_000).optional(),
        include_prototype: z.boolean().optional(),
      }),
    },
  }),
  define({
    name: "analyze_batch",
    description: "Comprehensive analysis of one or more functions, with selectable sections.",
    shape: {
      queries: query({
        addr: Addr,
        include_decompile: z.boolean().optional(),
        include_disasm: z.boolean().optional(),
        include_xrefs: z.boolean().optional(),
        include_callers: z.boolean().optional(),
        include_callees: z.boolean().optional(),
        include_strings: z.boolean().optional(),
        include_constants: z.boolean().optional(),
        include_basic_blocks: z.boolean().optional(),
        include_proto: z.boolean().optional(),
        max_disasm_insns: Count(50_000).optional(),
        max_callers: Count(10_000).optional(),
        max_callees: Count(10_000).optional(),
        max_strings: Count(10_000).optional(),
        max_constants: Count(10_000).optional(),
        max_blocks: Count(10_000).optional(),
      }),
    },
  }),
  define({
    name: "xrefs_to",
    description: "Cross-references to addresses or names, capped per target.",
    shape: { addrs: Addrs, limit: z.number().int().min(1).max(1000).optional() },
  }),
  define({
    name: "xref_query",
    description: "Query cross-references by direction and type, deduplicated, sorted and paged.",
    shape: {
      queries: query({
        addr: Addr,
        direction: z.enum(["to", "from", "both"]).optional(),
        xref_type: z.enum(["any", "code", "data"]).optional(),
        offset: Offset.optional(),
        count: Count(5000).optional(),
        include_fn: z.boolean().optional(),
        dedup: z.boolean().optional(),
        sort_by: z.enum(["addr", "type"]).optional(),
        descending: z.boolean().optional(),
      }),
    },
  }),
  define({
    name: "xrefs_to_field",
    description: "Cross-references to a structure's field.",
    shape: { queries: query({ struct: z.string().min(1).max(1000), field: z.string().min(1).max(1000) }) },
  }),
  define({
    name: "callees",
    description: "The unique functions each function calls.",
    shape: { addrs: Addrs, limit: z.number().int().min(1).max(500).optional() },
  }),
  define({
    name: "callgraph",
    description: "A bounded call graph from root functions.",
    shape: {
      roots: Addrs,
      max_depth: z.number().int().min(0).max(50).optional(),
      max_nodes: z.number().int().min(1).max(100_000).optional(),
      max_edges: z.number().int().min(1).max(200_000).optional(),
      max_edges_per_func: z.number().int().min(1).max(5000).optional(),
    },
  }),
  define({
    name: "basic_blocks",
    description: "A function's control-flow blocks, paged.",
    shape: { addrs: Addrs, max_blocks: z.number().int().min(1).max(10_000).optional(), offset: Offset.optional() },
  }),
  define({
    name: "export_funcs",
    description: "Export functions as JSON, a C header or prototypes.",
    shape: { addrs: Addrs, format: z.enum(["json", "c_header", "prototypes"]).optional() },
  }),
  define({
    name: "analyze_function",
    description: "Compact analysis of one function: pseudocode, strings, constants, callers, callees, xrefs and blocks.",
    shape: { addr: Addr, include_asm: z.boolean().optional() },
  }),
  define({
    name: "analyze_component",
    description: "Analyze related functions as a group: summaries, their internal call graph and shared data.",
    shape: { addrs: Addrs },
  }),
  define({
    name: "trace_data_flow",
    description: "Follow cross-references forward (from) or backward (to) an address, several levels deep.",
    shape: { addr: Addr, direction: z.enum(["forward", "backward"]).optional(), max_depth: z.number().int().min(1).max(20).optional() },
  }),

  // Searches
  define({
    name: "find_bytes",
    description: "Search byte patterns such as '48 8B ?? ??', paged.",
    shape: {
      patterns: z.union([z.string().min(2).max(600), z.array(z.string().min(2).max(600)).min(1).max(50)]),
      limit: z.number().int().min(1).max(10_000).optional(),
      offset: Offset.optional(),
    },
  }),
  define({
    name: "find",
    description: "Search strings, immediates, data references or code references, paged.",
    shape: {
      type: z.enum(["string", "immediate", "data_ref", "code_ref"]),
      targets: z.union([
        Text,
        z.number().int(),
        z
          .array(z.union([Text, z.number().int()]))
          .min(1)
          .max(50),
      ]),
      limit: z.number().int().min(1).max(10_000).optional(),
      offset: Offset.optional(),
    },
  }),
  define({
    name: "insn_query",
    description: "Find instructions by mnemonic and operands, scoped to a function, segment or address range.",
    shape: {
      queries: query({
        mnem: Text.optional(),
        op0: z.number().int().optional(),
        op1: z.number().int().optional(),
        op2: z.number().int().optional(),
        op_any: z.number().int().optional(),
        func: Addr.optional(),
        segment: Text.optional(),
        start: Addr.optional(),
        end: Addr.optional(),
        offset: Offset.optional(),
        count: Count(5000).optional(),
        max_scan_insns: z.number().int().min(1).max(10_000_000).optional(),
        include_fn: z.boolean().optional(),
        include_disasm: z.boolean().optional(),
        allow_broad: z.boolean().optional(),
      }),
    },
  }),

  // Types and the stack
  define({
    name: "type_query",
    description: "Query the database's local types, with declarations, members and relationships.",
    shape: {
      queries: query({
        filter: Text.optional(),
        kind: z.enum(["any", "struct", "union", "enum", "typedef", "func", "ptr", "udt"]).optional(),
        ...Paging,
        sort_by: z.enum(["name", "size", "ordinal"]).optional(),
        descending: z.boolean().optional(),
        include_decl: z.boolean().optional(),
        include_members: z.boolean().optional(),
        max_members: Count(10_000).optional(),
        include_relationships: z.boolean().optional(),
      }),
    },
  }),
  define({
    name: "read_struct",
    description: "Read a structure's fields at an address, detecting the type when none is given.",
    shape: { queries: query({ addr: Addr, struct: z.string().min(1).max(1000).optional() }) },
  }),
  define({ name: "stack_frame", description: "The stack variables of functions.", shape: { addrs: Addrs } }),

  // Reads of the database
  define({
    name: "get_bytes",
    description: "Read bytes from the database.",
    shape: { regions: query({ addr: Addr, size: z.number().int().min(1).max(65_536) }) },
  }),
  define({
    name: "get_int",
    description: "Read integers from the database; ty is i8, u16, i32le, u64be and so on.",
    shape: { queries: query({ addr: Addr, ty: z.string().regex(/^[iu](8|16|32|64)(le|be)?$/i) }) },
  }),
  define({ name: "get_string", description: "Read strings from the database.", shape: { addrs: Addrs } }),
  define({ name: "get_global_value", description: "Read global variables' values by address or name.", shape: { queries: Addrs } }),
]

/** The plugin's tools: every tool but `status`, which the app answers itself. */
export const PLUGIN_TOOLS = IDA_PRO_TOOLS.filter((t) => t.name !== "status").map((t) => t.name)

export const IDA_PRO_INFO: IntegrationInfo = {
  id: IDA_PRO,
  title: "IDA Pro",
  description:
    "Reads the database you have open in IDA Pro on this machine — decompilation, disassembly, cross-references, types and bytes — through the read-only plugin the app installs in it. IDA must be open with the database for the agents to use it.",
  settingsSchema: IdaProConfigSchema,
  defaultConfig: { userDir: "" },
  fields: [
    {
      key: "userDir",
      label: "IDA user folder",
      hint: "Leave empty for %APPDATA%\\Hex-Rays\\IDA Pro, or give your IDAUSR folder. The plugin goes into its plugins folder.",
    },
  ],
  targetSchema: DatabaseTargetSchema,
  targetDescription: "one IDA database, given by the SHA-256 of its input file",
  actions: [
    {
      id: "install-plugin",
      label: "Install the plugin",
      description: "Copy the app's read-only plugin into IDA's user plugins folder; reopen the database in IDA after.",
    },
  ],
  tools: IDA_PRO_TOOLS,
}
