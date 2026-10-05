"""Offline bundle support.

A packaged desktop application cannot assume a working network on first launch,
and re-running a three-request upstream chain on every cold start is both slow and
rude to a public service. So the service can read a pre-built snapshot instead.

Resolution order for the active offline source:

1. `ICTRP_BUNDLE_PATH` -- an explicit file, used by tests and by operators who
   want to pin a specific dataset.
2. `ICTRP_BUNDLE_DIR` -- a directory holding `<keyword-slug>.json` snapshots.
3. The user cache directory, which is where `ictrp_snapshot` writes by default.

A bundle is never silent. Every response served from one carries
`provenance.offline_snapshot` with the snapshot's age, so a stale shipped dataset
is visible in the output rather than hidden behind a plausible-looking result.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .data.jsonio import Snapshot, locate_bundle
from .errors import ErrorCode, IctrpError

#: A shipped snapshot older than this is flagged loudly. WHO refreshes weekly, so
#: four weeks is well past the point where the data should have been rebuilt.
DEFAULT_MAX_AGE_DAYS = 28.0

ENV_BUNDLE_PATH = "ICTRP_BUNDLE_PATH"
ENV_BUNDLE_DIR = "ICTRP_BUNDLE_DIR"
ENV_MAX_AGE_DAYS = "ICTRP_BUNDLE_MAX_AGE_DAYS"


def snapshot_slug(keyword: str) -> str:
    """Filesystem-safe name for a keyword."""
    slug = re.sub(r"[^a-z0-9]+", "-", keyword.strip().lower()).strip("-")
    return slug or "all"


def bundle_dir() -> Path | None:
    override = os.environ.get(ENV_BUNDLE_DIR)
    if override:
        return Path(override)
    return None


def max_age_days() -> float:
    raw = os.environ.get(ENV_MAX_AGE_DAYS)
    if raw:
        try:
            return float(raw)
        except ValueError:
            return DEFAULT_MAX_AGE_DAYS
    return DEFAULT_MAX_AGE_DAYS


def candidate_paths(keyword: str) -> list[Path]:
    """Where a snapshot for this keyword might live, best candidate first."""
    candidates: list[Path] = []

    explicit = os.environ.get(ENV_BUNDLE_PATH)
    if explicit:
        # An explicit path wins outright, but only if it is for this keyword --
        # otherwise a pinned bundle would silently answer unrelated searches.
        path = Path(explicit)
        if path.is_dir():
            candidates.append(path / f"{snapshot_slug(keyword)}.json")
        else:
            candidates.append(path)

    directory = bundle_dir()
    if directory:
        candidates.append(directory / f"{snapshot_slug(keyword)}.json")

    return candidates


def load_bundle(keyword: str) -> tuple[Snapshot, Path] | None:
    """Load a snapshot for this keyword, or None when there is not one.

    Returns None rather than raising: "no bundle here" is the normal case for a
    live installation, and the caller falls through to the network.
    """
    path = locate_bundle(candidate_paths(keyword))
    if path is None:
        return None

    if path.is_dir():
        raise IctrpError(
            ErrorCode.INVALID_ARGUMENT,
            f"bundle path {str(path)!r} is a directory",
            hint="Point ICTRP_BUNDLE_PATH at a .json snapshot file.",
        )

    snapshot = Snapshot.read(path)

    # A single-file bundle configured by path is assumed to be for the keyword it
    # was written for, but a mismatched keyword means it cannot answer this query.
    if snapshot.keyword and snapshot.keyword.strip().lower() != keyword.strip().lower():
        return None

    return snapshot, path


def snapshot_provenance(snapshot: Snapshot, path: Path) -> dict:
    """Provenance fields describing an offline-served response."""
    stale = snapshot.stale(max_age_days())
    info: dict = {
        "offline_snapshot": True,
        "snapshot_path": str(path),
        "snapshot_created_at": _iso(snapshot.created_at),
        "snapshot_age_days": round(snapshot.age_days, 2),
        "snapshot_trial_count": len(snapshot.trials),
    }
    if stale:
        info["snapshot_stale"] = True
        info["snapshot_stale_warning"] = (
            f"This snapshot is {snapshot.age_days:.1f} days old, beyond the "
            f"{max_age_days():.0f}-day freshness limit. WHO refreshes ICTRP weekly. "
            "Refresh the snapshot before relying on this data."
        )
    else:
        info["snapshot_stale"] = False
    return info


def _iso(epoch: float) -> str:
    import time

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))
