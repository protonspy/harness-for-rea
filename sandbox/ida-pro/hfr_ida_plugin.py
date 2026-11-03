"""Harness for REA — IDA Pro plugin (read-only).

Derived from mrexodia/ida-pro-mcp, src/ida_pro_mcp/ida_mcp.py at commit c133c3853faa111a9b00ee615c013b720d0c4acd
(2026-09-26), under the MIT licence in hfr_ida/LICENSE.

IDA loads it with each database. It serves upstream's read-only tools, plus `ping` and `get_database`, to the
Harness for REA app on its own pipe, \\\\.\\pipe\\hfr-ida, and to nothing else: no HTTP server, no config form,
no settings in the database, no discovery file (specs/ida-pro, adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe).
The pipe opens with the database and closes with it.

Install: copy this file and the hfr_ida folder into IDA's user plugins folder
(%APPDATA%\\Hex-Rays\\IDA Pro\\plugins) — the app's Settings does it — then reopen the database.
"""

import os
import sys

import idaapi
import ida_kernwin

VERSION = "hfr-ida-1"
PACKAGE = "hfr_ida"


def _unload_package() -> None:
    """Drops the package's modules, so a database opened later never sees an earlier one's caches."""
    for name in [m for m in sys.modules if m == PACKAGE or m.startswith(PACKAGE + ".")]:
        del sys.modules[name]


def _database() -> dict:
    """The open database: its input file's name, path and SHA-256, and the database's own path."""
    import ida_nalt
    import idc

    sha = ida_nalt.retrieve_input_file_sha256()
    return {
        "input_name": ida_nalt.get_root_filename() or "",
        "input_path": ida_nalt.get_input_file_path() or "",
        "idb_path": idc.get_idb_path() or "",
        "sha256": sha.hex() if isinstance(sha, (bytes, bytearray)) and sha else "",
    }


class HfrIda(idaapi.plugin_t):
    flags = idaapi.PLUGIN_HIDE | idaapi.PLUGIN_KEEP
    comment = "Harness for REA: read-only tools for the app, on a named pipe"
    help = "Harness for REA"
    wanted_name = "Harness for REA"
    wanted_hotkey = ""

    def init(self):
        self.server = None
        # Under idalib there is no user and no database the user opened: nothing to serve.
        if not ida_kernwin.is_idaq():
            return idaapi.PLUGIN_SKIP
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.append(here)
        _unload_package()
        import hfr_ida
        from hfr_ida.pipe import PipeServer
        from hfr_ida.sync import idasync

        database = idasync(_database)
        versions = {
            "version": VERSION,
            "ida": idaapi.get_kernel_version(),
            "python": sys.version.split()[0],
        }
        self.server = PipeServer(
            internal={"ping": lambda: dict(versions), "get_database": database},
            tools=dict(hfr_ida.TOOLS),
        )
        self.server.start()
        return idaapi.PLUGIN_KEEP

    def run(self, arg):
        pass

    def term(self):
        if self.server:
            self.server.stop()
            self.server = None


def PLUGIN_ENTRY():
    return HfrIda()
