"""The plugin's tool registry, replacing upstream's rpc.py and its zeromcp server.

Harness for REA — derived from mrexodia/ida-pro-mcp at commit c133c3853faa111a9b00ee615c013b720d0c4acd
(MIT, see LICENSE and UPSTREAM.md). `@tool` records a function in TOOLS and nothing else: no HTTP server, no
MCP session, no output download links. The pipe in pipe.py is the only thing that calls a tool
(specs/ida-pro R2.1, R2.2, adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe).
"""

import threading
from typing import Callable

TOOLS: dict[str, Callable] = {}

# Upstream's cap on one answer, which decompile pages by; kept so its paging behaves the same.
OUTPUT_LIMIT_MAX_CHARS = 50000


class McpToolError(Exception):
    """A tool's own error, answered to the app as the call's error message."""


class RequestCancelledError(Exception):
    """A cancelled call; the pipe never cancels one, so this only types sync.py's handling."""


def get_current_cancel_event() -> "threading.Event | None":
    """The pipe carries no cancellation: a call runs to its own timeout."""
    return None


def tool(func: Callable) -> Callable:
    TOOLS[func.__name__] = func
    return func
