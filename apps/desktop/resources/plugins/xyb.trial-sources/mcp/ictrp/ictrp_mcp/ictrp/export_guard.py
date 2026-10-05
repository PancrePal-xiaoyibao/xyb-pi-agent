"""Response classification -- applied to every upstream response before parsing.

This module is the reason a WAF block page can never be mistaken for "no trials
exist". The primary check is structural (content type + header shape), not
textual: if we asked for a CSV and did not get a CSV with the expected header,
that is a failure regardless of status code and regardless of body wording.

Text markers exist only to improve the `hint`; they are never load-bearing,
because the upstream block page's exact wording is not something we control or
should depend on.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass

from ..data.columns import REQUIRED_COLUMNS
from ..errors import ErrorCode, IctrpError

#: MIME type the portal uses for a successful export.
CSV_CONTENT_TYPE = "application/vnd.ms-excel"

#: Filename the portal advertises on a successful export.
CSV_FILENAME = "IctrpResults.csv"

#: Secondary classifier only. Used to pick a better hint, never to decide
#: success or failure.
_BLOCK_MARKERS = (
    "access denied",
    "request rejected",
    "web application firewall",
    "attention required",
    "just a moment",
    "security threat",
    "your request has been blocked",
    "访问被阻断",
    "aliyunwaf",
    "acw_sc__v2",
)

#: Marker in the redirect target that means we misused the session.
_NOACCESS_MARKER = "/noaccess.aspx"

_MAX_EXCERPT = 512


@dataclass(frozen=True)
class CsvPayload:
    """A validated export response."""

    header: tuple[str, ...]
    rows: list[list[str]]
    content_type: str | None
    reported_total: int | None = None

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def is_empty(self) -> bool:
        """True only for a structurally valid export with zero data rows."""
        return len(self.rows) == 0


def _excerpt(body: bytes | str, limit: int = _MAX_EXCERPT) -> str:
    if isinstance(body, bytes):
        text = body.decode("utf-8", "replace")
    else:
        text = body
    text = re.sub(r"<script\b[^>]*>.*?</script>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def looks_like_block_page(body: bytes | str) -> bool:
    text = _excerpt(body, 8000).lower()
    return any(marker in text for marker in _BLOCK_MARKERS)


def _is_successful_csv_envelope(
    status: int, content_type: str | None, content_disposition: str | None
) -> bool:
    if status != 200:
        return False
    if not content_type:
        return False
    base = content_type.split(";")[0].strip().lower()
    if base == CSV_CONTENT_TYPE or base in ("text/csv", "application/csv"):
        return True
    # Some responses omit the exact MIME but still advertise the filename.
    if content_disposition and CSV_FILENAME.lower() in content_disposition.lower():
        return True
    return False


def _parse_csv(body: bytes) -> tuple[tuple[str, ...], list[list[str]]]:
    text = body.decode("utf-8-sig", "replace")
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        return (), []
    header = tuple(h.strip() for h in header)
    rows = [r for r in reader if r and any(c.strip() for c in r)]
    return header, rows


def _validate_header(header: tuple[str, ...]) -> None:
    missing = REQUIRED_COLUMNS - set(header)
    if missing:
        raise IctrpError(
            ErrorCode.UPSTREAM_CONTRACT_DRIFT,
            "ICTRP export header is missing required column(s)",
            detail=f"missing: {sorted(missing)}",
            hint=(
                "The portal's export format has changed. Update data/columns.py "
                "and the field mapping before relying on results."
            ),
        )


def classify_export(
    *,
    status: int,
    content_type: str | None,
    content_disposition: str | None,
    body: bytes,
    location: str | None = None,
    reported_total: int | None = None,
) -> CsvPayload:
    """Classify an export response.

    Returns a validated `CsvPayload` (possibly empty) or raises `IctrpError`.
    An empty payload is the ONLY way a caller may report zero results.
    """
    if location and _NOACCESS_MARKER in location.lower():
        raise IctrpError(
            ErrorCode.UPSTREAM_CONTRACT_DRIFT,
            "Portal redirected the export to NoAccess.aspx",
            upstream_status=status,
            upstream_content_type=content_type,
            hint=(
                "The export POST was rejected. Verify that the results-page hidden "
                "inputs were used verbatim and that TextBox1/Button1 were NOT sent, "
                "since the results page does not contain them."
            ),
        )

    if status in (403, 405, 429, 503):
        raise IctrpError(
            ErrorCode.UPSTREAM_BLOCKED,
            f"Upstream refused the request (HTTP {status})",
            upstream_status=status,
            upstream_content_type=content_type,
            upstream_body_excerpt=_excerpt(body),
            hint=(
                "The portal blocked this request. This is not an empty result set; "
                "do not report zero trials. Retry later, and reduce request rate."
            ),
        )

    if status >= 500:
        raise IctrpError(
            ErrorCode.UPSTREAM_ERROR,
            f"Upstream server error (HTTP {status})",
            upstream_status=status,
            upstream_content_type=content_type,
            upstream_body_excerpt=_excerpt(body),
            hint="Transient upstream failure. Retry with backoff.",
        )

    if not _is_successful_csv_envelope(status, content_type, content_disposition):
        hint = "Response was not a CSV export."
        if looks_like_block_page(body):
            hint = (
                "Response looks like an HTML block/interstitial page, not an export. "
                "Treat as blocked, not as zero results."
            )
        raise IctrpError(
            ErrorCode.UPSTREAM_CONTRACT_DRIFT,
            "Export response was not a CSV",
            upstream_status=status,
            upstream_content_type=content_type,
            upstream_body_excerpt=_excerpt(body),
            hint=hint,
        )

    header, rows = _parse_csv(body)
    if not header:
        raise IctrpError(
            ErrorCode.UPSTREAM_CONTRACT_DRIFT,
            "Export body contained no CSV header row",
            upstream_status=status,
            upstream_content_type=content_type,
            upstream_body_excerpt=_excerpt(body),
        )

    _validate_header(header)

    # Pad short rows so column indexing is always safe. Upstream can emit rows
    # with trailing empty fields omitted.
    width = len(header)
    rows = [(r + [""] * width)[:width] for r in rows]

    return CsvPayload(
        header=header,
        rows=rows,
        content_type=content_type,
        reported_total=reported_total,
    )


def classify_form_page(*, status: int, body: bytes) -> str:
    """Validate the initial GET of the search form. Returns the HTML text."""
    text = body.decode("utf-8", "replace")
    if status in (403, 405, 429, 503):
        raise IctrpError(
            ErrorCode.UPSTREAM_BLOCKED,
            f"Search form was refused (HTTP {status})",
            upstream_status=status,
            upstream_body_excerpt=_excerpt(body),
        )
    if status >= 500:
        raise IctrpError(
            ErrorCode.UPSTREAM_ERROR,
            f"Search form returned HTTP {status}",
            upstream_status=status,
            upstream_body_excerpt=_excerpt(body),
        )
    if status != 200:
        raise IctrpError(
            ErrorCode.UPSTREAM_CONTRACT_DRIFT,
            f"Unexpected status for search form: HTTP {status}",
            upstream_status=status,
            upstream_body_excerpt=_excerpt(body),
        )
    if looks_like_block_page(body):
        raise IctrpError(
            ErrorCode.UPSTREAM_BLOCKED,
            "Search form returned a block/interstitial page",
            upstream_status=status,
            upstream_body_excerpt=_excerpt(body),
        )
    return text


_RECORDS_RE = re.compile(r"([\d,]+)\s*records", re.I)


def parse_reported_total(html: str) -> int | None:
    """Extract the portal's own 'N records' figure from a results page.

    This is the portal's claim, NOT a verified count of what we received. The
    two routinely differ -- measured shortfalls of 0.4% to 29% -- so callers must
    surface both and never conflate them. See docs/MEASUREMENTS.md section 2.
    """
    match = _RECORDS_RE.search(html)
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None
