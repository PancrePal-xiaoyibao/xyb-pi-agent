"""CSV rows -> canonical trial dicts.

Every accessor here is total: a row of any length yields a dict with every
canonical key present. Missing values are `None`, never `""`, so that callers can
distinguish "we did not get this" from "the source said blank".

Type modelling reflects measured reality (docs/MEASUREMENTS.md section 4):

* `Target size` is polymorphic -- a bare integer, or per-arm breakdowns like
  `'Drug A:49;Drug B:49;'`. A naive `int()` raises or loses rows.
* `Study design` is polymorphic -- a controlled term like `'Parallel'`, or a full
  CT.gov sentence. It is NOT a closed enum.
* `Recruitment Status` casing is inconsistent upstream, so comparisons normalize.
* `Phase` uses a ChiCTR-specific vocabulary that shares no tokens with CT.gov.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .columns import CSV_COLUMNS

_NULLISH = {"", "n/a", "na", "not applicable", "none", "unknown", "null", "-"}

#: Date shapes measured in the export.
_DATE_DDMMYYYY = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
_DATE_YYYYMMDD = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
_DATE_DMONTHYYYY = re.compile(r"^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$")
_DATETIME_DDMMYYYY = re.compile(
    r"^(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$"
)

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
}

#: Ordering for combined phases such as 'Phase 1/Phase 2'.
_ROMAN_ORDER = ["I", "II", "III", "IV"]

#: Roman numeral -> registry phase digit.
_ROMAN_NUMERAL = {"I": "1", "II": "2", "III": "3", "IV": "4"}

#: Registry phase digit -> roman numeral.
_NUMERAL_ROMAN = {"1": "I", "2": "II", "3": "III", "4": "IV"}


def _to_roman(token: str) -> str:
    """Normalize a captured phase token to a roman numeral (upper case)."""
    token = token.upper()
    return _NUMERAL_ROMAN.get(token, token)


def clean(value: str | None) -> str | None:
    """Strip and null-normalize a raw cell."""
    if value is None:
        return None
    text = value.strip()
    if text.lower() in _NULLISH:
        return None
    return text


def parse_iso_date(value: str | None, *, day_first: bool = True) -> str | None:
    """Parse a measured export date shape into `YYYY-MM-DD`.

    Day-first is verified, not assumed: cross-checked against the unambiguous
    `Date registration3` twin across 6,262 rows with zero contradictions. Prefer
    `parse_registration_date` which uses that unambiguous field directly.
    """
    text = clean(value)
    if text is None:
        return None

    if m := _DATE_YYYYMMDD.match(text):
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"

    if m := _DATE_DDMMYYYY.match(text):
        a, b, y = int(m.group(1)), int(m.group(2)), m.group(3)
        day, month = (a, b) if day_first else (b, a)
        return _safe_iso(y, month, day)

    if m := _DATETIME_DDMMYYYY.match(text):
        a, b, y = int(m.group(1)), int(m.group(2)), m.group(3)
        day, month = (a, b) if day_first else (b, a)
        return _safe_iso(y, month, day)

    if m := _DATE_DMONTHYYYY.match(text):
        month = _MONTHS.get(m.group(2).lower())
        if month is None:
            return None
        return _safe_iso(m.group(3), month, int(m.group(1)))

    return None


def _safe_iso(year: str, month: int, day: int) -> str | None:
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    return f"{int(year):04d}-{month:02d}-{day:02d}"


def split_semicolon_list(value: str | None) -> list[str]:
    """Split a `;`-delimited field, dropping empties.

    Measured: `Secondary ID` uses `;` (`'NCI-2026-06905;2026-1028'`), as do
    outcome and intervention fields.
    """
    text = clean(value)
    if text is None:
        return []
    return [p.strip() for p in text.split(";") if p.strip()]


_TARGET_ARM_RE = re.compile(r"^(.+?):\s*(\d+)\s*$")


@dataclass(frozen=True)
class TargetSize:
    """Parsed `Target size`.

    Either a single total, or per-arm counts. Measured examples:
    `'200'` and `'Capecitabine maintenance group:49;S-1 maintenance group:49;'`.
    """

    total: int | None
    arms: dict[str, int]
    raw: str | None

    @property
    def is_arm_split(self) -> bool:
        return bool(self.arms)

    @property
    def summed(self) -> int | None:
        if self.total is not None:
            return self.total
        if self.arms:
            return sum(self.arms.values())
        return None


def parse_target_size(value: str | None) -> TargetSize:
    text = clean(value)
    if text is None:
        return TargetSize(total=None, arms={}, raw=None)

    if text.isdigit():
        return TargetSize(total=int(text), arms={}, raw=text)

    arms: dict[str, int] = {}
    for part in text.split(";"):
        part = part.strip()
        if not part:
            continue
        if m := _TARGET_ARM_RE.match(part):
            arms[m.group(1).strip()] = int(m.group(2))
    if arms:
        return TargetSize(total=None, arms=arms, raw=text)

    # Last resort: a leading integer inside free text.
    m = re.search(r"\b(\d{1,7})\b", text)
    return TargetSize(total=int(m.group(1)) if m else None, arms={}, raw=text)


def parse_phase(value: str | None) -> tuple[str | None, str | None]:
    """Return `(registry_code, phase_roman)`.

    The phase vocabulary is a genuine mixture and must be read defensively. Values
    observed in a full export include `'Phase 1'`, `'Phase 2'`, `'Phase 1/Phase 2'`,
    a bare `'2'`, `'N/A'`, `'Not selected'`, `'Not Applicable'`, plus ChiCTR-only
    terms that contain no "phase" token at all (`'Other'`, `'Post-market'`,
    `'Pilot study'`, `'Retrospective study'`,
    `'New Treatment Measure Clinical Study'`).

    `None` therefore means "no phase concept applies or none was recorded", which
    is distinct from `'OTHER'` ("a phase concept exists that we cannot map"). The
    raw string is always retained by the caller.
    """
    # Read the raw cell, not `clean()`. `clean()` nulls `'N/A'` and `'Not
    # Applicable'`, but here those are meaningful values that must be mapped to
    # the NA code rather than collapsed into "absent".
    if value is None:
        return None, None
    text = value.strip()
    if not text:
        return None, None

    low = text.lower()

    # Explicit non-phase markers.
    if low in ("n/a", "na", "not applicable", "not selected", "none", "unknown", "null", "-"):
        return "NA", None

    # Phases appear as roman numerals ('Phase II', 'I (Phase I study)') and as
    # bare digits ('Phase 2'). The alternation must try the longer roman numerals
    # first, and must not use a trailing \b after a single 'i'.
    combined = re.findall(r"phase\s*(iv|iii|ii|i|[1-4])(?![a-z0-9])", low)
    if combined:
        romans = sorted({_to_roman(tok) for tok in combined}, key=_ROMAN_ORDER.index)
        if len(romans) == 1:
            return f"PHASE{_ROMAN_NUMERAL[romans[0]]}", romans[0]
        # Multi-phase values keep a single PHASE prefix and slash-joined numerals,
        # e.g. 'PHASEI/II'. `phase_roman` is the human-readable pair.
        return "PHASE" + "/".join(romans), "/".join(romans)

    # Hyphenated ranges, e.g. '1-2', '2-3'.
    if m := re.fullmatch(r"([1-4])\s*[-–]\s*([1-4])", low):
        romans = [_NUMERAL_ROMAN[m.group(1)], _NUMERAL_ROMAN[m.group(2)]]
        romans = sorted(set(romans), key=_ROMAN_ORDER.index)
        return "PHASE" + "/".join(romans), "/".join(romans)

    # A bare roman numeral, e.g. 'III'. Required to come after the range check so
    # it cannot swallow a hyphenated value.
    if low.upper() in _ROMAN_NUMERAL:
        roman = low.upper()
        return f"PHASE{_ROMAN_NUMERAL[roman]}", roman

    # 'Phase 0' / exploratory. No PHASE0 registry code exists, so it is reported
    # as its own concept rather than forced into PHASE1.
    if low in ("0", "phase 0", "phase0"):
        return "PHASE0", None

    # Bare numerals, e.g. '2'. Only trusted when the cell is just a number, so a
    # stray digit inside prose cannot be misread as a phase.
    if low.isdigit() and low in {"1", "2", "3", "4"}:
        return f"PHASE{low}", _NUMERAL_ROMAN[low]

    if "post-market" in low or "post market" in low:
        return "PHASE4", "IV"
    if "pilot" in low or "retrospective" in low:
        return "NA", None

    return "OTHER", None


def _canonical_keys() -> tuple[str, ...]:
    """Stable snake_case keys for all 58 source columns."""
    out: list[str] = []
    for col in CSV_COLUMNS:
        key = col.lower()
        key = re.sub(r"[^a-z0-9]+", "_", key).strip("_")
        out.append(key)
    return tuple(out)


CANONICAL_KEYS: tuple[str, ...] = _canonical_keys()

#: source column -> canonical key
COLUMN_TO_KEY: dict[str, str] = dict(zip(CSV_COLUMNS, CANONICAL_KEYS))

#: canonical key -> source column
KEY_TO_COLUMN: dict[str, str] = dict(zip(CANONICAL_KEYS, CSV_COLUMNS))


def row_to_raw(row: list[str], header: tuple[str, ...]) -> dict[str, str | None]:
    """Map one CSV row onto canonical keys, preserving source column names."""
    out: dict[str, str | None] = {}
    for index, column in enumerate(header):
        key = COLUMN_TO_KEY.get(column)
        if key is None:
            continue
        out[key] = row[index] if index < len(row) else None
    for column, key in COLUMN_TO_KEY.items():
        out.setdefault(key, None)
    return out


def to_trial(row: list[str], header: tuple[str, ...]) -> dict[str, Any]:
    """Build a canonical trial dict from one CSV row.

    Adds derived fields alongside the raw ones. Raw values are always retained;
    derived values are additive and never overwrite the source.
    """
    raw = row_to_raw(row, header)
    trial: dict[str, Any] = dict(raw)

    trial["trial_id"] = clean(raw.get("trialid"))
    trial["source_register"] = clean(raw.get("source_register"))
    trial["public_title"] = clean(raw.get("public_title"))
    trial["scientific_title"] = clean(raw.get("scientific_title"))
    trial["condition"] = clean(raw.get("condition"))
    trial["countries"] = split_semicolon_list(raw.get("countries"))
    trial["secondary_ids"] = split_semicolon_list(raw.get("secondary_id"))
    trial["interventions"] = split_semicolon_list(raw.get("intervention"))
    trial["primary_outcomes"] = split_semicolon_list(raw.get("primary_outcome"))
    trial["secondary_outcomes"] = split_semicolon_list(raw.get("secondary_outcome"))

    # Authoritative date: registration3 is unambiguous yyyymmdd. The dd/mm/yyyy
    # twin is day-first (verified) but only used as a fallback.
    authoritative = parse_iso_date(raw.get("date_registration3"))
    fallback = parse_iso_date(raw.get("date_registration"))
    trial["registration_date"] = authoritative or fallback
    trial["registration_date_source"] = (
        "date_registration3" if authoritative else ("date_registration" if fallback else None)
    )
    trial["registration_date_display"] = clean(raw.get("date_registration"))
    # `Last Refreshed on` is reported as `d Month yyyy`; keep the raw string too
    # because it is the visible data-currency marker users will compare against.
    trial["last_refreshed_display"] = clean(raw.get("last_refreshed_on"))
    trial["last_refreshed_date"] = parse_iso_date(raw.get("last_refreshed_on"))
    trial["export_date_raw"] = clean(raw.get("export_date"))
    trial["export_date"] = parse_iso_date(raw.get("export_date"))

    phase_code, phase_roman = parse_phase(raw.get("phase"))
    trial["phase_code"] = phase_code
    trial["phase_roman"] = phase_roman

    status = clean(raw.get("recruitment_status"))
    trial["recruitment_status"] = status
    trial["recruitment_status_normalized"] = status.lower() if status else None

    target = parse_target_size(raw.get("target_size"))
    trial["target_size_total"] = target.summed
    trial["target_size_arms"] = target.arms or None
    trial["target_size_is_arm_split"] = target.is_arm_split

    age_min = clean(raw.get("inclusion_agemin"))
    age_max = clean(raw.get("inclusion_agemax"))
    trial["inclusion_age_min"] = _as_int(age_min)
    trial["inclusion_age_max"] = _as_int(age_max)

    # `results yes no` is a flag, not content, so it is excluded from the test.
    # Measured: the substantive `results *` columns are ~0.0% populated for
    # ChiCTR records, so this is a property of the registry rather than of an
    # individual trial -- but it is computed per trial so other registries
    # (which do post results) are represented correctly.
    trial["carries_results_data"] = any(
        clean(raw.get(f"results_{suffix}"))
        for suffix in (
            "date_posted", "url_link", "url_protocol", "date_completed",
            "date_first_publication", "summary", "baseline_char", "adverse_events",
            "outcome_measures", "ipd_plan", "ipd_description",
        )
    )

    return trial


def _as_int(value: str | None) -> int | None:
    text = clean(value)
    if text is None:
        return None
    m = re.search(r"-?\d+", text)
    return int(m.group(0)) if m else None
