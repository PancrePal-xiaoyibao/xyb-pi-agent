"""The verified three-step request chain.

    GET  Default.aspx          -> harvest form state
    POST Default.aspx          -> search, harvest results-page form state
    POST Default.aspx          -> export CSV

Each step depends on state from the previous one. This is the only part of the
project carried over from prior verification; everything around it is new.

Measured facts this module encodes (docs/MEASUREMENTS.md):

* The search POST requires `__EVENTVALIDATION` and the cookie set from the GET.
  Omitting either produces an error page rather than results.
* The export POST must be built from the results page's own hidden inputs. It
  works with `Button7=Export to CSV`.
* A successful export is `200` + `application/vnd.ms-excel` +
  `attachment;filename=IctrpResults.csv`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from ..errors import ErrorCode, IctrpError
from . import htmlstate
from .export_guard import (
    CsvPayload,
    classify_export,
    classify_form_page,
    parse_reported_total,
)

BASE_URL = "https://trialsearch.who.int/Default.aspx"

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

#: The export button. Verified working.
EXPORT_CONTROL = "Button7"

#: The search submit button and text box on the form page.
SEARCH_BUTTON = "Button1"
SEARCH_TEXTBOX = "TextBox1"


def _check_present(state: htmlstate.FormState, *, step: str) -> None:
    missing = state.missing_state()
    if missing:
        raise IctrpError(
            ErrorCode.SESSION_FAILED,
            f"{step}: form state incomplete (missing {', '.join(missing)})",
            detail=(
                "The page did not carry the hidden inputs this step needs. "
                "Either the page was an error/interstitial, or the portal changed."
            ),
        )


@dataclass
class IctrpSession:
    """One logical search+export exchange.

    A fresh session per search keeps state handling simple and avoids reusing a
    `__VIEWSTATE` past its lifetime. Redirects are NOT followed automatically,
    because a `302` to `/NoAccess.aspx` is a failure we must classify rather
    than silently follow.
    """

    client: httpx.AsyncClient
    base_url: str = BASE_URL
    last_html: str = ""
    form_state: htmlstate.FormState | None = None
    results_state: htmlstate.FormState | None = None
    reported_total: int | None = None
    response_date: str | None = None
    steps: list[str] = field(default_factory=list)

    @classmethod
    def create(cls, *, timeout: float = 60.0) -> "IctrpSession":
        client = httpx.AsyncClient(
            headers=DEFAULT_HEADERS,
            timeout=timeout,
            follow_redirects=False,
        )
        return cls(client=client)

    async def __aenter__(self) -> "IctrpSession":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self.client.aclose()

    # ---- step 1 -----------------------------------------------------------

    async def load_form(self) -> htmlstate.FormState:
        try:
            response = await self.client.get(self.base_url)
        except httpx.HTTPError as exc:
            raise IctrpError(
                ErrorCode.UPSTREAM_ERROR,
                f"Could not reach the ICTRP search portal: {exc}",
                hint="Check network connectivity, then retry.",
            ) from exc

        html = classify_form_page(status=response.status_code, body=response.content)
        self.steps.append(f"GET {self.base_url} -> {response.status_code}")
        state = htmlstate.extract_form_state(html)
        _check_present(state, step="load_form")
        self.form_state = state
        self.last_html = html
        return state

    # ---- step 2 -----------------------------------------------------------

    async def search(self, keyword: str) -> str:
        if not keyword or not keyword.strip():
            raise IctrpError(
                ErrorCode.INVALID_ARGUMENT,
                "keyword must be a non-empty string",
            )
        if self.form_state is None:
            await self.load_form()
        assert self.form_state is not None

        body = self.form_state.merged_with(
            {SEARCH_TEXTBOX: keyword, SEARCH_BUTTON: "Search"}
        )
        try:
            response = await self.client.post(
                self.base_url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": self.base_url,
                },
            )
        except httpx.HTTPError as exc:
            raise IctrpError(
                ErrorCode.UPSTREAM_ERROR,
                f"Search request failed: {exc}",
            ) from exc

        location = response.headers.get("location")
        if location and "/noaccess.aspx" in location.lower():
            raise IctrpError(
                ErrorCode.UPSTREAM_CONTRACT_DRIFT,
                "Search POST was redirected to NoAccess.aspx",
                upstream_status=response.status_code,
                hint=(
                    "The search POST was rejected. Verify that __EVENTVALIDATION "
                    "and the GET-set cookies were replayed."
                ),
            )
        if response.status_code in (403, 405, 429, 503):
            raise IctrpError(
                ErrorCode.UPSTREAM_BLOCKED,
                f"Search was refused (HTTP {response.status_code})",
                upstream_status=response.status_code,
                hint="The portal blocked this request. This is not an empty result set.",
            )

        html = response.text
        self.steps.append(f"POST search {keyword!r} -> {response.status_code}")

        state = htmlstate.extract_form_state(html)
        if state.missing_state():
            raise IctrpError(
                ErrorCode.UPSTREAM_CONTRACT_DRIFT,
                "Results page did not carry WebForms state",
                upstream_status=response.status_code,
                hint=(
                    "The search did not produce a results page. The response may be "
                    "an error page rather than a result set."
                ),
            )
        self.results_state = state
        self.last_html = html
        self.reported_total = parse_reported_total(html)
        return html

    # ---- step 3 -----------------------------------------------------------

    async def export_csv(self) -> CsvPayload:
        if self.results_state is None:
            raise IctrpError(
                ErrorCode.SESSION_FAILED,
                "export_csv called before a successful search",
            )

        body = htmlstate.build_export_body(self.last_html, export_control=EXPORT_CONTROL)
        # Fail loudly here rather than upstream, so the measured 302 failure mode
        # can never be reintroduced silently.
        htmlstate.assert_export_body_excludes_search_controls(body)

        try:
            response = await self.client.post(
                self.base_url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": self.base_url,
                },
            )
        except httpx.HTTPError as exc:
            raise IctrpError(
                ErrorCode.UPSTREAM_ERROR,
                f"Export request failed: {exc}",
            ) from exc

        self.steps.append(f"POST export -> {response.status_code}")
        self.response_date = response.headers.get("date")

        return classify_export(
            status=response.status_code,
            content_type=response.headers.get("content-type"),
            content_disposition=response.headers.get("content-disposition"),
            body=response.content,
            location=response.headers.get("location"),
            reported_total=self.reported_total,
        )

    def provenance_steps(self) -> list[str]:
        return list(self.steps)


async def run_chain(keyword: str, *, timeout: float = 120.0) -> tuple[CsvPayload, IctrpSession]:
    """Run the full chain and return the payload plus the session for provenance."""
    session = IctrpSession.create(timeout=timeout)
    await session.load_form()
    await session.search(keyword)
    payload = await session.export_csv()
    return payload, session
