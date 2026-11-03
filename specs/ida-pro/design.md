# Ida pro — design

## What changes

Serves R1.1–R3.4, the second integration of specs/mcp-integrations/, under
adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations and
adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe.

- `sandbox/ida-pro/` (new) — the plugin, derived from `mrexodia/ida-pro-mcp` at commit
  `c133c3853faa111a9b00ee615c013b720d0c4acd` (2026-09-26), with its MIT notice and that commit in
  `hfr_ida/UPSTREAM.md` and in each file's header (R2.3):
  - `hfr_ida_plugin.py` — the plugin entry IDA loads with each database. It replaces upstream's
    `ida_mcp.py`: no HTTP server, no config form, no netnode settings, no discovery file. It starts
    the pipe server when a database opens and stops it when the database closes, so the pipe exists
    only while there is a database to read (R3.4).
  - `hfr_ida/pipe.py` — a named-pipe server through `ctypes` on `\\.\pipe\hfr-ida`, the same
    transport as Cheat Engine's bridge: each message a 4-byte little-endian length and a JSON-RPC
    2.0 body, one client at a time, one instance (`FILE_FLAG_FIRST_PIPE_INSTANCE`), so a second IDA
    never answers for the first, and `PIPE_REJECT_REMOTE_CLIENTS` (R2.6). Its dispatch answers
    `ping` (plugin, IDA and Python versions), `get_database` (input file name, database path,
    SHA-256) and the tools of `hfr_ida.rpc.TOOLS`; any other method gets `-32601`, and wrong
    arguments `-32602` (R2.2).
  - `hfr_ida/rpc.py` — replaces upstream's `rpc.py` and its `zeromcp` server: `@tool` records the
    function in `TOOLS` and nothing serves them but the pipe. `McpToolError`, the cancel hooks
    `sync.py` imports and `OUTPUT_LIMIT_MAX_CHARS` are kept as plain names.
  - `api_core.py`, `api_analysis.py`, `api_memory.py`, `api_types.py`, `api_stack.py`,
    `api_composite.py` — upstream's, with every `@tool` not in upstream's
    `profiles/readonly.txt` deleted, not disabled (R2.1); `utils.py`, `compat.py`, `sync.py` and
    `mainthread.py` as upstream, `sync.py` importing its cancel hooks from `rpc.py`. A regex an
    agent sends goes through `utils.compile_user_regex`, which refuses repeated groups and
    backreferences and allows two unbounded repeats over 512 characters of each text: `re` runs in
    C on IDA's main thread, where the tool timeout cannot stop one search (n-0018). The
    package is `hfr_ida`, so it loads beside upstream's `ida_mcp` without either replacing the
    other's modules. Upstream's `api_modify`, `api_debug`, `api_python`, `api_sigmaker`,
    `api_survey`, `api_resources`, `trace`, `http`, `discovery`, `framework`, `zeromcp` and the
    `idalib` server are not shipped.
- `src/shared/idapro.ts` (new) — the integration's `IntegrationInfo`: the user folder as its
  setting (R1.1), the database target `{ sha256 }` (R3.1), the install action, and the catalog:
  `status` and the 34 tools of R2.1, each schema strict and mirroring upstream's parameters, with
  upstream's own maxima as bounds. `status` defaults to the orchestrator; `status` and
  `int_convert` need no target (R2.5, R3.2).
- `src/main/cheatengine/pipe.ts` — `BridgeClient` takes the engine's name for its errors, so IDA's
  calls say IDA. It already does the framing, one call in flight and `exclusive`; an `exclusive`
  unit now fails when its connection was reopened between its calls, since a new connection may
  reach another engine — Cheat Engine's sessions gain the same guarantee.
- `src/shared/cheatengine.ts` — its executable path, like IDA's user folder, refuses `/\host`, a
  network path the former check let through.
- `src/main/idapro/integration.ts` (new) — the host side the registry calls:
  - `checks`: every file of `sandbox/ida-pro/` is in `<user folder>/plugins/` byte for byte, and
    `ping` answers with the app's plugin version, each failure with its fix (R1.2);
  - the install action copies `hfr_ida_plugin.py` and `hfr_ida/` there, and on a write error returns the
    paths to copy by hand (R1.3, R1.4);
  - `status` answers R2.4 from `ping` and `get_database`, with file names rather than paths,
    since a path names the user's account and `status` goes to the orchestrator's provider;
  - `describeTarget` and `identify` read `get_database` and refuse a SHA-256 IDA does not have
    open (R3.1);
  - `session(sha256)` checks the open database at start and, in one exclusive unit with each call,
    that `get_database` is still that SHA-256 at the same database path (R3.3). The database
    closed and opened again is the same target; the same input in another database is not.
- `src/main/core.ts` registers it; `scripts/cli-sandbox.ts` and `tui/src/paths.ts` carry
  `ida-pro/` beside `cheat-engine/`.

## Testing

- The integration's checks, install, status and session run in Vitest against a fake plugin on a
  local socket that speaks the same framing.
- A test reads the `@tool` functions of `sandbox/ida-pro/hfr_ida/api_*.py` and holds them equal to
  the catalog's tools but `status`, and holds the plugin's internal methods to `ping` and
  `get_database`, so a tool added to the Python without the catalog fails.
- The plugin inside a real IDA Pro is checked by running the app.
