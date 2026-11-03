# Harness for REA: from mrexodia/ida-pro-mcp, src/ida_pro_mcp/ida_mcp/api_stack.py at commit
# c133c3853faa111a9b00ee615c013b720d0c4acd (MIT, see LICENSE and UPSTREAM.md); tools outside upstream's read-only
# profile, and helpers only they used, deleted.

"""Stack frame operations for IDA Pro MCP.

This module provides batch operations for managing stack frame variables,
including reading, creating, and deleting stack variables in functions.
"""

from typing import Annotated, NotRequired, TypedDict

from .rpc import tool
from .sync import idasync
from .utils import (
    normalize_list_input,
    parse_address,
    StackFrameVariable,
    get_stack_frame_variables_internal,
)


class StackFrameResult(TypedDict):
    addr: str
    vars: list[StackFrameVariable] | None
    error: NotRequired[str]


# ============================================================================
# Stack Frame Operations
# ============================================================================


@tool
@idasync
def stack_frame(
    addrs: Annotated[list[str] | str, "Address(es)"]
) -> list[StackFrameResult]:
    """Return stack variables for function address(es)."""
    addrs = normalize_list_input(addrs)
    results = []

    for addr in addrs:
        try:
            ea = parse_address(addr)
            vars = get_stack_frame_variables_internal(ea, True)
            results.append({"addr": addr, "vars": vars})
        except Exception as e:
            results.append({"addr": addr, "vars": None, "error": str(e)})

    return results

