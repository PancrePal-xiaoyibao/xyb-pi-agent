"""The 58 ICTRP CSV column headers, as literal strings.

These are reproduced VERBATIM from the live export, including three
misspellings present in the upstream data:

    'Inclusion agemin'      (not 'agemin' -> 'age_min')
    'Inclusion agemax'
    'Date enrollement'      (not 'enrollment')

Do NOT "correct" these. The parser matches on the exact upstream strings; a
helpful-looking normalisation here would silently produce all-null fields.
`tests/test_columns.py` asserts the exact set so an upstream rename surfaces as
a failing test rather than a silently degraded response.
"""

from __future__ import annotations

#: Column order as returned by the live export. Order is not load-bearing for
#: parsing (we match by name) but is asserted for drift detection.
CSV_COLUMNS: tuple[str, ...] = (
    "TrialID",
    "Last Refreshed on",
    "Public title",
    "Scientific title",
    "Acronym",
    "Primary sponsor",
    "Date registration",
    "Date registration3",
    "Export date",
    "Source Register",
    "web address",
    "Recruitment Status",
    "other records",
    "Inclusion agemin",
    "Inclusion agemax",
    "Inclusion gender",
    "Date enrollement",
    "Target size",
    "Study type",
    "Study design",
    "Phase",
    "Countries",
    "Contact Firstname",
    "Contact Lastname",
    "Contact Address",
    "Contact Email",
    "Contact Tel",
    "Contact Affiliation",
    "Inclusion Criteria",
    "Exclusion Criteria",
    "Condition",
    "Intervention",
    "Primary outcome",
    "Secondary outcome",
    "Secondary ID",
    "Source Name",
    "Secondary Sponsor",
    "Ethics Status",
    "Ethics Approval Date",
    "Ethics Contact Name",
    "Ethics Contact Address",
    "Ethics Contact Phone",
    "Ethics Contact Email",
    "results yes no",
    "results date posted",
    "results url link",
    "results url protocol",
    "results date completed",
    "results date first publication",
    "results summary",
    "results baseline char",
    "results adverse events",
    "results outcome measures",
    "results ipd plan",
    "results ipd description",
    "Prospective registration",
    "Bridging flag truefalse",
    "Bridged type",
)

#: Columns without which a response cannot be treated as a valid ICTRP export.
#: A CSV missing any of these is `UpstreamContractDrift`, never "no results".
REQUIRED_COLUMNS: frozenset[str] = frozenset(
    {
        "TrialID",
        "Source Register",
        "Public title",
        "Scientific title",
        "Recruitment Status",
        "Date registration",
        "Last Refreshed on",
        "Export date",
        "Phase",
        "Condition",
    }
)

#: Columns where a new value indicates upstream vocabulary drift and should be
#: surfaced rather than silently absorbed into a facet list.
FACET_COLUMNS: frozenset[str] = frozenset(
    {"Source Register", "Phase", "Recruitment Status", "Study type", "Inclusion gender", "Countries"}
)

EXPECTED_COLUMN_COUNT = len(CSV_COLUMNS)

#: Sanity assertion at import time: the tuple is the shape we measured.
assert EXPECTED_COLUMN_COUNT == 58, f"expected 58 columns, got {EXPECTED_COLUMN_COUNT}"
assert REQUIRED_COLUMNS <= set(CSV_COLUMNS), "REQUIRED_COLUMNS contains an unknown column"
