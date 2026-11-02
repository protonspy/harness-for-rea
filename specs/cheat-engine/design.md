# Cheat engine — design

## What changes

Serves R1.1–R3.4, the first integration of specs/mcp-integrations/, under
adr:0026-proxy-host-engines-to-the-agents-as-mcp-integrations.

- `sandbox/cheat-engine/hfr-bridge.lua` (new) — the bridge, derived from
  `miscusi-peek/cheatengine-mcp-bridge` at commit `6bd7ce90479250a9b4b75e7944df9c105ecb2572`
  (2026-08-14), with its MIT notice and that commit in its header (R2.3). It keeps the upstream
  transport — a named pipe, each message a 4-byte little-endian length and a JSON-RPC 2.0 body —
  on its own pipe, `\\.\pipe\hfr-cheat-engine`, so it never answers for the upstream bridge. Its
  `commandHandlers` table holds only the catalog's methods plus `ping`, `open_process` and
  `get_opened_process_id`; every other upstream handler is deleted, not disabled, and an unknown
  method gets `-32601` (R2.1, R2.2). `ping` returns the bridge's version and Cheat Engine's.
  Its handlers are locals and its start and stop are `HfrBridgeStart`/`HfrBridgeStop`, so it
  loads beside the upstream bridge in the same Lua state without either replacing the other's.
  `open_process` drops the last value scan, so a process never reads another's scan results.
  Shipped under `sandbox/`, which `electron-builder.yml` already packs and `host.sandboxDir`
  already locates.
- `src/shared/cheatengine.ts` (new) — the integration's `IntegrationInfo`: the executable path
  as its setting (R1.1), the process target `{ pid }` (R3.1), the install action, and the
  catalog: `status`, `get_process_list` and the read commands of R2.1, each with its bridge
  method and argument schema, `read_memory`'s length capped at 64 KB. Every schema is strict, and
  an address is a number or an address expression with no parentheses, quotes, commas or
  semicolons; a module or symbol name has no brackets either. The executable is a local `.exe`,
  never a network path. `validate_pointer_chains` takes `target_address`, passed to the bridge as its
  `target`, so it never reads as the integration's target. `status` and `get_process_list`
  default to the orchestrator and need no target (R2.5, R3.2).
- `src/main/cheatengine/pipe.ts` (new) — the pipe client: `net.connect` on the pipe path
  (injectable, so tests use a local socket), the framing, one call in flight at a time, a
  timeout per call counted from when it is queued, so a call that waited it out is dropped unsent,
  and `exclusive` for calls that must run with nothing between them.
- `src/main/cheatengine/integration.ts` (new) — the host side the registry calls:
  - `checks`: the executable exists, the bridge is in `<Cheat Engine folder>/autorun/`, and
    `ping` answers with the app's bridge version, each failure with its fix (R1.2);
  - the install action copies the bridge there, and on a write error returns the paths to copy
    by hand (R1.3, R1.4);
  - `status` answers R2.4 from `ping` and the catalog;
  - `describeTarget` reads the process's name and executable path for the approval (R3.1), and
    `identify` adds its start time, so an approval of a pid Windows reused is asked again (R3.4);
  - `session(pid)` opens the process in the bridge, and before every call checks that the PID is
    alive and, in one exclusive unit with the call, that `get_opened_process_id` is still the PID,
    so another session's `open_process` cannot land between the check and the read (R3.3, R3.4).

## Testing

- The integration's checks, install, status and session run in Vitest against a fake bridge on
  a local socket that speaks the same framing.
- A test reads `hfr-bridge.lua`'s `commandHandlers` keys and holds them equal to the catalog's
  methods plus `ping`, `open_process` and `get_opened_process_id`, so a handler added to the
  Lua without the catalog fails.
- The bridge inside a real Cheat Engine is checked by running the app.
