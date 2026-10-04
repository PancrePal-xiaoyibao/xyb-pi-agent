"""Local querying over a materialized result set.

None of these functions touch the network. That is the point: once an export has
been materialized, filtering, faceting, summarizing and exporting are all local
operations, so a user can refine a search repeatedly without re-hitting the
portal.

Every count produced here is a count of what we actually hold. It is never a
claim about how many trials exist -- the export is provably incomplete
(docs/MEASUREMENTS.md section 2), so the accompanying total from the portal is
carried separately and never merged into these numbers.
"""

from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

#: Operators supported by `apply_filters`.
_OPERATORS = {
    "eq", "ne", "contains", "not_contains", "in", "not_in",
    "gt", "gte", "lt", "lte", "exists", "not_exists", "is_null", "is_not_null",
}


def _coerce(value: Any) -> Any:
    """Lowercase strings for case-insensitive comparison; pass others through."""
    if isinstance(value, str):
        return value.strip().lower()
    return value


def _field_value(trial: dict[str, Any], field: str) -> Any:
    """Resolve a field, preferring the curated alias over a raw source column.

    Aliases must win. Several canonical raw keys (`phase`, `countries`,
    `target_size`) hold unparsed source strings, while the derived key
    (`phase_code`, `countries`, `target_size_total`) is what callers mean. If the
    raw key were consulted first, `phase` would silently return `'Phase 2'`
    instead of the normalized registry code.
    """
    alias = _ALIASES.get(field)
    if alias is not None and alias in trial:
        return trial[alias]
    if field in trial:
        return trial[field]
    return None


#: Convenience aliases so callers do not need to remember raw column spellings.
#: Keys that already exist as canonical trial fields (e.g. `trial_id`,
#: `source_register`) resolve directly and need no entry here; only renamed
#: fields are listed.
_ALIASES: dict[str, str] = {
    "title": "public_title",
    "status": "recruitment_status_normalized",
    "register": "source_register",
    "reg_date": "registration_date",
    "phase": "phase_code",
    "country": "countries",
    "age_min": "inclusion_age_min",
    "age_max": "inclusion_age_max",
    "target_size": "target_size_total",
}


def _match(trial: dict[str, Any], field: str, operator: str, expected: Any) -> bool:
    actual = _field_value(trial, field)

    if operator == "exists" or operator == "is_not_null":
        return actual is not None and actual != [] and actual != ""
    if operator == "not_exists" or operator == "is_null":
        return actual is None or actual == [] or actual == ""

    if operator == "eq":
        return _coerce(actual) == _coerce(expected)
    if operator == "ne":
        return _coerce(actual) != _coerce(expected)

    if operator in ("contains", "not_contains"):
        needle = _coerce(expected)
        if isinstance(actual, list):
            hit = any(_coerce(item) == needle or needle in str(_coerce(item)) for item in actual)
        else:
            hit = needle in str(_coerce(actual or ""))
        return hit if operator == "contains" else not hit

    if operator in ("in", "not_in"):
        if not isinstance(expected, (list, tuple, set)):
            expected = [expected]
        options = {_coerce(e) for e in expected}
        if isinstance(actual, list):
            hit = any(_coerce(item) in options for item in actual)
        else:
            hit = _coerce(actual) in options
        return hit if operator == "in" else not hit

    if operator in ("gt", "gte", "lt", "lte"):
        try:
            left = float(actual)  # type: ignore[arg-type]
            right = float(expected)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return False
        return {
            "gt": left > right, "gte": left >= right,
            "lt": left < right, "lte": left <= right,
        }[operator]

    raise ValueError(f"unsupported operator: {operator!r}")


def apply_filters(
    trials: Iterable[dict[str, Any]],
    filters: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Apply a conjunction of filters.

    Each filter: `{"field": str, "op": str, "value": Any}`.
    """
    rows = list(trials)
    if not filters:
        return rows
    for spec in filters:
        field = spec.get("field")
        operator = spec.get("op", "eq")
        if not field:
            raise ValueError("each filter needs a 'field'")
        if operator not in _OPERATORS:
            raise ValueError(
                f"unsupported operator {operator!r}; supported: {sorted(_OPERATORS)}"
            )
        expected = spec.get("value")
        rows = [r for r in rows if _match(r, field, operator, expected)]
    return rows


def sort_trials(
    trials: list[dict[str, Any]],
    sort_by: str | None,
    descending: bool = False,
) -> list[dict[str, Any]]:
    """Sort, keeping null-ish values last in both directions.

    Sorting is done on the populated subset only, then the missing ones are
    appended, so a descending sort never floats blanks to the top.
    """
    if not sort_by:
        return trials

    populated: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for trial in trials:
        value = _field_value(trial, sort_by)
        if value is None or value == "" or value == []:
            missing.append(trial)
        else:
            populated.append(trial)

    populated.sort(key=lambda t: _sortable(_field_value(t, sort_by)), reverse=descending)
    return populated + missing


def _sortable(value: Any) -> Any:
    if isinstance(value, list):
        return ";".join(str(v) for v in value)
    return value


def facet(
    trials: Iterable[dict[str, Any]],
    field: str,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Value counts for a field, with the null bucket reported separately.

    String values are case-folded before counting, because upstream casing is
    inconsistent (measured: `'Not Recruiting'` alongside `'Not recruiting'`).
    """
    counter: Counter[str] = Counter()
    nulls = 0

    for trial in trials:
        value = _field_value(trial, field)
        if value is None or value == "" or value == []:
            nulls += 1
            continue
        if isinstance(value, list):
            for item in value:
                counter[str(item).strip()] += 1
        else:
            counter[str(value).strip()] += 1

    folded: Counter[str] = Counter()
    display: dict[str, str] = {}
    for value, count in counter.items():
        key = value.lower()
        folded[key] += count
        display.setdefault(key, value)

    top = folded.most_common(limit)
    return [
        {"value": display[key], "count": count}
        for key, count in top
    ] + ([{"value": None, "count": nulls}] if nulls else [])


def field_coverage(
    trials: Iterable[dict[str, Any]],
    fields: Iterable[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Population statistics per field.

    This is the honest complement to a result count: it says how much of each
    field we actually have, so a caller can see that e.g. ethics fields are
    sparse for one registry rather than assuming blank means "none recorded".
    """
    rows = list(trials)
    total = len(rows)
    names = list(fields) if fields else sorted({k for r in rows for k in r})
    out: dict[str, dict[str, Any]] = {}
    for name in names:
        populated = 0
        for row in rows:
            value = _field_value(row, name)
            if value is not None and value != "" and value != []:
                populated += 1
        out[name] = {
            "populated": populated,
            "total": total,
            "coverage": round(populated / total, 4) if total else 0.0,
        }
    return out


def find_duplicates(
    trials: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Group records that likely describe the same underlying trial.

    Two distinct patterns are reported, because they need different handling:

    * `shared_secondary_id` -- two or more held records name the same secondary
      identifier. Both are in the set; a caller can compare them directly.
    * `cross_reference` -- a held record points at an identifier that is itself
      another held record's `TrialID`. The pair is a chain, not a shared value,
      so matching on equality of secondary ids alone would miss it.

    Only identifier evidence is used. Title matching is deliberately avoided: it
    produces false positives on the multi-centre trials that legitimately share a
    near-identical public title.
    """
    rows = list(trials)
    id_index: dict[str, str] = {}
    for row in rows:
        trial_id = row.get("trial_id")
        if trial_id:
            id_index.setdefault(trial_id.strip().upper(), trial_id)

    by_secondary: dict[str, list[str]] = {}
    for row in rows:
        trial_id = row.get("trial_id")
        if not trial_id:
            continue
        for secondary in row.get("secondary_ids") or []:
            key = secondary.strip().upper()
            if key and key != trial_id.strip().upper():
                by_secondary.setdefault(key, []).append(trial_id)

    groups: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()

    # Pattern 1: several held records name the same secondary identifier.
    for secondary, holders in sorted(by_secondary.items()):
        if len(holders) < 2:
            continue
        groups.append(
            {
                "match_type": "shared_secondary_id",
                "matched_value": secondary,
                "trial_ids": sorted(dict.fromkeys(holders)),
                "resolvable": False,
            }
        )

    # Pattern 2: a record's secondary id resolves to another held record.
    for secondary, holders in sorted(by_secondary.items()):
        target = id_index.get(secondary)
        if not target:
            continue
        for holder in dict.fromkeys(holders):
            if holder.strip().upper() == target.strip().upper():
                continue
            pair = tuple(sorted((holder, target)))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            groups.append(
                {
                    "match_type": "cross_reference",
                    "matched_value": secondary,
                    "trial_ids": list(pair),
                    "resolvable": True,
                }
            )

    return groups
