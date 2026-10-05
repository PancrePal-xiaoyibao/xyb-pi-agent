"""Error taxonomy.

The central design constraint: a failure must never be representable as a
successful empty result. `NO_RESULTS` is reserved for exactly one situation -- a
structurally valid CSV that arrived intact and contained zero data rows.

Anything else that prevents us from returning records raises, so that callers
receive an explicit failure rather than an empty list.

See docs/MEASUREMENTS.md for the measured behaviour this encodes.
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    """Stable, machine-readable failure codes."""

    #: The one legitimate zero. Only produced by a validated CSV with 0 data rows.
    NO_RESULTS = "NO_RESULTS"

    #: Upstream refused or intercepted the request (WAF, 403/405/429/503, block page).
    UPSTREAM_BLOCKED = "UPSTREAM_BLOCKED"

    #: The portal responded, but not in the shape we depend on: a redirect to
    #: NoAccess.aspx, a non-CSV content type where CSV was requested, a changed
    #: header, or a missing required column.
    UPSTREAM_CONTRACT_DRIFT = "UPSTREAM_CONTRACT_DRIFT"

    #: Transport-level failure: timeout, connection reset, 5xx.
    UPSTREAM_ERROR = "UPSTREAM_ERROR"

    #: The caller supplied something we cannot accept.
    INVALID_ARGUMENT = "INVALID_ARGUMENT"

    #: A referenced result-set id is unknown or expired.
    CACHE_MISS = "CACHE_MISS"

    #: Session state could not be established (no hidden inputs on the form page).
    SESSION_FAILED = "SESSION_FAILED"


#: Codes for which retrying the identical request may plausibly succeed.
RETRYABLE: frozenset[ErrorCode] = frozenset(
    {ErrorCode.UPSTREAM_ERROR, ErrorCode.SESSION_FAILED}
)

#: Codes that mean the upstream service did not give us data, as opposed to
#: having told us there is none.
FAILURE_CODES: frozenset[ErrorCode] = frozenset(
    {
        ErrorCode.UPSTREAM_BLOCKED,
        ErrorCode.UPSTREAM_CONTRACT_DRIFT,
        ErrorCode.UPSTREAM_ERROR,
        ErrorCode.SESSION_FAILED,
    }
)


class IctrpError(Exception):
    """A failure carrying enough upstream context to be diagnosable.

    `body_excerpt` is stripped of HTML and truncated; it is for diagnosis, never
    for parsing.
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        upstream_status: int | None = None,
        upstream_content_type: str | None = None,
        upstream_body_excerpt: str | None = None,
        hint: str | None = None,
        detail: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.upstream_status = upstream_status
        self.upstream_content_type = upstream_content_type
        self.upstream_body_excerpt = upstream_body_excerpt
        self.hint = hint
        self.detail = detail

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "status": _status_for(self.code),
            "error_code": self.code.value,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.detail:
            out["detail"] = self.detail
        if self.upstream_status is not None:
            out["upstream_status"] = self.upstream_status
        if self.upstream_content_type:
            out["upstream_content_type"] = self.upstream_content_type
        if self.upstream_body_excerpt:
            out["upstream_body_excerpt"] = self.upstream_body_excerpt
        if self.hint:
            out["hint"] = self.hint
        return out


def _status_for(code: ErrorCode) -> str:
    return {
        ErrorCode.NO_RESULTS: "no_results",
        ErrorCode.UPSTREAM_BLOCKED: "upstream_blocked",
        ErrorCode.UPSTREAM_CONTRACT_DRIFT: "upstream_contract_drift",
        ErrorCode.UPSTREAM_ERROR: "upstream_error",
        ErrorCode.INVALID_ARGUMENT: "invalid_argument",
        ErrorCode.CACHE_MISS: "cache_miss",
        ErrorCode.SESSION_FAILED: "session_failed",
    }[code]
