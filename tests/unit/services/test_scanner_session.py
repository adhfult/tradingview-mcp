"""Logged-in scanner: session cookies, cache split by auth, direct callers, freshness roll-up.

Hermetic: every scanner query is a fake; nothing touches the network.
"""
from __future__ import annotations

import logging
import sys
from unittest import mock

import pandas as pd
import pytest

from tradingview_mcp.core.services import freshness
from tradingview_mcp.core.services import screener_provider as sp
from tradingview_mcp.core.services import futures_service, stock_screener_service

SECRET_ID = "SECRET-ID-9f3a"
SECRET_SIGN = "SECRET-SIGN-7c1d"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """No .env cookies, fresh cache, no retry sleeps, no cooldown."""
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", "")
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "")
    monkeypatch.delenv("TRADINGVIEW_MCP_SCANNER_USE_SESSION", raising=False)
    monkeypatch.setenv("TRADINGVIEW_MCP_RETRY_DELAYS", "0.01,0.02")
    monkeypatch.setenv("TRADINGVIEW_MCP_RETRY_JITTER", "0")
    monkeypatch.setenv("TRADINGVIEW_MCP_FAILURE_COOLDOWN_S", "0")
    monkeypatch.setenv("TRADINGVIEW_MCP_CACHE_TTL", "60")
    with sp._SCREENER_CACHE_LOCK:
        sp._SCREENER_CACHE.clear()
    with sp._TA_FAILURE_LOCK:
        sp._LAST_TA_FAILURE_TS = 0.0
    yield
    with sp._SCREENER_CACHE_LOCK:
        sp._SCREENER_CACHE.clear()


def _set_session(monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", SECRET_ID)
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", SECRET_SIGN)


class RecordingQuery:
    """Fake Query: records the kwargs of each get_scanner_data call."""

    def __init__(self, result=(1, "df"), fail_times=0):
        self.result = result
        self.fail_times = fail_times
        self.kwargs: list[dict] = []

    def get_scanner_data(self, **kwargs):
        self.kwargs.append(kwargs)
        if self.fail_times > 0:
            self.fail_times -= 1
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self.result


def _collect(fn, *args, **kwargs):
    records, token = freshness.start_collection()
    try:
        out = fn(*args, **kwargs)
    finally:
        freshness.stop_collection(token)
    return out, list(records)


# ── session_cookies ─────────────────────────────────────────────────────────

def test_cookies_when_both_set(monkeypatch):
    _set_session(monkeypatch)
    assert sp.session_cookies() == {"sessionid": SECRET_ID, "sessionid_sign": SECRET_SIGN}


@pytest.mark.parametrize("missing", ["TRADINGVIEW_SESSION_ID", "TRADINGVIEW_SESSION_SIGN"])
def test_no_cookies_when_one_is_missing(monkeypatch, missing):
    _set_session(monkeypatch)
    monkeypatch.setenv(missing, "")
    assert sp.session_cookies() is None


def test_no_cookies_when_unset():
    assert sp.session_cookies() is None


def test_opt_out_turns_session_off(monkeypatch):
    _set_session(monkeypatch)
    monkeypatch.setenv("TRADINGVIEW_MCP_SCANNER_USE_SESSION", "0")
    assert sp.session_cookies() is None


def test_opt_in_value_other_than_zero_keeps_session(monkeypatch):
    _set_session(monkeypatch)
    monkeypatch.setenv("TRADINGVIEW_MCP_SCANNER_USE_SESSION", "1")
    assert sp.session_cookies() is not None


def test_cookie_values_are_never_logged_or_printed(monkeypatch, capsys, caplog):
    _set_session(monkeypatch)
    with caplog.at_level(logging.DEBUG):
        sp.session_cookies()
        q = RecordingQuery()
        sp._scan_with_retry(q)
        sp._scan_with_retry(RecordingQuery(fail_times=1))
    captured = capsys.readouterr()
    for text in (captured.out, captured.err, caplog.text):
        assert SECRET_ID not in text and SECRET_SIGN not in text


# ── _scan_with_retry ────────────────────────────────────────────────────────

def test_scan_with_retry_passes_session_cookies_when_configured(monkeypatch):
    _set_session(monkeypatch)
    q = RecordingQuery()
    _, recs = _collect(sp._scan_with_retry, q)
    assert q.kwargs == [{"cookies": {"sessionid": SECRET_ID, "sessionid_sign": SECRET_SIGN}}]
    assert recs[0]["auth"] == "session"


def test_scan_with_retry_anonymous_passes_none(monkeypatch):
    q = RecordingQuery()
    _, recs = _collect(sp._scan_with_retry, q)
    assert q.kwargs == [{"cookies": None}]
    assert recs[0]["auth"] == "anonymous"


def test_explicit_cookies_argument_is_kept_as_given(monkeypatch):
    q = RecordingQuery()
    explicit = {"sessionid": "explicit-id", "sessionid_sign": "explicit-sign"}
    _, recs = _collect(sp._scan_with_retry, q, cookies=explicit)
    assert q.kwargs == [{"cookies": explicit}]
    assert recs[0]["auth"] == "session"


def test_cache_is_split_by_auth(monkeypatch):
    """An anonymous fallback must never serve a payload cached under the session."""
    base = ("indicators_v1", "EGX", ("EGX:ASCM",), "1D", None)
    _set_session(monkeypatch)
    out, _ = _collect(sp._scan_with_retry, RecordingQuery(result=(1, "session_df")), cache_key=base)
    assert out == (1, "session_df")

    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", "")
    monkeypatch.setenv("TRADINGVIEW_MCP_RETRY_DELAYS", "0.01")
    with pytest.raises(RuntimeError):
        sp._scan_with_retry(RecordingQuery(fail_times=99), cache_key=base)


def test_session_stale_fallback_serves_the_session_payload(monkeypatch):
    base = ("indicators_v1", "EGX", ("EGX:ASCM",), "1D", None)
    _set_session(monkeypatch)
    sp._scan_with_retry(RecordingQuery(result=(1, "session_df")), cache_key=base)
    monkeypatch.setenv("TRADINGVIEW_MCP_CACHE_TTL", "0")
    out, recs = _collect(sp._scan_with_retry, RecordingQuery(fail_times=99), cache_key=base)
    assert out == (1, "session_df")
    assert recs[0]["stale"] is True and recs[0]["auth"] == "session"


# ── direct callers: futures and stock screener ──────────────────────────────

def test_scanner_get_data_adds_cookies_only_when_present(monkeypatch):
    q = RecordingQuery()
    _, recs = _collect(sp.scanner_get_data, q, timeout=20)
    assert q.kwargs == [{"timeout": 20}]
    assert recs[0]["source"] == "tradingview_scanner" and recs[0]["auth"] == "anonymous"

    _set_session(monkeypatch)
    q = RecordingQuery()
    _, recs = _collect(sp.scanner_get_data, q, timeout=20)
    assert q.kwargs == [{"timeout": 20, "cookies": {"sessionid": SECRET_ID, "sessionid_sign": SECRET_SIGN}}]
    assert recs[0]["auth"] == "session"


def test_scanner_get_data_records_nothing_on_failure():
    q = RecordingQuery(fail_times=1)
    records, token = freshness.start_collection()
    try:
        with pytest.raises(ValueError):
            sp.scanner_get_data(q, timeout=20)
    finally:
        freshness.stop_collection(token)
    assert records == []


def test_futures_snapshot_passes_cookies_only_when_present(monkeypatch):
    fake = RecordingQuery(result=(1, pd.DataFrame([{"name": "ES1!"}])))
    with mock.patch.object(futures_service, "_tickers_query", return_value=fake):
        out, recs = _collect(futures_service.get_futures_category_snapshot, "equity_index")
    assert out["returned"] == 1
    assert fake.kwargs == [{"timeout": futures_service._SCAN_TIMEOUT_S}]
    assert recs[0]["source"] == "tradingview_scanner" and recs[0]["auth"] == "anonymous"

    _set_session(monkeypatch)
    fake = RecordingQuery(result=(1, pd.DataFrame([{"name": "ES1!"}])))
    with mock.patch.object(futures_service, "_tickers_query", return_value=fake):
        _, recs = _collect(futures_service.get_futures_category_snapshot, "equity_index")
    assert "cookies" in fake.kwargs[0]
    assert recs[0]["auth"] == "session"


def test_stock_prices_passes_cookies_only_when_present(monkeypatch):
    class FakeQuery:
        last = None

        def __init__(self):
            self.kwargs = []
            FakeQuery.last = self

        def set_tickers(self, *_):
            return self

        def select(self, *_):
            return self

        def limit(self, *_):
            return self

        def get_scanner_data(self, **kwargs):
            self.kwargs.append(kwargs)
            return (0, pd.DataFrame([]))

    with mock.patch.object(stock_screener_service, "Query", FakeQuery):
        out, recs = _collect(stock_screener_service.fetch_stock_prices, "NASDAQ:NVDA")
    assert out["not_found"] == ["NASDAQ:NVDA"]
    assert FakeQuery.last.kwargs == [{"timeout": 20}]
    assert recs[0]["auth"] == "anonymous"

    _set_session(monkeypatch)
    with mock.patch.object(stock_screener_service, "Query", FakeQuery):
        _, recs = _collect(stock_screener_service.fetch_stock_prices, "NASDAQ:NVDA")
    assert "cookies" in FakeQuery.last.kwargs[0]
    assert recs[0]["auth"] == "session"


# ── tradingview_ta stays anonymous and is named correctly ───────────────────

def test_ta_source_name_and_anonymous_even_with_session(monkeypatch):
    _set_session(monkeypatch)
    module = mock.MagicMock()
    module.get_multiple_analysis = lambda **kwargs: {"EGX:ASCM": "ok"}
    monkeypatch.setitem(sys.modules, "tradingview_ta", module)
    _, recs = _collect(sp.resilient_get_multiple_analysis, "egypt", "1D", ["EGX:ASCM"])
    assert recs[0]["source"] == "tradingview_ta"
    assert recs[0]["auth"] == "anonymous"


# ── freshness: auth over TradingView sources only ───────────────────────────

NOW = 1_800_000_000.0


def _rec(source, auth, fetched_at=NOW):
    return {"source": source, "fetched_at": fetched_at, "cache_hit": False, "stale": False, "auth": auth}


def test_yahoo_anonymous_does_not_make_a_session_result_mixed():
    out = freshness.summarize([_rec("tradingview_scanner", "session"), _rec("yahoo", "anonymous")], now=NOW)
    assert out["auth"] == "session"
    assert out["auth_by_source"] == {"tradingview_scanner": "session", "yahoo": "anonymous"}


def test_mixed_inside_tradingview_is_mixed_and_per_source_is_too():
    out = freshness.summarize([
        _rec("tradingview_scanner", "session"),
        _rec("tradingview_scanner", "anonymous"),
        _rec("tradingview_bridge", "session"),
    ], now=NOW)
    assert out["auth"] == "mixed"
    assert out["auth_by_source"] == {"tradingview_scanner": "mixed", "tradingview_bridge": "session"}


def test_no_tradingview_source_is_anonymous():
    out = freshness.summarize([_rec("yahoo", "anonymous")], now=NOW)
    assert out["auth"] == "anonymous"
    assert out["auth_by_source"] == {"yahoo": "anonymous"}


def test_session_and_anonymous_tradingview_sources_roll_up_to_mixed():
    out = freshness.summarize([_rec("tradingview_bridge", "session"), _rec("tradingview_ta", "anonymous")], now=NOW)
    assert out["auth"] == "mixed"
    assert out["auth_by_source"]["tradingview_bridge"] == "session"
    assert out["auth_by_source"]["tradingview_ta"] == "anonymous"
