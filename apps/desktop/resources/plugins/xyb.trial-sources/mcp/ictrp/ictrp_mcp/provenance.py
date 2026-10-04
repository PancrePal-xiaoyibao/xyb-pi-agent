"""Provenance.

Every tool response carries this. The point is that a caller can always answer:
where did this come from, when did WHO last process it, and what is missing.

Two things are kept rigorously separate, because conflating them is the most
likely way for this service to mislead:

* `rows_returned` -- what we actually hold.
* `upstream_reported_total` -- what the portal claimed matched.

The export is provably incomplete (docs/MEASUREMENTS.md section 2), so neither
number alone may be presented as "how many trials exist". When they disagree, the
response says so explicitly.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

SOURCE_NAME = "WHO ICTRP"

SOURCE_URL = "https://trialsearch.who.int/"

#: Attribution wording required by the ICTRP terms of use.
ATTRIBUTION = (
    "Data source: WHO International Clinical Trials Registry Platform (ICTRP). "
    "ICTRP data are publicly available for download from the ICTRP Search Portal. "
    "WHO updates ICTRP weekly."
)

#: Stated on every response so the incompleteness can never be missed.
INCOMPLETENESS_NOTICE = (
    "The ICTRP CSV export is known to omit records that the search portal itself "
    "reports as matches (measured shortfalls from 0.4% to 29% depending on query). "
    "A record absent from a result set is therefore NOT evidence that it does not "
    "exist. Treat counts from this service as counts of retrieved rows, not as "
    "complete counts of matching trials."
)


@dataclass
class Provenance:
    """Where a response's data came from and how current it is."""

    source: str = SOURCE_NAME
    source_url: str = SOURCE_URL
    retrieved_at: str = ""
    upstream_reported_total: int | None = None
    rows_returned: int | None = None
    records_incomplete: bool = False
    estimated_missing: int | None = None
    ictrp_export_date: str | None = None
    ictrp_last_refreshed: str | None = None
    request_steps: list[str] = field(default_factory=list)
    cache_hit: bool = False
    notes: list[str] = field(default_factory=list)
    # Provenance keys this dataclass does not model, carried through untouched.
    #
    # The offline path is the reason this exists. A snapshot provenance carries
    # `offline_snapshot`, `snapshot_path`, `snapshot_age_days` and friends, and
    # those are exactly the fields that tell a caller "this data did not come
    # from a live query". `search()` round-trips through this class before
    # answering, so anything not modelled here is silently dropped -- which
    # would quietly strip the offline labelling and leave snapshot data
    # looking indistinguishable from live data. Modelling the whole set is not
    # an option: the snapshot shape is free to grow.
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def now(cls, **kwargs: Any) -> "Provenance":
        return cls(retrieved_at=_utc_now(), **kwargs)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Provenance":
        """Rebuild from `to_dict()` output.

        `to_dict()` is a presentation shape: it adds derived keys like
        `attribution` and `incompleteness_notice`, which are not constructor
        fields. They are accepted and ignored here so a stored provenance can be
        round-tripped without the caller stripping them first.

        Anything else this class does not model is preserved in `extra` rather
        than discarded, so a round-trip does not lose provenance detail that
        some other layer added.
        """
        known = {
            "source", "source_url", "retrieved_at", "upstream_reported_total",
            "rows_returned", "records_incomplete", "estimated_missing",
            "ictrp_export_date", "ictrp_last_refreshed", "request_steps",
            "cache_hit", "notes",
        }
        # Derived on every serialization, so never re-adopted from input.
        derived = {"attribution", "incompleteness_notice"}
        extra = {
            k: v
            for k, v in data.items()
            if k not in known and k not in derived
        }
        return cls(**{k: v for k, v in data.items() if k in known}, extra=extra)

    def to_dict(self) -> dict[str, Any]:
        """Serialized form. Attribution and the incompleteness notice always ride along."""
        out: dict[str, Any] = {
            "source": self.source,
            "source_url": self.source_url,
            "retrieved_at": self.retrieved_at,
            "attribution": ATTRIBUTION,
        }
        if self.upstream_reported_total is not None:
            out["upstream_reported_total"] = self.upstream_reported_total
        if self.rows_returned is not None:
            out["rows_returned"] = self.rows_returned
        out["records_incomplete"] = self.records_incomplete
        if self.estimated_missing is not None:
            out["estimated_missing"] = self.estimated_missing
        if self.ictrp_export_date:
            out["ictrp_export_date"] = self.ictrp_export_date
        if self.ictrp_last_refreshed:
            out["ictrp_last_refreshed"] = self.ictrp_last_refreshed
        if self.request_steps:
            out["request_steps"] = list(self.request_steps)
        out["cache_hit"] = self.cache_hit
        if self.records_incomplete:
            out["incompleteness_notice"] = INCOMPLETENESS_NOTICE
        elif not self.cache_hit:
            # Even a complete-looking response carries the caveat: we can never
            # prove from a single export that nothing was withheld.
            out["incompleteness_notice"] = INCOMPLETENESS_NOTICE
        if self.notes:
            out["notes"] = list(self.notes)
        # Keys this class does not model, restored verbatim.
        for key, value in self.extra.items():
            out.setdefault(key, value)
        return out


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def derive_set_provenance(
    *,
    keyword: str,
    trials: list[dict[str, Any]],
    reported_total: int | None,
    response_date: str | None,
    steps: list[str],
) -> Provenance:
    """Build provenance from a freshly materialized export."""
    rows = len(trials)
    export_dates = sorted(
        {t.get("export_date_raw") for t in trials if t.get("export_date_raw")}
    )
    refreshed = sorted(
        {t.get("last_refreshed_display") for t in trials if t.get("last_refreshed_display")}
    )

    provenance = Provenance.now(
        upstream_reported_total=reported_total,
        rows_returned=rows,
        records_incomplete=bool(reported_total is not None and reported_total > rows),
        estimated_missing=(
            max(0, reported_total - rows) if reported_total is not None else None
        ),
        ictrp_export_date=export_dates[0] if export_dates else None,
        ictrp_last_refreshed=refreshed[0] if refreshed else None,
        request_steps=list(steps),
        cache_hit=False,
    )

    provenance.notes.append(f"Search keyword: {keyword!r}.")
    if refreshed:
        provenance.notes.append(
            f"Record-level 'Last Refreshed on' values span {len(refreshed)} distinct "
            f"dates in this set; the earliest is shown. Per-record values are on each trial."
        )
    if response_date:
        provenance.notes.append(f"Upstream response Date header: {response_date}.")
    return provenance
