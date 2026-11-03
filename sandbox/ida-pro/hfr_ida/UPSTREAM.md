# Upstream

This package is derived from [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp) at commit
`c133c3853faa111a9b00ee615c013b720d0c4acd` (2026-09-26), under the MIT licence in `LICENSE`.

Kept, from `src/ida_pro_mcp/ida_mcp/`: `api_core.py`, `api_analysis.py`, `api_memory.py`, `api_types.py`,
`api_stack.py`, `api_composite.py`, `utils.py`, `compat.py`, `sync.py` and `mainthread.py`, with every tool
outside upstream's `profiles/readonly.txt` deleted, and the helpers only those tools used. `sync.py` imports its
cancel hooks from `rpc.py`.

Replaced: `rpc.py` (a tool table, no server), `__init__.py`, and `ida_mcp.py` by `../hfr_ida_plugin.py`.
New: `pipe.py`, the named pipe the app calls; in `utils.py`, `compile_user_regex`, which every regex an agent
sends goes through, so none backtracks without bound on IDA's main thread.

Not shipped: `api_modify.py`, `api_debug.py`, `api_python.py`, `api_sigmaker.py`, `_sigmaker.py`,
`api_survey.py`, `api_resources.py`, `trace.py`, `http.py`, `discovery.py`, `framework.py`, `profile.py`,
`zeromcp/`, the `idalib` server and supervisor, and the installers.

Upstream fixes come in by hand; `tests/idapro.test.ts` holds the tools here equal to the app's catalog
(specs/ida-pro, adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe).
