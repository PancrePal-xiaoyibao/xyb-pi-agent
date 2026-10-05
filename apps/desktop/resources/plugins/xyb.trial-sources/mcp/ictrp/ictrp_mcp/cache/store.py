"""Caching for materialized result sets.

The governing constraint is cost: a single export can be tens of megabytes, and
the chain behind it is three round trips to a public service we should not hammer.
So a search result is materialized once and then queried locally.

Two deliberate choices:

* Raw CSV bytes are written to disk instead of holding every row in memory for
  every live set. A large set is only parsed when it is actually used.
* Only a small number of sets stay in memory. Older ones are dropped (and can be
  re-read from disk), which bounds the process footprint.

Nothing here caches a failure as if it were data. A set only enters the store
after it has been validated.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import ErrorCode, IctrpError
from ..data.normalize import to_trial

#: Parsed sets held in memory at once.
MAX_MATERIALIZED_SETS = 3

#: How long a materialized set stays queryable.
DEFAULT_SET_TTL_SECONDS = 7 * 24 * 60 * 60

#: How long a single-trial lookup stays fresh.
DEFAULT_TRIAL_TTL_SECONDS = 24 * 60 * 60


def normalize_query(keyword: str) -> str:
    """Collapse a keyword to a stable cache key component."""
    return re.sub(r"\s+", " ", keyword.strip().lower())


def query_key(keyword: str) -> str:
    digest = hashlib.sha256(normalize_query(keyword).encode()).hexdigest()[:16]
    return f"search:{digest}"


def trial_key(trial_id: str) -> str:
    return f"trial:{trial_id.strip().upper()}"


def default_cache_dir() -> Path:
    override = os.environ.get("ICTRP_CACHE_DIR")
    if override:
        return Path(override)
    return Path.home() / ".cache" / "ictrp-mcp-service"


@dataclass
class MaterializedSet:
    """One export, parsed into canonical trials."""

    set_id: str
    keyword: str
    trials: list[dict[str, Any]]
    header: tuple[str, ...]
    reported_total: int | None
    csv_bytes: int
    created_at: float
    provenance: dict[str, Any] = field(default_factory=dict)

    @property
    def rows_returned(self) -> int:
        """How many rows we actually hold.

        Never described as a total. The portal's own figure lives separately in
        `reported_total`, and the two are known to differ by 0.4%-29%.
        """
        return len(self.trials)

    @property
    def is_incomplete(self) -> bool:
        """True when the portal reported more matches than the export delivered."""
        if self.reported_total is None:
            return False
        return self.reported_total > self.rows_returned

    @property
    def missing_estimate(self) -> int | None:
        if self.reported_total is None:
            return None
        return max(0, self.reported_total - self.rows_returned)

    def age_seconds(self) -> float:
        return time.time() - self.created_at

    def summary(self) -> dict[str, Any]:
        return {
            "set_id": self.set_id,
            "keyword": self.keyword,
            "rows_returned": self.rows_returned,
            "upstream_reported_total": self.reported_total,
            "records_incomplete": self.is_incomplete,
            "estimated_missing": self.missing_estimate,
            "csv_bytes": self.csv_bytes,
            "age_seconds": round(self.age_seconds(), 1),
            "created_at": _iso(self.created_at),
        }


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


class SetStore:
    """Holds materialized sets in memory, backed by raw CSV on disk."""

    def __init__(self, cache_dir: Path | None = None, ttl_seconds: int = DEFAULT_SET_TTL_SECONDS):
        self.cache_dir = cache_dir or default_cache_dir()
        self.ttl_seconds = ttl_seconds
        self._sets: dict[str, MaterializedSet] = {}
        self._order: list[str] = []

    def _raw_path(self, cache_key: str) -> Path:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", cache_key)
        return self.cache_dir / f"{safe}.csv"

    def _meta_path(self, cache_key: str) -> Path:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", cache_key)
        return self.cache_dir / f"{safe}.json"

    def _ensure_dir(self) -> None:
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Fall back to a temp location rather than failing the request.
            self.cache_dir = Path("/tmp/ictrp-mcp-service")
            self.cache_dir.mkdir(parents=True, exist_ok=True)

    def store(
        self,
        *,
        keyword: str,
        payload_raw: bytes,
        header: tuple[str, ...],
        rows: list[list[str]],
        reported_total: int | None,
        provenance: dict[str, Any],
    ) -> MaterializedSet:
        """Persist and materialize a validated export."""
        cache_key = query_key(keyword)
        trials = [to_trial(row, header) for row in rows]
        materialized = MaterializedSet(
            set_id=cache_key,
            keyword=keyword,
            trials=trials,
            header=header,
            reported_total=reported_total,
            csv_bytes=len(payload_raw),
            created_at=time.time(),
            provenance=dict(provenance),
        )

        self._ensure_dir()
        try:
            self._raw_path(cache_key).write_bytes(payload_raw)
            self._meta_path(cache_key).write_text(
                json.dumps(
                    {
                        "keyword": keyword,
                        "header": list(header),
                        "reported_total": reported_total,
                        "created_at": materialized.created_at,
                        "csv_bytes": materialized.csv_bytes,
                        "provenance": provenance,
                    }
                ),
                encoding="utf-8",
            )
        except OSError:
            # Disk caching is best-effort; the in-memory set is still usable.
            pass

        self._remember(materialized)
        return materialized

    def adopt(
        self,
        *,
        keyword: str,
        trials: list[dict[str, Any]],
        provenance: dict[str, Any],
        created_at: float | None = None,
        source_label: str = "snapshot",
    ) -> MaterializedSet:
        """Register an externally built set (e.g. from an offline snapshot).

        `created_at` is carried over from the snapshot so the set's age reflects
        when the data was retrieved, not when it was loaded. A snapshot read today
        from a month-old file must still report as a month old.

        The set is memory-resident only. Writing it back as a raw CSV would
        fabricate an export we never received, and `_reload_from_disk` would then
        present it as a genuine export on the next run.
        """
        materialized = MaterializedSet(
            set_id=query_key(keyword),
            keyword=keyword,
            trials=list(trials),
            header=(),
            reported_total=provenance.get("upstream_reported_total"),
            csv_bytes=0,
            created_at=created_at if created_at is not None else time.time(),
            provenance=dict(provenance),
        )
        materialized.provenance.setdefault("notes", [])
        self._remember(materialized)
        return materialized

    def _remember(self, materialized: MaterializedSet) -> None:
        self._sets[materialized.set_id] = materialized
        if materialized.set_id in self._order:
            self._order.remove(materialized.set_id)
        self._order.append(materialized.set_id)
        while len(self._order) > MAX_MATERIALIZED_SETS:
            evicted = self._order.pop(0)
            self._sets.pop(evicted, None)

    def get(self, set_id: str) -> MaterializedSet:
        """Return a set, reloading skipped ones from disk when possible."""
        materialized = self._sets.get(set_id)
        if materialized is not None and materialized.age_seconds() <= self.ttl_seconds:
            return materialized
        if materialized is not None:
            self._sets.pop(set_id, None)
            if set_id in self._order:
                self._order.remove(set_id)

        reloaded = self._reload_from_disk(set_id)
        if reloaded is not None:
            self._remember(reloaded)
            return reloaded

        raise IctrpError(
            ErrorCode.CACHE_MISS,
            f"result set {set_id!r} is not available",
            hint=(
                "Result sets are held for a limited time and only a few at once. "
                "Run the search again to re-materialize it."
            ),
        )

    def _reload_from_disk(self, set_id: str) -> MaterializedSet | None:
        meta_path = self._meta_path(set_id)
        raw_path = self._raw_path(set_id)
        if not meta_path.exists() or not raw_path.exists():
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            raw = raw_path.read_bytes()
        except (OSError, json.JSONDecodeError):
            return None

        created_at = float(meta.get("created_at", 0.0))
        if time.time() - created_at > self.ttl_seconds:
            return None

        header, rows = _parse_raw(raw)
        if not header:
            return None
        return MaterializedSet(
            set_id=set_id,
            keyword=meta.get("keyword", ""),
            trials=[to_trial(r, header) for r in rows],
            header=header,
            reported_total=meta.get("reported_total"),
            csv_bytes=meta.get("csv_bytes", len(raw)),
            created_at=created_at,
            provenance=meta.get("provenance", {}) or {},
        )

    def list_sets(self) -> list[dict[str, Any]]:
        return [self._sets[s].summary() for s in self._order if s in self._sets]

    def purge(self, set_id: str | None = None) -> int:
        if set_id is None:
            count = len(self._sets)
            self._sets.clear()
            self._order.clear()
            return count
        removed = 1 if self._sets.pop(set_id, None) is not None else 0
        if set_id in self._order:
            self._order.remove(set_id)
        return removed


def _parse_raw(raw: bytes) -> tuple[tuple[str, ...], list[list[str]]]:
    import csv as _csv
    import io as _io

    text = raw.decode("utf-8-sig", "replace")
    reader = _csv.reader(_io.StringIO(text))
    try:
        header = tuple(h.strip() for h in next(reader))
    except StopIteration:
        return (), []
    rows = [r for r in reader if r and any(c.strip() for c in r)]
    width = len(header)
    return header, [(r + [""] * width)[:width] for r in rows]
