"""Canonical-JSON persistence for result sets.

Why this exists
---------------
Two independent needs converge on the same format:

1. **Distribution.** A packaged application (pi-desktop and friends) wants trials
   available without a network round trip on first launch. That requires a file
   the application can ship and read directly.
2. **Durability.** The CSV cache in `cache/store.py` stores raw export bytes,
   which are tied to one export's exact header. Canonical JSON is decoupled from
   the upstream column set, so a snapshot stays readable across parser changes.

The format is deliberately boring: one JSON object, a `trials` array of canonical
trial dicts, and a `snapshot` block of provenance. No schema version bump will be
silently ignored -- a reader refuses a `format_version` it does not know.

Licensing note
--------------
WHO ICTRP terms (section 4c) state you "shall not assert any proprietary rights
to any portion of the ICTRP database", and 4d bars commercial use of extracted
information. A snapshot produced here is not our property, and redistributing it
is the operator's decision, not a technical default. `snapshot.attribution` and
`snapshot.terms_notice` are therefore written into every file so a snapshot
cannot be separated from its terms. See docs/BUNDLE.md.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ..errors import ErrorCode, IctrpError

#: Bump only for a breaking change to the object shape. Readers reject unknown values.
FORMAT_VERSION = 1

#: Snapshot kind value. Distinguishes a shipped bundle from a user cache dump.
KIND_BUNDLE = "ictrp-trial-set"

TERMS_NOTICE = (
    "Data from the WHO International Clinical Trials Registry Platform (ICTRP). "
    "ICTRP data are publicly available for download from the ICTRP Search Portal "
    "at no charge. WHO updates ICTRP weekly. Under the ICTRP terms of use you may "
    "not assert proprietary rights to any portion of the ICTRP database, and may "
    "not use the data for marketing, promotional or commercial purposes. This "
    "snapshot is not a WHO product and is not endorsed by WHO."
)


@dataclass
class Snapshot:
    """A trial set plus the provenance needed to describe it honestly."""

    trials: list[dict[str, Any]]
    keyword: str
    created_at: float
    provenance: dict[str, Any]
    format_version: int = FORMAT_VERSION
    kind: str = KIND_BUNDLE

    @property
    def age_seconds(self) -> float:
        return time.time() - self.created_at

    @property
    def age_days(self) -> float:
        return self.age_seconds / 86400.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "format_version": self.format_version,
            "snapshot": {
                "keyword": self.keyword,
                "created_at": _iso(self.created_at),
                "created_at_epoch": self.created_at,
                "trial_count": len(self.trials),
                "attribution": (
                    "Source: WHO International Clinical Trials Registry Platform (ICTRP)."
                ),
                "terms_notice": TERMS_NOTICE,
                "provenance": self.provenance,
            },
            "trials": self.trials,
        }

    def write(self, path: Path) -> int:
        """Write the snapshot, returning bytes written."""
        path.parent.mkdir(parents=True, exist_ok=True)
        body = json.dumps(self.to_dict(), ensure_ascii=False, indent=1)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(path)
        return len(body.encode("utf-8"))

    @classmethod
    def read(cls, path: Path) -> "Snapshot":
        """Load a snapshot, refusing anything structurally unexpected.

        Every failure raises rather than returning an empty set: an unreadable
        bundle must never look like "no trials matched".
        """
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise IctrpError(
                ErrorCode.CACHE_MISS,
                f"snapshot {str(path)!r} could not be read: {exc}",
                hint="Check the path and that the file was shipped with the application.",
            ) from exc

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise IctrpError(
                ErrorCode.UPSTREAM_CONTRACT_DRIFT,
                f"snapshot {str(path)!r} is not valid JSON: {exc}",
                hint="The file is truncated or was not produced by this service.",
            ) from exc

        if not isinstance(data, dict):
            raise IctrpError(
                ErrorCode.UPSTREAM_CONTRACT_DRIFT,
                f"snapshot {str(path)!r} must be a JSON object",
            )

        version = data.get("format_version")
        if version != FORMAT_VERSION:
            raise IctrpError(
                ErrorCode.UPSTREAM_CONTRACT_DRIFT,
                f"snapshot {str(path)!r} has format_version {version!r}; "
                f"this build reads version {FORMAT_VERSION}",
                hint="Regenerate the snapshot with a matching build.",
            )

        trials = data.get("trials")
        if not isinstance(trials, list):
            raise IctrpError(
                ErrorCode.UPSTREAM_CONTRACT_DRIFT,
                f"snapshot {str(path)!r} has no 'trials' array",
            )
        for index, trial in enumerate(trials[:5]):
            if not isinstance(trial, dict):
                raise IctrpError(
                    ErrorCode.UPSTREAM_CONTRACT_DRIFT,
                    f"snapshot {str(path)!r} trial #{index} is not an object",
                )

        meta = data.get("snapshot") or {}
        created_epoch = meta.get("created_at_epoch")
        if not isinstance(created_epoch, (int, float)):
            created_epoch = _parse_iso_epoch(meta.get("created_at"))

        return cls(
            trials=trials,
            keyword=str(meta.get("keyword", "")),
            created_at=float(created_epoch),
            provenance=meta.get("provenance") or {},
            format_version=FORMAT_VERSION,
            kind=str(data.get("kind", KIND_BUNDLE)),
        )

    def stale(self, max_age_days: float) -> bool:
        """True when the snapshot is older than the permitted age."""
        if max_age_days <= 0:
            return False
        return self.age_days > max_age_days


def snapshot_from_trials(
    *,
    trials: Iterable[dict[str, Any]],
    keyword: str,
    provenance: dict[str, Any],
    created_at: float | None = None,
) -> Snapshot:
    return Snapshot(
        trials=list(trials),
        keyword=keyword,
        created_at=created_at if created_at is not None else time.time(),
        provenance=dict(provenance),
    )


def locate_bundle(paths: Iterable[Path]) -> Path | None:
    """Return the first existing snapshot path, or None.

    Ordered by the caller: an explicit environment override should come first, a
    shipped bundle last.
    """
    for candidate in paths:
        if candidate and candidate.is_file():
            return candidate
    return None


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _parse_iso_epoch(value: Any) -> float:
    if not isinstance(value, str):
        return 0.0
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return time.mktime(time.strptime(value, fmt))
        except ValueError:
            continue
    return 0.0
