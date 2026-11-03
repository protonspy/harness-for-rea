# Harness for REA: from mrexodia/ida-pro-mcp, src/ida_pro_mcp/ida_mcp/api_types.py at commit
# c133c3853faa111a9b00ee615c013b720d0c4acd (MIT, see LICENSE and UPSTREAM.md); tools outside upstream's read-only
# profile, and helpers only they used, deleted.

from typing import Annotated, TypedDict

import ida_typeinf
import ida_nalt
import idaapi

from .rpc import tool
from .sync import idasync
from .utils import (
    normalize_dict_list,
    paginate,
    pattern_filter,
    parse_address,
    read_bytes_bss_safe,
    read_int_bss_safe,
    StructRead,
    TypeQuery,
)
from . import compat


class StructMemberValueResult(TypedDict):
    offset: str
    type: str
    name: str
    size: int
    value: str


class ReadStructResult(TypedDict, total=False):
    addr: str | None
    struct: str | None
    members: list[StructMemberValueResult] | None
    error: str


class TypeCatalogMemberResult(TypedDict):
    name: str
    offset: str
    size: int
    type: str


class TypeCatalogRow(TypedDict, total=False):
    ordinal: int
    name: str
    size: int
    kind: str
    declaration: str
    member_count: int
    members: list[TypeCatalogMemberResult]
    members_truncated: bool
    related_count: int
    related_types: list[str]
    related_truncated: bool


class TypeQueryResult(TypedDict):
    kind: str
    data: list[TypeCatalogRow]
    next_offset: int | None
    total: int


# ============================================================================
# Type Declaration
# ============================================================================


# ============================================================================
# Structure Operations
# ============================================================================


@tool
@idasync
def read_struct(
    queries: list[StructRead] | StructRead,
) -> list[ReadStructResult]:
    """Read struct fields from memory at address; auto-detect type when possible."""

    queries = normalize_dict_list(queries)

    results = []
    for query in queries:
        addr_str = query.get("addr", "")
        struct_name = query.get("struct", "")

        try:
            # Parse address - this is required
            if not addr_str:
                results.append(
                    {
                        "addr": None,
                        "struct": struct_name,
                        "members": None,
                        "error": "Address is required for reading struct fields",
                    }
                )
                continue

            # Try to parse as address, then try name resolution
            try:
                addr = parse_address(addr_str)
            except Exception:
                addr = idaapi.get_name_ea(idaapi.BADADDR, addr_str)
                if addr == idaapi.BADADDR:
                    results.append(
                        {
                            "addr": addr_str,
                            "struct": struct_name,
                            "members": None,
                            "error": f"Failed to resolve address: {addr_str}",
                        }
                    )
                    continue

            # Auto-detect struct type from address if not provided
            if not struct_name:
                tif_auto = ida_typeinf.tinfo_t()
                if ida_nalt.get_tinfo(tif_auto, addr) and tif_auto.is_udt():
                    struct_name = tif_auto.get_type_name()

            if not struct_name:
                results.append(
                    {
                        "addr": addr_str,
                        "struct": None,
                        "members": None,
                        "error": "No struct specified and could not auto-detect from address",
                    }
                )
                continue

            tif = ida_typeinf.tinfo_t()
            if not tif.get_named_type(None, struct_name):
                results.append(
                    {
                        "addr": addr_str,
                        "struct": struct_name,
                        "members": None,
                        "error": f"Struct '{struct_name}' not found",
                    }
                )
                continue

            udt_data = ida_typeinf.udt_type_data_t()
            if not tif.get_udt_details(udt_data):
                results.append(
                    {
                        "addr": addr_str,
                        "struct": struct_name,
                        "members": None,
                        "error": "Failed to get struct details",
                    }
                )
                continue

            members = []
            for member in udt_data:
                offset = member.begin() // 8
                member_type = member.type._print()
                member_name = member.name
                member_size = member.type.get_size()

                # Read memory value at member address (BSS-aware: unloaded
                # bytes resolve to zero, matching runtime zero-init).
                member_addr = addr + offset
                try:
                    if member.type.is_ptr():
                        ptr_size = 8 if compat.inf_is_64bit() else 4
                        value = read_int_bss_safe(member_addr, ptr_size)
                        value_str = f"0x{value:0{ptr_size * 2}X}"
                    elif member_size in (1, 2, 4, 8):
                        value = read_int_bss_safe(member_addr, member_size)
                        value_str = f"0x{value:0{member_size * 2}X} ({value})"
                    else:
                        capped = min(member_size, 16)
                        raw = read_bytes_bss_safe(member_addr, capped)
                        bytes_data = [f"{b:02X}" for b in raw]
                        value_str = f"[{' '.join(bytes_data)}{'...' if member_size > 16 else ''}]"
                except Exception:
                    value_str = "<failed to read>"

                member_info = {
                    "offset": f"0x{offset:08X}",
                    "type": member_type,
                    "name": member_name,
                    "size": member_size,
                    "value": value_str,
                }

                members.append(member_info)

            results.append(
                {"addr": addr_str, "struct": struct_name, "members": members}
            )
        except Exception as e:
            results.append(
                {
                    "addr": addr_str,
                    "struct": struct_name,
                    "members": None,
                    "error": str(e),
                }
            )

    return results


def _type_kind(tif: ida_typeinf.tinfo_t) -> str:
    try:
        if tif.is_enum():
            return "enum"
    except Exception:
        pass
    try:
        if tif.is_typedef():
            return "typedef"
    except Exception:
        pass
    try:
        if tif.is_func():
            return "func"
    except Exception:
        pass
    try:
        if tif.is_ptr():
            return "ptr"
    except Exception:
        pass

    try:
        if tif.is_udt():
            udt = ida_typeinf.udt_type_data_t()
            if tif.get_udt_details(udt) and udt.is_union:
                return "union"
            return "struct"
    except Exception:
        pass

    return "other"


def _type_matches_kind(kind: str, tif: ida_typeinf.tinfo_t) -> bool:
    if kind == "any":
        return True
    if kind == "udt":
        try:
            return bool(tif.is_udt())
        except Exception:
            return False
    return _type_kind(tif) == kind


# ============================================================================
# Type Inference & Application
# ============================================================================


@tool
@idasync
def type_query(
    queries: Annotated[
        list[TypeQuery] | TypeQuery,
        "Type catalog query with filtering, pagination, and optional relationships",
    ],
) -> list[TypeQueryResult]:
    """Query local types with structured filters/projection-friendly output."""
    queries = normalize_dict_list(queries)

    # Build one local catalog and page/filter it per query.
    catalog: list[dict] = []
    limit = ida_typeinf.get_ordinal_limit()
    for ordinal in range(1, limit):
        tif = ida_typeinf.tinfo_t()
        if not tif.get_numbered_type(None, ordinal):
            continue
        name = tif.get_type_name()
        if not name:
            continue
        catalog.append(
            {
                "ordinal": ordinal,
                "name": name,
                "size": tif.get_size(),
                "kind": _type_kind(tif),
                "_tif": tif,
            }
        )

    results: list[dict] = []
    for query in queries:
        filter_pattern = str(query.get("filter", "") or "")
        kind = str(query.get("kind", "any") or "any").lower()
        if kind not in {"any", "struct", "union", "enum", "typedef", "func", "ptr", "udt"}:
            kind = "any"

        offset = int(query.get("offset", 0) or 0)
        count = int(query["count"]) if query.get("count") is not None else 100
        sort_by = str(query.get("sort_by", "name") or "name")
        descending = bool(query.get("descending", False))
        include_decl = bool(query.get("include_decl", True))
        include_members = bool(query.get("include_members", False))
        max_members = int(query.get("max_members", 64) or 64)
        include_relationships = bool(query.get("include_relationships", False))

        if max_members < 0:
            max_members = 0
        if max_members > 4096:
            max_members = 4096

        filtered: list[dict] = []
        for row in catalog:
            tif = row.get("_tif")
            if not isinstance(tif, ida_typeinf.tinfo_t):
                continue
            if not _type_matches_kind(kind, tif):
                continue
            filtered.append(row)

        if filter_pattern:
            filtered = pattern_filter(filtered, filter_pattern, "name")

        if sort_by == "size":
            filtered.sort(key=lambda r: int(r.get("size", 0) or 0), reverse=descending)
        elif sort_by == "ordinal":
            filtered.sort(key=lambda r: int(r.get("ordinal", 0) or 0), reverse=descending)
        else:
            filtered.sort(key=lambda r: str(r.get("name", "")).lower(), reverse=descending)

        output_rows: list[dict] = []
        for row in filtered:
            tif = row["_tif"]
            out = {
                "ordinal": row["ordinal"],
                "name": row["name"],
                "size": row["size"],
                "kind": row["kind"],
            }

            if include_decl:
                out["declaration"] = str(tif)

            if include_members:
                members = []
                member_count = 0
                members_truncated = False
                if tif.is_udt():
                    udt = ida_typeinf.udt_type_data_t()
                    if tif.get_udt_details(udt):
                        member_count = len(udt)
                        for idx, member in enumerate(udt):
                            if idx >= max_members:
                                members_truncated = True
                                break
                            members.append(
                                {
                                    "name": member.name,
                                    "offset": hex(member.begin() // 8),
                                    "size": member.type.get_size(),
                                    "type": member.type._print(),
                                }
                            )
                out["member_count"] = member_count
                out["members"] = members
                out["members_truncated"] = members_truncated

            if include_relationships:
                related: set[str] = set()
                if tif.is_udt():
                    udt = ida_typeinf.udt_type_data_t()
                    if tif.get_udt_details(udt):
                        for member in udt:
                            rel_name = member.type.get_type_name() or str(member.type)
                            if rel_name:
                                related.add(rel_name)
                if tif.is_ptr():
                    pointed = ida_typeinf.tinfo_t()
                    try:
                        if tif.get_pointed_object(pointed):
                            rel_name = pointed.get_type_name() or str(pointed)
                            if rel_name:
                                related.add(rel_name)
                    except Exception:
                        pass

                related_list = sorted(related)
                out["related_count"] = len(related_list)
                out["related_types"] = related_list[:256]
                out["related_truncated"] = len(related_list) > 256

            output_rows.append(out)

        page = paginate(output_rows, offset, count)
        results.append(
            {
                "kind": kind,
                "data": page["data"],
                "next_offset": page["next_offset"],
                "total": len(output_rows),
            }
        )

    return results

