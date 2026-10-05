"""HTML form-state extraction.

The portal is ASP.NET WebForms. Every step of the chain depends on hidden inputs
carried forward from the previous response, so extraction has to be exact and
lossless -- a dropped field produces a 302 to NoAccess.aspx, which is
indistinguishable from a block unless you check the redirect target.

The extraction is deliberately dumb (regex over input tags) rather than
DOM-based, because the pages mix well-formed and sloppy markup and we only ever
need attributed name/value pairs.
"""

from __future__ import annotations

import html as _html
import re
from dataclasses import dataclass

#: Inputs that carry WebForms state and must be replayed on the next POST.
STATE_FIELDS: tuple[str, ...] = (
    "__VIEWSTATE",
    "__VIEWSTATEGENERATOR",
    "__VIEWSTATEENCRYPTED",
    "__EVENTVALIDATION",
    "__EVENTTARGET",
    "__EVENTARGUMENT",
    "__LASTFOCUS",
    "ToolkitScriptManager_HiddenField",
)

_INPUT_RE = re.compile(r"<input\b[^>]*>", re.I)
_ATTR_RE = re.compile(r"""([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class FormState:
    """Hidden inputs harvested from one page, ready to replay."""

    fields: dict[str, str]

    def merged_with(self, overrides: dict[str, str]) -> dict[str, str]:
        """Return the state fields plus caller-supplied control values."""
        out = dict(self.fields)
        out.update(overrides)
        return out

    def has(self, name: str) -> bool:
        return name in self.fields

    def missing_state(self) -> list[str]:
        """State fields we expect on a form page but did not find."""
        required = ("__VIEWSTATE", "__EVENTVALIDATION")
        return [f for f in required if f not in self.fields]


def _attrs(tag: str) -> dict[str, str]:
    got: dict[str, str] = {}
    for m in _ATTR_RE.finditer(tag):
        name = m.group(1).lower()
        value = m.group(2) if m.group(2) is not None else (
            m.group(3) if m.group(3) is not None else (m.group(4) or "")
        )
        got[name] = _html.unescape(value)
    return got


def extract_inputs(html: str) -> dict[str, str]:
    """Return every named input's value from a page.

    Includes buttons and text boxes, because the export step needs to know which
    controls exist -- notably to *exclude* controls that the results page does
    not carry.
    """
    found: dict[str, str] = {}
    for tag in _INPUT_RE.finditer(html):
        attrs = _attrs(tag.group(0))
        name = attrs.get("name")
        if not name:
            continue
        found[name] = attrs.get("value", "")
    return found


def extract_form_state(html: str) -> FormState:
    """Extract just the WebForms state fields."""
    all_inputs = extract_inputs(html)
    return FormState({k: v for k, v in all_inputs.items() if k in STATE_FIELDS})


def extract_select_options(html: str, select_name: str) -> list[tuple[str, str]]:
    """Return (value, label) pairs for a named <select>."""
    pattern = re.compile(
        r"<select\b[^>]*\bname\s*=\s*[\"']?" + re.escape(select_name) + r"[\"']?[^>]*>(.*?)</select>",
        re.I | re.S,
    )
    match = pattern.search(html)
    if not match:
        return []
    options: list[tuple[str, str]] = []
    for opt in re.finditer(r"<option\b([^>]*)>(.*?)</option>", match.group(1), re.I | re.S):
        attrs = _attrs(opt.group(1))
        label = _WS_RE.sub(" ", _TAG_RE.sub("", opt.group(2))).strip()
        options.append((_html.unescape(attrs.get("value", "")), label))
    return options


def text_of(html: str) -> str:
    """Collapse a fragment to plain text."""
    return _WS_RE.sub(" ", _TAG_RE.sub(" ", html)).strip()


def build_export_body(results_html: str, *, export_control: str = "Button7") -> dict[str, str]:
    """Build the export POST body from a results page.

    CRITICAL: the body is built ONLY from fields the results page actually
    carries, plus the export button. The search controls (`TextBox1`, `Button1`)
    are deliberately NOT sent, even when present. Measured: including controls
    that the results page does not carry makes the portal answer `302 Found` to
    `/NoAccess.aspx?aspxerrorpath=/Default.aspx`.

    The caller is responsible for verifying the search controls are absent via
    `assert_export_body_excludes_search_controls`.
    """
    state = extract_form_state(results_html)
    body = dict(state.fields)
    body[export_control] = "Export to CSV"
    return body


def assert_export_body_excludes_search_controls(body: dict[str, str]) -> None:
    """Guard against reintroducing the measured 302-to-NoAccess failure.

    `TextBox1`/`Button1` are search-form controls. Sending them on the export
    POST is the specific mistake that produced the measured error redirect.
    """
    for forbidden in ("TextBox1", "Button1"):
        if forbidden in body:
            raise AssertionError(
                f"export body must not contain search control {forbidden!r}; "
                "including it produces a 302 to /NoAccess.aspx"
            )
