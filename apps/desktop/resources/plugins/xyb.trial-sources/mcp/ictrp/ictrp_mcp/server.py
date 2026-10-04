"""MCP server exposing the WHO ICTRP tools.

Transport is stdio, matching how MCP clients launch a server. Tool failures are
returned as structured error payloads (`isError: True`) carrying the error code,
never as empty success results -- the distinction between "no matching trials"
and "we could not retrieve the data" is the central guarantee of this service.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from .errors import ErrorCode, IctrpError
from .tools import IctrpService

SERVER_NAME = "ictrp-mcp-service"
SERVER_VERSION = "0.1.0"

_FILTER_SCHEMA = {
    "type": "array",
    "description": (
        "All filters must match (AND). Each filter is "
        "{field, op, value}. Aliases are accepted for common fields: title, status, "
        "register, reg_date, phase, age_min, age_max, target_size."
    ),
    "items": {
        "type": "object",
        "properties": {
            "field": {"type": "string"},
            "op": {
                "type": "string",
                "enum": [
                    "eq", "ne", "contains", "not_contains", "in", "not_in",
                    "gt", "gte", "lt", "lte", "exists", "not_exists", "is_null",
                    "is_not_null",
                ],
            },
            "value": {},
        },
        "required": ["field", "op"],
    },
}

_INCOMPLETENESS_WARNING = (
    "Counts describe retrieved rows only. The ICTRP CSV export is known to omit "
    "records the portal itself reports as matches, so absence is not evidence of "
    "nonexistence."
)


def _tool_specs() -> list[Tool]:
    return [
        Tool(
            name="ictrp_search",
            description=(
                "Search the WHO ICTRP and materialize the result set locally. "
                "Returns a page plus a set_id that other tools can query without "
                "further upstream requests. "
                f"IMPORTANT: {_INCOMPLETENESS_WARNING}"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": (
                            "Search terms. Multi-word input is an implicit AND. "
                            "Boolean AND/OR and quoted phrases are supported."
                        ),
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 50},
                    "offset": {"type": "integer", "minimum": 0, "default": 0},
                    "fields": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Fields to return per trial.",
                    },
                    "filters": _FILTER_SCHEMA,
                    "sort_by": {"type": "string"},
                    "descending": {"type": "boolean", "default": False},
                    "refresh": {
                        "type": "boolean",
                        "default": False,
                        "description": "Re-run the upstream search even if a cached set exists.",
                    },
                },
                "required": ["keyword"],
            },
        ),
        Tool(
            name="ictrp_filter",
            description=(
                "Filter, sort and page a previously materialized result set. Runs "
                "entirely locally; makes no upstream request."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "set_id": {"type": "string"},
                    "filters": _FILTER_SCHEMA,
                    "sort_by": {"type": "string"},
                    "descending": {"type": "boolean", "default": False},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 50},
                    "offset": {"type": "integer", "minimum": 0, "default": 0},
                    "fields": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["set_id"],
            },
        ),
        Tool(
            name="ictrp_field_query",
            description=(
                "Distinct values and population coverage for one field in a cached "
                "set. Runs locally. Coverage is reported so sparse fields are not "
                "mistaken for absent data."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "field": {"type": "string"},
                    "set_id": {"type": "string"},
                    "keyword": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 50},
                },
                "required": ["field"],
            },
        ),
        Tool(
            name="ictrp_registry_summary",
            description=(
                "Composition of a cached set by registry, phase, status, year or "
                "country, plus per-field coverage. Runs locally."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "set_id": {"type": "string"},
                    "keyword": {"type": "string"},
                    "group_by": {"type": "array", "items": {"type": "string"}},
                },
            },
        ),
        Tool(
            name="ictrp_find_duplicates",
            description=(
                "Find records likely describing the same trial, using identifier "
                "cross-references across registries. Runs locally."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "set_id": {"type": "string"},
                    "keyword": {"type": "string"},
                },
            },
        ),
        Tool(
            name="ictrp_export",
            description=(
                "Export a cached set as csv, json, jsonl or markdown, with a "
                "provenance header. Runs locally."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "set_id": {"type": "string"},
                    "keyword": {"type": "string"},
                    "format": {"type": "string", "enum": ["csv", "json", "jsonl", "markdown"], "default": "json"},
                    "fields": {"type": "array", "items": {"type": "string"}},
                    "filters": _FILTER_SCHEMA,
                    "include_provenance_header": {"type": "boolean", "default": True},
                },
            },
        ),
        Tool(
            name="ictrp_cache_status",
            description="List or purge cached result sets. Runs locally.",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "purge"], "default": "list"},
                    "set_id": {"type": "string"},
                },
            },
        ),
        Tool(
            name="ictrp_snapshot",
            description=(
                "Write a cached result set to a canonical JSON snapshot file, for "
                "shipping inside a packaged application or refreshing such a dataset. "
                "Runs locally. Redistribution of ICTRP data is subject to WHO terms; "
                "see docs/BUNDLE.md."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "set_id": {"type": "string"},
                    "keyword": {"type": "string"},
                    "path": {
                        "type": "string",
                        "description": (
                            "Destination file. Defaults to ICTRP_BUNDLE_DIR, or the "
                            "cache directory's snapshots/ folder."
                        ),
                    },
                    "if_stale": {
                        "type": "boolean",
                        "default": True,
                        "description": (
                            "Skip writing when a fresh snapshot already exists. Set "
                            "false in a release pipeline to always rewrite."
                        ),
                    },
                },
            },
        ),
        Tool(
            name="ictrp_bundle_status",
            description=(
                "Report which local snapshot would serve a keyword, where it was "
                "looked for, and how old it is. Runs locally and makes no request."
            ),
            inputSchema={
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
        ),
    ]


def _as_error(exc: IctrpError) -> Exception:
    """Render a structured failure as text and raise it through a private type.

    The MCP framework sets `isError=True` only when the handler raises; content
    returned normally is always flagged as success. Since a failure must never be
    presented as a successful (empty) result, we raise -- but carry the structured
    payload in the message so clients still get the error code.

    Returning a bare `CallToolResult` here would be overwritten by the framework,
    which is why this does not try to construct one.
    """
    return _ToolFailure(json.dumps({"status": "error", **exc.to_dict()}, ensure_ascii=False, indent=2))


class _ToolFailure(Exception):
    """Carries an already-formatted error payload for the MCP framework."""


def _dispatch(service: IctrpService, name: str, args: dict[str, Any]) -> Any:
    if name == "ictrp_search":
        return service.search(
            args["keyword"],
            limit=args.get("limit", 50),
            offset=args.get("offset", 0),
            fields=args.get("fields"),
            filters=args.get("filters"),
            sort_by=args.get("sort_by"),
            descending=args.get("descending", False),
            refresh=args.get("refresh", False),
        )
    if name == "ictrp_filter":
        return service.filter_set(
            args["set_id"],
            filters=args.get("filters"),
            sort_by=args.get("sort_by"),
            descending=args.get("descending", False),
            limit=args.get("limit", 50),
            offset=args.get("offset", 0),
            fields=args.get("fields"),
        )
    if name == "ictrp_field_query":
        return service.field_query(
            field=args["field"],
            set_id=args.get("set_id"),
            keyword=args.get("keyword"),
            limit=args.get("limit", 50),
        )
    if name == "ictrp_registry_summary":
        return service.registry_summary(
            set_id=args.get("set_id"),
            keyword=args.get("keyword"),
            group_by=args.get("group_by"),
        )
    if name == "ictrp_find_duplicates":
        return service.find_duplicates(set_id=args.get("set_id"), keyword=args.get("keyword"))
    if name == "ictrp_export":
        return service.export_records(
            set_id=args.get("set_id"),
            keyword=args.get("keyword"),
            fmt=args.get("format", "json"),
            fields=args.get("fields"),
            filters=args.get("filters"),
            include_provenance_header=args.get("include_provenance_header", True),
        )
    if name == "ictrp_cache_status":
        return service.cache_status(action=args.get("action", "list"), set_id=args.get("set_id"))
    if name == "ictrp_snapshot":
        return service.snapshot(
            set_id=args.get("set_id"),
            keyword=args.get("keyword"),
            path=args.get("path"),
            if_stale=args.get("if_stale", True),
        )
    if name == "ictrp_bundle_status":
        return service.bundle_status(keyword=args.get("keyword"))
    raise IctrpError(ErrorCode.INVALID_ARGUMENT, f"unknown tool {name!r}")


def build_server(service: IctrpService | None = None) -> Server:
    # Pin the version explicitly rather than letting the framework report its own,
    # so clients see this project's version.
    server = Server(SERVER_NAME, version=SERVER_VERSION)
    svc = service or IctrpService()

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return _tool_specs()

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any] | None):
        args = arguments or {}
        try:
            result = _dispatch(svc, name, args)
            # Only `ictrp_search` is a coroutine; the local tools are synchronous.
            # Awaiting here keeps error handling in one place, so an IctrpError
            # raised inside an async tool is caught by the same handler.
            if asyncio.iscoroutine(result):
                result = await result
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
        except IctrpError as exc:
            raise _as_error(exc) from exc
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller, not swallowed
            raise _ToolFailure(
                json.dumps(
                    {
                        "status": "error",
                        "error_code": "INTERNAL_ERROR",
                        "message": str(exc),
                        "message_type": type(exc).__name__,
                        "hint": "This is a bug in the service, not an upstream failure.",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            ) from exc

    return server


async def _run() -> None:
    server = build_server()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
