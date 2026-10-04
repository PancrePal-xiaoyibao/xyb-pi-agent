"""Tool implementations.

Each function returns a plain dict that already carries provenance. The MCP layer
in `server.py` only handles transport concerns.

Design rules enforced here:

* No tool reports zero results unless a validated export genuinely contained zero
  rows. Failures raise `IctrpError` and never degrade into an empty list.
* Every response carries `provenance`, including the local-only tools, because a
  response that omits it cannot be attributed.
* Local tools (`ictrp_filter`, `ictrp_field_query`, `ictrp_registry_summary`,
  `ictrp_find_duplicates`, `ictrp_export`) do not touch the network. Refining a
  search is therefore free and repeatable.
"""

from __future__ import annotations

import csv
import io
import json
import os
import time
from pathlib import Path
from typing import Any

from . import offline
from .cache.store import SetStore, query_key
from .data import query as q
from .data.columns import CSV_COLUMNS
from .data.jsonio import snapshot_from_trials
from .errors import ErrorCode, IctrpError
from .ictrp.session import IctrpSession
from .provenance import INCOMPLETENESS_NOTICE, Provenance, derive_set_provenance

#: Fields shown by default when a caller does not ask for specific ones. Chosen to
#: be the high-coverage, decision-relevant columns rather than all 58.
DEFAULT_FIELDS: tuple[str, ...] = (
    "trial_id",
    "source_register",
    "public_title",
    "recruitment_status",
    "phase_code",
    "registration_date",
    "condition",
    "countries",
    "target_size_total",
    "last_refreshed_display",
)

#: How long a cached set is served before a refresh is attempted automatically.
#: Short enough that a weekly upstream refresh is picked up promptly, long enough
#: that a session of repeated queries makes one export rather than many.
DEFAULT_REFRESH_AFTER_SECONDS = 7 * 24 * 60 * 60

ENV_REFRESH_AFTER = "ICTRP_REFRESH_AFTER_SECONDS"
ENV_AUTO_REFRESH = "ICTRP_AUTO_REFRESH"


def _refresh_after_seconds() -> int:
    raw = os.environ.get(ENV_REFRESH_AFTER)
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    return DEFAULT_REFRESH_AFTER_SECONDS


def _auto_refresh_enabled() -> bool:
    """Auto-refresh is on unless explicitly disabled.

    "Off" exists for reproducible runs and for offline deployments, where reaching
    the network at an unpredictable moment is worse than serving older data.
    """
    raw = os.environ.get(ENV_AUTO_REFRESH, "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


class IctrpService:
    """Holds the cache and executes tools against it."""

    #: How long a refresh failure suppresses further automatic attempts, so a
    #: failing upstream is not retried on every single call.
    REFRESH_FAILURE_BACKOFF_SECONDS = 15 * 60

    def __init__(self, store: SetStore | None = None) -> None:
        self.store = store or SetStore()
        self._refresh_failures: dict[str, tuple[float, str]] = {}

    # ---- network-backed ---------------------------------------------------

    async def search(
        self,
        keyword: str,
        *,
        limit: int = 50,
        offset: int = 0,
        fields: list[str] | None = None,
        filters: list[dict[str, Any]] | None = None,
        sort_by: str | None = None,
        descending: bool = False,
        refresh: bool = False,
    ) -> dict[str, Any]:
        """Materialize a search, then return a page of it.

        The set stays queryable afterwards, so subsequent refinement costs nothing.

        Refresh policy: `refresh=True` forces an upstream search. Otherwise a cached
        set is reused until it is older than the refresh interval, at which point an
        automatic refresh is attempted -- and, if that fails, the cached set is
        served anyway with the failure recorded in provenance. Serving known-stale
        data is preferable to failing a query, provided the staleness is stated.
        """
        if not keyword or not keyword.strip():
            raise IctrpError(
                ErrorCode.INVALID_ARGUMENT,
                "keyword is required",
                hint="Provide a search term, e.g. 'pancreatic cancer'.",
            )
        if limit < 1 or limit > 1000:
            raise IctrpError(
                ErrorCode.INVALID_ARGUMENT,
                "limit must be between 1 and 1000",
            )
        if offset < 0:
            raise IctrpError(ErrorCode.INVALID_ARGUMENT, "offset must be >= 0")

        cache_hit = False
        refresh_error: str | None = None
        # Always look for a cached set, even when a refresh was forced. A forced
        # refresh means "try to get fresh data", not "throw away what we have":
        # if the attempt fails, the cached set is still the best answer
        # available, and the code below is written to serve it with the failure
        # recorded. Skipping this lookup made `previous` None, so the failure
        # handler re-raised and an explicit refresh on a flaky network
        # destroyed usable cached data instead of falling back to it.
        materialized = self._cached_set(keyword)

        should_refresh = refresh or (materialized is not None and self._should_refresh(materialized))
        if should_refresh and self._auto_refresh_allows(keyword, force=refresh):
            previous = materialized
            try:
                materialized = await self._materialize(keyword)
                self._refresh_failures.pop(query_key(keyword), None)
            except IctrpError as exc:
                if previous is None:
                    raise
                # We already hold data. Report the failure alongside it rather than
                # discarding a usable set.
                materialized = previous
                refresh_error = f"{exc.code.value}: {exc.message}"
                self._refresh_failures[query_key(keyword)] = (time.time(), refresh_error)

        if materialized is None:
            materialized = await self._materialize(keyword)
        elif not should_refresh:
            cache_hit = True
        else:
            cache_hit = refresh_error is not None

        trials = materialized.trials
        filtered = q.apply_filters(trials, filters)
        ordered = q.sort_trials(filtered, sort_by, descending)
        page = ordered[offset : offset + limit]

        provenance = Provenance.from_dict(materialized.provenance) if materialized.provenance else Provenance.now()
        provenance.cache_hit = cache_hit
        provenance.rows_returned = materialized.rows_returned
        provenance.upstream_reported_total = materialized.reported_total
        provenance.records_incomplete = materialized.is_incomplete
        provenance.estimated_missing = materialized.missing_estimate
        self._annotate_age(provenance, materialized)
        if refresh_error:
            provenance.notes.append(
                f"Automatic refresh failed and an older cached set was served instead. {refresh_error}"
            )

        selected = list(fields) if fields else list(DEFAULT_FIELDS)
        return {
            "status": "ok",
            "set_id": materialized.set_id,
            "matched_rows_returned": len(ordered),
            "upstream_reported_total": materialized.reported_total,
            "records_incomplete": materialized.is_incomplete,
            "estimated_missing": materialized.missing_estimate,
            "counts_are_of_retrieved_rows_not_of_matching_trials": True,
            "offset": offset,
            "limit": limit,
            "trials": [{"trial_id": t.get("trial_id"), **{f: t.get(f) for f in selected}} for t in page],
            "provenance": provenance.to_dict(),
        }

    def _should_refresh(self, materialized) -> bool:
        return materialized.age_seconds() > _refresh_after_seconds()

    def _auto_refresh_allows(self, keyword: str, *, force: bool) -> bool:
        """Whether a refresh may be attempted right now.

        A forced refresh always proceeds -- that is what forcing means, and the
        caller has explicitly accepted the cost. Note this must be an early
        `return True`, not a fall-through: an inverted test here made
        `refresh=True` a silent no-op, so the one escape hatch out of the
        backoff window below did not exist.

        An automatic one is skipped when it is disabled, or when a recent
        attempt already failed -- repeatedly retrying a failing upstream would
        turn one outage into a request storm.
        """
        if force:
            return True
        if not _auto_refresh_enabled():
            return False
        failure = self._refresh_failures.get(query_key(keyword))
        if failure is None:
            return True
        failed_at, _ = failure
        return (time.time() - failed_at) > self.REFRESH_FAILURE_BACKOFF_SECONDS

    def _annotate_age(self, provenance: Provenance, materialized) -> None:
        """Record how old the served data is, whatever its origin."""
        age_days = materialized.age_seconds() / 86400.0
        provenance.notes.append(
            f"Data age: {age_days:.2f} days (set created {_iso(materialized.created_at)})."
        )
        if materialized.age_seconds() > _refresh_after_seconds():
            provenance.notes.append(
                "This set is older than the configured refresh interval "
                f"({_refresh_after_seconds()}s); it was served because a refresh was "
                "not permitted or did not succeed."
            )

    async def _materialize(self, keyword: str):
        """Run the upstream chain, falling back to a local snapshot when possible.

        The fallback is deliberately narrow: snapshots are consulted only after an
        upstream attempt has failed, never in preference to it. A deployment that
        can reach the network should always get live data; a deployment that cannot
        should get clearly-labelled older data instead of an error.
        """
        try:
            return await self._fetch_upstream(keyword)
        except IctrpError as exc:
            if not _is_offline_fallback_worthy(exc):
                raise
            bundled = offline.load_bundle(keyword)
            if bundled is None:
                raise
            snapshot, path = bundled
            provenance = dict(snapshot.provenance)
            provenance.update(offline.snapshot_provenance(snapshot, path))
            notes = list(provenance.get("notes") or [])
            notes.append(
                f"Upstream request failed ({exc.code.value}); this response was served "
                f"from a local snapshot instead. Upstream error: {exc.message}"
            )
            provenance["notes"] = notes
            return self.store.adopt(
                keyword=keyword,
                trials=snapshot.trials,
                provenance=provenance,
                created_at=snapshot.created_at,
                source_label="snapshot",
            )

    async def _fetch_upstream(self, keyword: str):
        session = IctrpSession.create()
        try:
            await session.load_form()
            await session.search(keyword)
            payload = await session.export_csv()
            steps = session.provenance_steps()
            response_date = session.response_date
        finally:
            await session.aclose()

        provenance = derive_set_provenance(
            keyword=keyword,
            trials=[],  # filled in by the store; only used for date extraction below
            reported_total=payload.reported_total,
            response_date=response_date,
            steps=steps,
        )

        # Build trial dicts once to derive export/last-refreshed dates for provenance.
        from .data.normalize import to_trial

        trials = [to_trial(row, payload.header) for row in payload.rows]
        export_dates = sorted({t.get("export_date_raw") for t in trials if t.get("export_date_raw")})
        refreshed = sorted(
            {t.get("last_refreshed_display") for t in trials if t.get("last_refreshed_display")}
        )
        if export_dates:
            provenance.ictrp_export_date = export_dates[0]
            provenance.notes = [n for n in provenance.notes if "Export date" not in n]

        raw = _serialize_csv(payload.header, payload.rows)
        materialized = self.store.store(
            keyword=keyword,
            payload_raw=raw,
            header=payload.header,
            rows=payload.rows,
            reported_total=payload.reported_total,
            provenance=provenance.to_dict(),
        )

        if payload.is_empty:
            raise IctrpError(
                ErrorCode.NO_RESULTS,
                f"The portal returned a valid export with no matching trials for {keyword!r}",
                hint=(
                    "This is a genuine zero: the export was structurally valid and "
                    "contained no data rows."
                ),
            )
        return materialized

    def _cached_set(self, keyword: str):
        candidate = query_key(keyword)
        try:
            return self.store.get(candidate)
        except IctrpError:
            return None

    # ---- local-only -------------------------------------------------------

    def filter_set(
        self,
        set_id: str,
        *,
        filters: list[dict[str, Any]] | None = None,
        sort_by: str | None = None,
        descending: bool = False,
        limit: int = 50,
        offset: int = 0,
        fields: list[str] | None = None,
    ) -> dict[str, Any]:
        materialized = self.store.get(set_id)
        filtered = q.apply_filters(materialized.trials, filters)
        ordered = q.sort_trials(filtered, sort_by, descending)
        page = ordered[offset : offset + limit]
        selected = list(fields) if fields else list(DEFAULT_FIELDS)

        provenance = Provenance.from_dict(materialized.provenance)
        provenance.cache_hit = True
        provenance.rows_returned = materialized.rows_returned
        provenance.upstream_reported_total = materialized.reported_total
        provenance.records_incomplete = materialized.is_incomplete
        provenance.estimated_missing = materialized.missing_estimate

        return {
            "status": "ok",
            "set_id": set_id,
            "matched_rows_returned": len(ordered),
            "of_rows_in_set": materialized.rows_returned,
            "counts_are_of_retrieved_rows_not_of_matching_trials": True,
            "offset": offset,
            "limit": limit,
            "trials": [{"trial_id": t.get("trial_id"), **{f: t.get(f) for f in selected}} for t in page],
            "provenance": provenance.to_dict(),
            "note": "This operation was served entirely from the cached set; no upstream request was made.",
        }

    def field_query(
        self,
        *,
        field: str,
        set_id: str | None = None,
        keyword: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        materialized = self._resolve(set_id, keyword)
        values = q.facet(materialized.trials, field, limit=limit)
        coverage = q.field_coverage(materialized.trials, [field])[field]

        provenance = Provenance.from_dict(materialized.provenance)
        provenance.cache_hit = True
        return {
            "status": "ok",
            "set_id": materialized.set_id,
            "field": field,
            "coverage": coverage,
            "distinct_values": values,
            "provenance": provenance.to_dict(),
            "note": "Served from the cached set; no upstream request was made.",
        }

    def registry_summary(
        self,
        *,
        set_id: str | None = None,
        keyword: str | None = None,
        group_by: list[str] | None = None,
    ) -> dict[str, Any]:
        materialized = self._resolve(set_id, keyword)
        groups = group_by or ["source_register"]
        facets = {g: q.facet(materialized.trials, g) for g in groups}

        provenance = Provenance.from_dict(materialized.provenance)
        provenance.cache_hit = True
        return {
            "status": "ok",
            "set_id": materialized.set_id,
            "rows_in_set": materialized.rows_returned,
            "upstream_reported_total": materialized.reported_total,
            "records_incomplete": materialized.is_incomplete,
            "facets": facets,
            "field_coverage": q.field_coverage(
                materialized.trials,
                [
                    "trial_id", "public_title", "scientific_title", "condition",
                    "intervention", "primary_outcome", "secondary_outcome",
                    "inclusion_criteria", "exclusion_criteria",
                    "target_size_total", "countries", "inclusion_agemin",
                    "inclusion_agemax", "inclusion_gender", "ethics_status",
                    "secondary_id", "results_yes_no",
                ],
            ),
            "provenance": provenance.to_dict(),
            "note": "Served from the cached set; no upstream request was made.",
        }

    def find_duplicates(
        self,
        *,
        set_id: str | None = None,
        keyword: str | None = None,
    ) -> dict[str, Any]:
        materialized = self._resolve(set_id, keyword)
        groups = q.find_duplicates(materialized.trials)
        provenance = Provenance.from_dict(materialized.provenance)
        provenance.cache_hit = True
        return {
            "status": "ok",
            "set_id": materialized.set_id,
            "rows_in_set": materialized.rows_returned,
            "candidate_groups": groups,
            "group_count": len(groups),
            "method": (
                "Identifier cross-references only (Secondary ID). Title similarity is "
                "deliberately not used; multi-centre trials share near-identical titles."
            ),
            "provenance": provenance.to_dict(),
            "note": "Served from the cached set; no upstream request was made.",
        }

    def export_records(
        self,
        *,
        set_id: str | None = None,
        keyword: str | None = None,
        fmt: str = "json",
        fields: list[str] | None = None,
        filters: list[dict[str, Any]] | None = None,
        include_provenance_header: bool = True,
    ) -> dict[str, Any]:
        materialized = self._resolve(set_id, keyword)
        rows = q.apply_filters(materialized.trials, filters)
        selected = list(fields) if fields else list(materialized.trials[0].keys()) if materialized.trials else []
        provenance = Provenance.from_dict(materialized.provenance)
        provenance.cache_hit = True

        if fmt == "csv":
            buffer = io.StringIO()
            writer = csv.writer(buffer)
            writer.writerow(selected)
            for row in rows:
                writer.writerow([_cell(row.get(f)) for f in selected])
            body = buffer.getvalue()
        elif fmt == "jsonl":
            body = "\n".join(
                json.dumps({f: row.get(f) for f in selected}, ensure_ascii=False) for row in rows
            )
        elif fmt == "markdown":
            lines = ["| " + " | ".join(selected) + " |", "|" + "---|" * len(selected)]
            for row in rows:
                lines.append("| " + " | ".join(_cell(row.get(f)) for f in selected) + " |")
            body = "\n".join(lines)
        elif fmt == "json":
            body = json.dumps(
                [{f: row.get(f) for f in selected} for row in rows],
                ensure_ascii=False,
                indent=2,
            )
        else:
            raise IctrpError(
                ErrorCode.INVALID_ARGUMENT,
                f"unsupported format {fmt!r}",
                hint="Supported: csv, json, jsonl, markdown.",
            )

        header = ""
        if include_provenance_header:
            header = (
                f"# Source: WHO ICTRP ({provenance.source_url})\n"
                f"# Retrieved: {provenance.retrieved_at}\n"
                f"# Rows in this export: {len(rows)}\n"
            )
            if provenance.upstream_reported_total is not None:
                header += f"# Portal-reported matches: {provenance.upstream_reported_total}\n"
            if provenance.records_incomplete:
                header += f"# WARNING: {INCOMPLETENESS_NOTICE}\n"

        return {
            "status": "ok",
            "set_id": materialized.set_id,
            "format": fmt,
            "row_count": len(rows),
            "content": header + body,
            "provenance": provenance.to_dict(),
            "note": "Served from the cached set; no upstream request was made.",
        }

    def cache_status(self, *, action: str = "list", set_id: str | None = None) -> dict[str, Any]:
        if action == "list":
            sets = self.store.list_sets()
            return {
                "status": "ok",
                "action": "list",
                "sets": sets,
                "set_count": len(sets),
                "cache_dir": str(self.store.cache_dir),
                "max_in_memory_sets": 3,
                "refresh_after_seconds": _refresh_after_seconds(),
                "auto_refresh": _auto_refresh_enabled(),
                "bundle_configured": {
                    "ICTRP_BUNDLE_PATH": os.environ.get(offline.ENV_BUNDLE_PATH),
                    "ICTRP_BUNDLE_DIR": os.environ.get(offline.ENV_BUNDLE_DIR),
                    "max_age_days": offline.max_age_days(),
                },
                "note": (
                    "Only a few sets stay parsed in memory; others are re-read from "
                    "disk on demand. Raw CSV is cached because re-exporting is expensive."
                ),
            }
        if action == "purge":
            removed = self.store.purge(set_id)
            return {"status": "ok", "action": "purge", "removed": removed, "set_id": set_id}
        raise IctrpError(
            ErrorCode.INVALID_ARGUMENT,
            f"unsupported action {action!r}",
            hint="Supported: list, purge.",
        )

    # ---- snapshot / bundle ------------------------------------------------

    def snapshot(
        self,
        *,
        set_id: str | None = None,
        keyword: str | None = None,
        path: str | None = None,
        if_stale: bool = True,
    ) -> dict[str, Any]:
        """Write a cached set to a canonical JSON snapshot.

        Intended for two uses: producing a dataset to ship inside a packaged
        application, and refreshing such a dataset on a schedule. `if_stale=False`
        forces a rewrite even when the existing snapshot is fresh, which is what a
        release pipeline wants.
        """
        materialized = self._resolve(set_id, keyword)
        if not materialized.trials:
            raise IctrpError(
                ErrorCode.NO_RESULTS,
                "refusing to write an empty snapshot",
                hint=(
                    "A snapshot is a distribution artifact; an empty one would make a "
                    "packaged application look like it had no data."
                ),
            )

        target = self._snapshot_target(materialized.keyword, path)

        if if_stale and target.is_file():
            try:
                existing = offline.load_bundle(materialized.keyword)
                if existing is not None:
                    snapshot_obj, existing_path = existing
                    if existing_path == target and not snapshot_obj.stale(offline.max_age_days()):
                        return {
                            "status": "ok",
                            "action": "skipped",
                            "reason": "snapshot is still within its freshness limit",
                            "path": str(target),
                            "age_days": round(snapshot_obj.age_days, 2),
                            "trial_count": len(snapshot_obj.trials),
                        }
            except IctrpError:
                # An unreadable existing file is a reason to overwrite it, not to fail.
                pass

        provenance = Provenance.from_dict(materialized.provenance)
        provenance.cache_hit = True
        snapshot_obj = snapshot_from_trials(
            trials=materialized.trials,
            keyword=materialized.keyword,
            provenance=provenance.to_dict(),
            created_at=materialized.created_at,
        )
        size = snapshot_obj.write(target)

        return {
            "status": "ok",
            "action": "written",
            "path": str(target),
            "trial_count": len(snapshot_obj.trials),
            "bytes": size,
            "data_created_at": _iso(materialized.created_at),
            "provenance": provenance.to_dict(),
            "terms_notice": (
                "This file contains WHO ICTRP data. Redistributing it is a decision "
                "about the ICTRP terms of use, not a technical default. See "
                "docs/BUNDLE.md."
            ),
        }

    def bundle_status(self, *, keyword: str | None = None) -> dict[str, Any]:
        """Report which snapshot would serve a query, and how old it is."""
        if not keyword:
            raise IctrpError(
                ErrorCode.INVALID_ARGUMENT,
                "keyword is required to locate a snapshot",
            )
        candidates = [str(p) for p in offline.candidate_paths(keyword)]
        bundled = offline.load_bundle(keyword)
        out: dict[str, Any] = {
            "status": "ok",
            "keyword": keyword,
            "candidates_checked": candidates,
            "bundle_found": bundled is not None,
            "configured": {
                "ICTRP_BUNDLE_PATH": os.environ.get(offline.ENV_BUNDLE_PATH),
                "ICTRP_BUNDLE_DIR": os.environ.get(offline.ENV_BUNDLE_DIR),
                "max_age_days": offline.max_age_days(),
            },
            "auto_refresh": _auto_refresh_enabled(),
            "refresh_after_seconds": _refresh_after_seconds(),
        }
        if bundled is not None:
            snapshot_obj, path = bundled
            out["snapshot"] = offline.snapshot_provenance(snapshot_obj, path)
            out["snapshot"]["keyword"] = snapshot_obj.keyword
        else:
            out["hint"] = (
                "No snapshot for this keyword. Run ictrp_search then ictrp_snapshot to "
                "create one, or set ICTRP_BUNDLE_PATH / ICTRP_BUNDLE_DIR."
            )
        return out

    def _snapshot_target(self, keyword: str, path: str | None) -> Path:
        if path:
            return Path(path).expanduser()
        directory = offline.bundle_dir()
        if directory:
            return directory / f"{offline.snapshot_slug(keyword)}.json"
        return self.store.cache_dir / "snapshots" / f"{offline.snapshot_slug(keyword)}.json"

    # ---- internals --------------------------------------------------------

    def _resolve(self, set_id: str | None, keyword: str | None):
        if set_id:
            return self.store.get(set_id)
        if keyword:
            materialized = self._cached_set(keyword)
            if materialized is not None:
                return materialized
            raise IctrpError(
                ErrorCode.CACHE_MISS,
                f"no cached result set for keyword {keyword!r}",
                hint="Run ictrp_search with this keyword first, or pass a set_id.",
            )
        raise IctrpError(
            ErrorCode.INVALID_ARGUMENT,
            "provide either set_id or keyword",
        )


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


#: Failures that justify falling back to a local snapshot. A missing result or a
#: malformed request will not be fixed by older data, so those propagate.
_OFFLINE_FALLBACK_CODES = frozenset(
    {
        ErrorCode.UPSTREAM_BLOCKED,
        ErrorCode.UPSTREAM_ERROR,
        ErrorCode.SESSION_FAILED,
        ErrorCode.UPSTREAM_CONTRACT_DRIFT,
    }
)


def _is_offline_fallback_worthy(exc: IctrpError) -> bool:
    return exc.code in _OFFLINE_FALLBACK_CODES


def _serialize_csv(header: tuple[str, ...], rows: list[list[str]]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")
