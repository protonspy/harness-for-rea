"""Harness for REA — IDA Pro plugin package (read-only).

Derived from mrexodia/ida-pro-mcp at commit c133c3853faa111a9b00ee615c013b720d0c4acd (MIT, see LICENSE and
UPSTREAM.md). Importing it registers upstream's read-only tools in rpc.TOOLS; every other upstream tool is
deleted, not disabled (specs/ida-pro R2.1). tests/idapro.test.ts holds the @tool functions of the api_*
modules equal to the app's catalog.
"""

from . import rpc
from . import sync
from . import utils

from . import api_core
from . import api_analysis
from . import api_memory
from . import api_types
from . import api_stack
from . import api_composite

from .rpc import TOOLS

__all__ = ["rpc", "sync", "utils", "TOOLS"]
