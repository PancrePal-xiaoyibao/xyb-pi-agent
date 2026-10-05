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

import asyncio
import os
import random
from collections.abc import Awaitable, Callable
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


#: The portal's search POST intermittently stalls past a minute. Measured: a
#: `YL201` search returned `httpx.ReadTimeout` at a 60s budget while a plain
#: `GET /` on the same host answered HTTP 200 in 1.4s, so the stall is in the
#: POST chain rather than in the host being down. Widening the budget is the
#: cheap half of the fix; see `retry` for the half that actually recovers.
DEFAULT_TIMEOUT_SECONDS = 120.0
ENV_TIMEOUT = "ICTRP_TIMEOUT"

#: How many times a single step is attempted before its failure is surfaced.
#: Three is enough to ride out a transient stall without turning a genuine
#: outage into a multi-minute hang.
DEFAULT_ATTEMPTS = 3
ENV_ATTEMPTS = "ICTRP_ATTEMPTS"

#: Base delay between attempts, doubled each time and jittered. Jitter matters
#: because a client that retries on a fixed cadence can stay in lockstep with
#: whatever is stalling.
DEFAULT_BACKOFF_SECONDS = 2.0
ENV_BACKOFF = "ICTRP_BACKOFF_SECONDS"

#: The hard ceiling on a single backoff sleep, so a long search cannot turn
#: into an unbounded wait.
MAX_BACKOFF_SECONDS = 30.0

#: Transport failures and transient portal hiccups. A 429/503 raised as
#: UPSTREAM_BLOCKED is deliberately excluded: retrying into an active refusal
#: makes the block worse and hides the diagnosis.
RETRYABLE_CODES: frozenset = frozenset(
    {ErrorCode.UPSTREAM_ERROR, ErrorCode.SESSION_FAILED}
)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw:
        try:
            value = float(raw)
        except ValueError:
            return default
        return value if value > 0 else default
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw:
        try:
            value = int(raw)
        except ValueError:
            return default
        return value if value > 0 else default
    return default


def _describe(exc: httpx.HTTPError) -> str:
    """Text for a transport error that may legitimately be empty.

    `httpx.ReadTimeout` stringifies to an empty message, which is how a real
    failure reached a user as `Search request failed: ` with nothing after the
    colon. Name the class when there is no text, so the message is never blank.
    """
    text = str(exc).strip()
    if text:
        return text
    return f"{type(exc).__name__} (no message)"


def timeout_seconds() -> float:
    """Per-request timeout, overridable for slow or poor links."""
    return _env_float(ENV_TIMEOUT, DEFAULT_TIMEOUT_SECONDS)


def max_attempts() -> int:
    """Attempts per step, so a transient stall is ridden out rather than raised."""
    return _env_int(ENV_ATTEMPTS, DEFAULT_ATTEMPTS)


def backoff_seconds() -> float:
    return _env_float(ENV_BACKOFF, DEFAULT_BACKOFF_SECONDS)


def _sleep_for(attempt: int) -> float:
    """Exponential backoff with jitter, capped.

    `attempt` is 1-based: the first retry waits ~base, the second ~2x base.
    """
    delay = backoff_seconds() * (2 ** (attempt - 1))
    delay = min(delay, MAX_BACKOFF_SECONDS)
    return random.uniform(delay * 0.5, delay)


async def retry(
    step: str,
    op: Callable[[], Awaitable[object]],
    *,
    attempts: int | None = None,
    sleeper: Callable[[float], Awaitable[None]] | None = None,
) -> object:
    """Run `op`, retrying only failures that a retry could plausibly fix.

    Non-retryable codes propagate on the first attempt. A refusal is
    information -- the caller needs to see "blocked", not "slow" -- and
    retrying it would both waste the budget and delay the diagnosis.
    """
    total = attempts if attempts is not None else max_attempts()
    sleep = sleeper or asyncio.sleep
    last: IctrpError | None = None

    for index in range(1, total + 1):
        try:
            return await op()
        except IctrpError as exc:
            if exc.code not in RETRYABLE_CODES:
                raise
            last = exc
            if index == total:
                break
            await sleep(_sleep_for(index))

    assert last is not None
    # The per-attempt hint ("then retry") is wrong by the time we get here: we
    # have already retried. Speak to what the caller can still do.
    hint = (
        f"Already retried {total} time(s) with backoff; every attempt failed. "
        f"Raise {ENV_TIMEOUT} (currently {timeout_seconds():g}s) to give each "
        f"attempt longer, or retry later -- the portal was answering plain GETs "
        f"while this step stalled."
    )
    raise IctrpError(
        last.code,
        f"{step}: failed after {total} attempt(s) -- {last.message}",
        upstream_status=last.upstream_status,
        upstream_content_type=last.upstream_content_type,
        upstream_body_excerpt=last.upstream_body_excerpt,
        hint=hint,
        detail=f"Retryable failure, exhausted {total} attempts: {last.detail or ''}".strip(),
    ) from last


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
    def create(cls, *, timeout: float | None = None) -> "IctrpSession":
        # 60s was measured to be too tight: the search POST stalls past it while
        # the host is answering GETs in ~1.4s. Callers that pass nothing get the
        # current default; callers that pass a value still get that value.
        client = httpx.AsyncClient(
            headers=DEFAULT_HEADERS,
            timeout=timeout if timeout is not None else timeout_seconds(),
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
        async def attempt_get():
            try:
                return await self.client.get(self.base_url)
            except httpx.HTTPError as exc:
                raise IctrpError(
                    ErrorCode.UPSTREAM_ERROR,
                    f"Could not reach the ICTRP search portal: {_describe(exc)}",
                    hint="Check network connectivity, then retry.",
                ) from exc

        response = await retry("load_form", attempt_get)
        assert isinstance(response, httpx.Response)

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

        async def attempt_post():
            try:
                return await self.client.post(
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
                    f"Search request failed: {_describe(exc)}",
                ) from exc

        response = await retry(f"search {keyword!r}", attempt_post)
        assert isinstance(response, httpx.Response)

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

        async def attempt_export():
            try:
                return await self.client.post(
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
                    f"Export request failed: {_describe(exc)}",
                ) from exc

        response = await retry("export_csv", attempt_export)
        assert isinstance(response, httpx.Response)

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


async def run_chain(
    keyword: str, *, timeout: float | None = None
) -> tuple[CsvPayload, IctrpSession]:
    """Run the full chain and return the payload plus the session for provenance."""
    session = IctrpSession.create(timeout=timeout)
    await session.load_form()
    await session.search(keyword)
    payload = await session.export_csv()
    return payload, session
