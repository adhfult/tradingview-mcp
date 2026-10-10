"""Tests for the Python client of the Node bridge.

Every test runs against tests/unit/fixtures/fake_bridge.py (or a tiny inline
Python command). Node is never run and nothing touches the network.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from tradingview_mcp.core.errors import ErrorCode, ScreenerServiceError, is_error
from tradingview_mcp.core.services import tv_bridge_client as tvb
from tradingview_mcp.core.services.tv_bridge_client import SETUP_HINT, BridgeClient, BridgeError
from tradingview_mcp.core.utils.validators import to_tv_timeframe

FAKE_BRIDGE = Path(__file__).resolve().parents[1] / "fixtures" / "fake_bridge.py"
FAKE_SESSION = "fake-session-123"
FAKE_TOKEN = "bot123456:ABCdef"

_CONTROLLED_ENV = (
    "TRADINGVIEW_SESSION_ID",
    "TRADINGVIEW_SESSION_SIGN",
    "TRADINGVIEW_BRIDGE_NODE",
    "TRADINGVIEW_BRIDGE_PATH",
    "TRADINGVIEW_BRIDGE_MAX_INFLIGHT",
    "TELEGRAM_BOT_TOKEN",
    "SOME_RANDOM_SECRET",
)


@pytest.fixture(autouse=True)
def _controlled_env(monkeypatch):
    """Start every test with the bridge-related variables absent."""
    for name in _CONTROLLED_ENV:
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)


@pytest.fixture
def make_client():
    clients: list[BridgeClient] = []

    def _make(mode: str = "default", **kwargs) -> BridgeClient:
        client = BridgeClient(command=[sys.executable, str(FAKE_BRIDGE), mode], **kwargs)
        clients.append(client)
        return client

    yield _make
    for client in clients:
        client.close()


@pytest.fixture
def client(make_client):
    return make_client()


def _wait_until(predicate, timeout_s: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


# ---------------------------------------------------------------------------
# protocol round trips
# ---------------------------------------------------------------------------


def test_health_round_trip(client):
    assert client.call("health") == {
        "ok": True,
        "libVersion": "4.0.0",
        "node": "fake",
        "hasCredentials": False,
    }


def test_concurrent_calls_are_matched_by_id(client):
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(client.call, "sleep", {"s": 0.3})
        fast = pool.submit(client.call, "echo", {"marker": "fast"})
        assert fast.result(timeout=10) == {"marker": "fast"}
        assert slow.result(timeout=10) == {"slept": 0.3}


def test_timeout_raises_and_the_bridge_keeps_working(client):
    with pytest.raises(BridgeError) as exc:
        client.call("sleep", {"s": 2}, timeout_s=0.3)
    assert exc.value.code == "TIMEOUT"

    assert client.call("echo", {"after": True}) == {"after": True}


def test_acall_returns_the_result(client):
    assert asyncio.run(client.acall("echo", {"via": "async"})) == {"via": "async"}


def test_unknown_method_is_invalid_parameter(client):
    with pytest.raises(BridgeError) as exc:
        client.call("no_such_method")
    assert exc.value.code == "INVALID_PARAMETER"


def test_bridge_error_reply_keeps_its_code(client):
    with pytest.raises(BridgeError) as exc:
        client.call("fail", {"code": "RATE_LIMITED", "message": "slow down"})
    assert exc.value.code == "RATE_LIMITED"
    assert exc.value.to_envelope()["error"]["code"] == "UPSTREAM_RATE_LIMIT"


# ---------------------------------------------------------------------------
# error table -> envelopes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bridge_code, expected, retryable",
    [
        ("SYMBOL_NOT_FOUND", ErrorCode.SYMBOL_NOT_FOUND, None),
        ("TIMEOUT", ErrorCode.UPSTREAM_TIMEOUT, True),
        ("RATE_LIMITED", ErrorCode.UPSTREAM_RATE_LIMIT, True),
        ("AUTH_FAILED", ErrorCode.AUTH_FAILED, None),
        ("PERMISSION_OR_SERIES", ErrorCode.PERMISSION_DENIED, None),
        ("INVALID_PARAMETER", ErrorCode.INVALID_PARAMETER, None),
        ("NO_DATA", ErrorCode.NO_DATA, None),
        ("NOT_CONFIGURED", ErrorCode.NOT_CONFIGURED, None),
        ("UPSTREAM_UNAVAILABLE", ErrorCode.UPSTREAM_ERROR, True),
        ("SOMETHING_NEW", ErrorCode.UPSTREAM_ERROR, True),
    ],
)
def test_error_table_maps_to_envelope_codes(bridge_code, expected, retryable):
    env = BridgeError(bridge_code, "bridge said no").to_envelope()

    assert is_error(env)
    assert env["error"]["code"] == expected.value
    if retryable is None:
        assert "retryable" not in env["error"]
    else:
        assert env["error"]["retryable"] is retryable


def test_auth_failed_message_says_where_to_fix_it():
    message = BridgeError("AUTH_FAILED", "raw text").to_envelope()["error"]["message"]
    assert message == (
        "TradingView rejected the session cookies; copy fresh sessionid / sessionid_sign into .env"
    )


def test_permission_message_mentions_the_plan_limit():
    message = BridgeError("PERMISSION_OR_SERIES", "series refused").to_envelope()["error"]["message"]
    assert "series refused" in message
    assert "plan limit" in message


def test_not_configured_envelope_carries_the_setup_hint():
    err = BridgeError("NOT_CONFIGURED", "Node.js was not found").to_envelope()["error"]
    assert err["message"] == "Node.js was not found"
    assert err["setup"] == SETUP_HINT


# ---------------------------------------------------------------------------
# crashes, restarts and cool-down
# ---------------------------------------------------------------------------


def test_crash_raises_and_the_next_call_restarts_the_bridge(client):
    with pytest.raises(BridgeError) as exc:
        client.call("crash")
    assert exc.value.code == "UPSTREAM_UNAVAILABLE"

    assert client.call("echo", {"back": 1}) == {"back": 1}


def test_repeated_crashes_cool_down_without_starting_a_process(make_client, monkeypatch):
    client = make_client()
    for _ in range(tvb._FAIL_THRESHOLD):
        with pytest.raises(BridgeError) as exc:
            client.call("crash")
        assert exc.value.code == "UPSTREAM_UNAVAILABLE"

    starts = []
    real_popen = tvb.subprocess.Popen

    def counting_popen(*args, **kwargs):
        starts.append(args)
        return real_popen(*args, **kwargs)

    monkeypatch.setattr(tvb.subprocess, "Popen", counting_popen)

    with pytest.raises(BridgeError) as exc:
        client.call("echo", {})
    assert exc.value.code == "UPSTREAM_UNAVAILABLE"
    assert "cooling down" in exc.value.message
    assert starts == []

    monkeypatch.setattr(tvb, "_COOLDOWN_S", 0.0)
    assert client.call("echo", {"ok": 1}) == {"ok": 1}
    assert len(starts) == 1


def _trip_cooldown(client) -> None:
    for _ in range(tvb._FAIL_THRESHOLD):
        with pytest.raises(BridgeError):
            client.call("crash")


def test_health_is_exempt_from_the_cooldown(make_client):
    client = make_client()
    _trip_cooldown(client)
    assert client.cooling_down() is True

    with pytest.raises(BridgeError) as exc:
        client.call("echo", {})
    assert "cooling down" in exc.value.message

    reply = client.call("health")
    assert reply["ok"] is True


def test_cooling_down_and_remaining_seconds_are_exposed(make_client, monkeypatch):
    client = make_client()
    assert client.cooling_down() is False
    assert client.cooldown_remaining_s() == 0.0

    _trip_cooldown(client)
    assert client.cooling_down() is True
    assert 0.0 < client.cooldown_remaining_s() <= tvb._COOLDOWN_S

    monkeypatch.setattr(tvb, "_COOLDOWN_S", 0.0)
    assert client.cooling_down() is False
    assert client.cooldown_remaining_s() == 0.0


def test_a_good_health_reply_ends_the_cooldown(make_client):
    client = make_client()
    _trip_cooldown(client)
    assert client.cooling_down() is True

    client.call("health")

    assert client.cooling_down() is False
    assert client.call("echo", {"ok": 1}) == {"ok": 1}


def test_is_available_is_false_while_cooling_down_and_never_cached_then(make_client, monkeypatch):
    client = make_client()
    assert client.is_available() is True  # now cached as True
    _trip_cooldown(client)

    assert client.is_available() is False

    monkeypatch.setattr(tvb, "_COOLDOWN_S", 0.0)
    assert client.is_available() is True


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------


def test_node_missing_from_path_is_reported(tmp_path, monkeypatch):
    # An empty PATH with no override: node cannot be found, and nothing is run.
    monkeypatch.setenv("PATH", str(tmp_path))

    reason = BridgeClient().check_configured()

    assert reason is not None and "Node.js was not found" in reason


def test_missing_node_is_not_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_BRIDGE_NODE", str(tmp_path / "no-such-node"))
    client = BridgeClient()

    with pytest.raises(BridgeError) as exc:
        client.call("health")

    assert exc.value.code == "NOT_CONFIGURED"
    assert exc.value.to_envelope()["error"]["setup"] == SETUP_HINT
    assert client.is_available() is False


@pytest.mark.parametrize(
    "major, script_present, modules_present, expected",
    [
        (18, True, True, "Node.js 20+"),
        (22, False, True, "bridge script not found"),
        (22, True, False, "dependencies are missing"),
        (22, True, True, None),
    ],
)
def test_check_configured_reports_the_first_problem(
    tmp_path, monkeypatch, major, script_present, modules_present, expected
):
    node = tmp_path / "fake-node"
    node.write_text("#!/bin/sh\n", encoding="utf-8")
    node.chmod(0o755)
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()
    script = bridge_dir / "server.mjs"
    if script_present:
        script.write_text("// fake bridge\n", encoding="utf-8")
    if modules_present:
        (bridge_dir / "node_modules" / "@mathieuc" / "tradingview").mkdir(parents=True)

    monkeypatch.setenv("TRADINGVIEW_BRIDGE_NODE", str(node))
    monkeypatch.setenv("TRADINGVIEW_BRIDGE_PATH", str(script))
    # The probe would run the fake node; answer it directly instead.
    monkeypatch.setattr(tvb, "_probe_node_major", lambda node_path, env: major)

    reason = BridgeClient().check_configured()

    if expected is None:
        assert reason is None
    else:
        assert reason is not None and expected in reason


def test_injected_command_skips_configuration_checks(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_BRIDGE_NODE", str(tmp_path / "no-such-node"))
    assert BridgeClient(command=[sys.executable, str(FAKE_BRIDGE), "default"]).check_configured() is None


def test_has_credentials_reports_presence_without_values(client, monkeypatch):
    assert client.has_credentials() is False

    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", FAKE_SESSION)
    assert client.has_credentials() is False

    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "fake-sign-456")
    assert client.has_credentials() is True


def test_is_available_is_true_when_health_answers_and_is_cached(client, monkeypatch):
    assert client.is_available() is True

    # Within the TTL the cached answer is used, so a broken config does not flip it.
    monkeypatch.setattr(client, "check_configured", lambda: "now broken")
    assert client.is_available() is True


def test_is_available_is_false_when_the_bridge_dies_at_once():
    dying = BridgeClient(command=[sys.executable, "-c", "import sys; sys.exit(1)"])
    try:
        assert dying.is_available() is False
    finally:
        dying.close()


def test_get_client_is_a_singleton_until_reset():
    tvb.reset_client_for_tests()
    try:
        first = tvb.get_client()
        assert tvb.get_client() is first
        tvb.reset_client_for_tests()
        assert tvb.get_client() is not first
    finally:
        tvb.reset_client_for_tests()


# ---------------------------------------------------------------------------
# redaction and environment
# ---------------------------------------------------------------------------


def test_stderr_lines_and_error_messages_are_redacted(make_client, monkeypatch, caplog):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", FAKE_SESSION)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", FAKE_TOKEN)
    caplog.set_level(logging.DEBUG, logger="tradingview_mcp.bridge")
    client = make_client()

    client.call("stderr", {"text": f"cookie {FAKE_SESSION} token {FAKE_TOKEN}"})
    assert _wait_until(lambda: any("[REDACTED]" in r.getMessage() for r in caplog.records))

    logged = "\n".join(r.getMessage() for r in caplog.records if r.name == "tradingview_mcp.bridge")
    assert "[REDACTED]" in logged
    assert FAKE_SESSION not in logged
    assert FAKE_TOKEN not in logged

    with pytest.raises(BridgeError) as exc:
        client.call("fail", {"code": "UPSTREAM_ERROR", "message": f"bad {FAKE_SESSION} sessionid=abc123xyz;"})
    assert FAKE_SESSION not in exc.value.message
    assert "abc123xyz" not in exc.value.message
    assert FAKE_SESSION not in repr(exc.value.to_envelope())


def _bridge_records(caplog):
    return [r for r in caplog.records if r.name == "tradingview_mcp.bridge"]


@pytest.mark.parametrize(
    "text",
    [
        "FATAL: something broke",
        "Uncaught exception in handler",
        "UnhandledPromiseRejection: nope",
        "bridge exiting now",
        "Error: boom",
    ],
)
def test_fatal_looking_stderr_lines_are_logged_at_warning(make_client, caplog, text):
    caplog.set_level(logging.DEBUG, logger="tradingview_mcp.bridge")
    client = make_client()

    client.call("stderr", {"text": text})
    assert _wait_until(lambda: any(text in r.getMessage() for r in _bridge_records(caplog)))

    record = next(r for r in _bridge_records(caplog) if text in r.getMessage())
    assert record.levelno == logging.WARNING


def test_ordinary_stderr_lines_stay_at_debug(make_client, caplog):
    caplog.set_level(logging.DEBUG, logger="tradingview_mcp.bridge")
    client = make_client()

    client.call("stderr", {"text": "connected to chart session"})
    assert _wait_until(lambda: any("connected to chart" in r.getMessage() for r in _bridge_records(caplog)))

    record = next(r for r in _bridge_records(caplog) if "connected to chart" in r.getMessage())
    assert record.levelno == logging.DEBUG


def test_warning_level_stderr_is_still_redacted(make_client, monkeypatch, caplog):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", FAKE_SESSION)
    caplog.set_level(logging.DEBUG, logger="tradingview_mcp.bridge")
    client = make_client()

    client.call("stderr", {"text": f"Fatal: bad cookie {FAKE_SESSION}"})
    assert _wait_until(lambda: any("Fatal" in r.getMessage() for r in _bridge_records(caplog)))

    record = next(r for r in _bridge_records(caplog) if "Fatal" in r.getMessage())
    assert record.levelno == logging.WARNING
    assert FAKE_SESSION not in caplog.text
    assert "[REDACTED]" in record.getMessage()


def test_unexpected_bridge_exit_is_logged_at_warning_with_the_exit_code(client, caplog):
    caplog.set_level(logging.DEBUG, logger="tradingview_mcp.bridge")

    with pytest.raises(BridgeError):
        client.call("crash")

    def exit_record():
        return next(
            (r for r in _bridge_records(caplog) if "exited unexpectedly" in r.getMessage()), None
        )

    assert _wait_until(lambda: exit_record() is not None)
    record = exit_record()
    assert record.levelno == logging.WARNING
    assert "exit code 1" in record.getMessage()


def test_close_does_not_log_an_unexpected_exit(client, caplog):
    caplog.set_level(logging.DEBUG, logger="tradingview_mcp.bridge")
    client.call("health")
    popen = client._proc.popen

    client.close()
    popen.wait(timeout=5)
    time.sleep(0.3)  # let the reader thread notice the exit

    assert not any("exited unexpectedly" in r.getMessage() for r in _bridge_records(caplog))


def test_child_process_gets_only_the_allowlisted_environment(make_client, monkeypatch):
    monkeypatch.setenv("SOME_RANDOM_SECRET", "x")
    monkeypatch.setenv("TRADINGVIEW_BRIDGE_MAX_INFLIGHT", "3")
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", FAKE_SESSION)
    client = make_client("env")

    keys = set(client.call("echo", {})["keys"])

    assert "SOME_RANDOM_SECRET" not in keys
    assert "TRADINGVIEW_BRIDGE_MAX_INFLIGHT" in keys
    assert "TRADINGVIEW_SESSION_ID" in keys
    assert "PATH" in keys


def test_injected_env_is_still_filtered_by_the_allowlist(make_client):
    client = make_client(
        "env",
        env={"PATH": "/usr/bin", "NOT_ALLOWED": "x", "HTTPS_PROXY": "http://proxy.invalid:8080"},
    )

    keys = set(client.call("echo", {})["keys"])

    assert "NOT_ALLOWED" not in keys
    assert "HTTPS_PROXY" in keys


def test_close_is_idempotent_and_stops_the_process(client):
    client.call("health")
    process = client._proc.popen

    client.close()
    assert process.poll() is not None

    client.close()


# ---------------------------------------------------------------------------
# to_tv_timeframe
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "timeframe, tv_code",
    [("5m", "5"), ("15m", "15"), ("1h", "60"), ("4h", "240"), ("1D", "D"), ("1W", "W"), ("1M", "M")],
)
def test_to_tv_timeframe_full_table(timeframe, tv_code):
    assert to_tv_timeframe(timeframe) == tv_code


@pytest.mark.parametrize(
    "alias, tv_code",
    [("1d", "D"), ("d", "D"), ("w", "W"), ("60", "60"), ("240", "240"), ("1440", "D")],
)
def test_to_tv_timeframe_normalises_aliases_first(alias, tv_code):
    assert to_tv_timeframe(alias) == tv_code


@pytest.mark.parametrize("bad", ["2h", "30", "bogus"])
def test_to_tv_timeframe_rejects_bad_input(bad):
    with pytest.raises(ScreenerServiceError) as exc:
        to_tv_timeframe(bad)
    assert exc.value.code == ErrorCode.INVALID_TIMEFRAME


def test_new_configuration_error_codes_have_stable_values():
    assert ErrorCode.NOT_CONFIGURED.value == "NOT_CONFIGURED"
    assert ErrorCode.AUTH_FAILED.value == "AUTH_FAILED"
    assert ErrorCode.PERMISSION_DENIED.value == "PERMISSION_DENIED"


# ---------------------------------------------------------------------------
# review additions (Sonnet): redaction parity with bridge/lib/redact.mjs
# ---------------------------------------------------------------------------

REDACT_MJS = Path(__file__).resolve().parents[3] / "bridge" / "lib" / "redact.mjs"

# Obviously fake, but with characters that change under URL-encoding and JSON-escaping.
_TRICKY = 'fake/sess+id=1 "q"\\z'


def _js_source() -> str:
    return REDACT_MJS.read_text(encoding="utf-8")


def test_secret_env_var_list_matches_the_bridge_redactor():
    import re

    block = re.search(r"SECRET_ENV_VARS = Object\.freeze\(\[(.*?)\]\)", _js_source(), re.S)
    assert block is not None
    assert tuple(re.findall(r"'([A-Z_]+)'", block.group(1))) == tvb._SECRET_ENV_VARS


def test_redaction_patterns_match_the_bridge_redactor():
    import re

    # Pattern literals in the JS PATTERNS table, e.g. [/regex/flags, 'replacement'],
    js_patterns = re.findall(r"^\s*\[/(.+)/([a-z]*), '([^']*)'\],$", _js_source(), re.M)
    assert len(js_patterns) == len(tvb._REDACT_PATTERNS)
    for (js_src, _flags, _repl), (py_re, _py_repl) in zip(js_patterns, tvb._REDACT_PATTERNS):
        assert py_re.pattern == js_src.replace("\\/", "/")


@pytest.mark.parametrize(
    "variant",
    [
        "raw",
        "url_encoded",
        "json_escaped",
    ],
)
def test_encoded_and_escaped_secret_variants_do_not_survive(monkeypatch, variant):
    import json
    import urllib.parse

    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", _TRICKY)
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "fake-sign-456")
    shown = {
        "raw": _TRICKY,
        "url_encoded": urllib.parse.quote(_TRICKY, safe=""),
        "json_escaped": json.dumps(_TRICKY)[1:-1],
    }[variant]

    out = tvb._redact(f"login failed for {shown} and fake-sign-456")

    assert shown not in out
    assert "fake-sign-456" not in out


def test_non_ascii_secret_survives_neither_escaped_nor_raw(monkeypatch):
    import json

    secret = "fake-sécret-日本"
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", secret)

    for shown in (secret, json.dumps(secret)[1:-1]):
        assert shown not in tvb._redact(f"token {shown} end")


@pytest.mark.parametrize(
    "text, leaked",
    [
        ("Cookie: sessionid=fake-cookie-1; sessionid_sign=fake-cookie-2", ("fake-cookie-1", "fake-cookie-2")),
        ('{"sessionid":"fake-cookie-3","other":1}', ("fake-cookie-3",)),
        ('{"sessionid_sign": "fake-cookie-4"}', ("fake-cookie-4",)),
        ("sessionid: fake-cookie-5", ("fake-cookie-5",)),
        ("'sessionid': 'fake-cookie-6'", ("fake-cookie-6",)),
        ("SessionID=fake-cookie-7", ("fake-cookie-7",)),
        (
            "auth eyJhbGciOiJub25lIn0.eyJmYWtlIjoxfQ.sigfake123 done",
            ("eyJhbGciOiJub25lIn0", "eyJmYWtlIjoxfQ", "sigfake123"),
        ),
        ("POST https://api.telegram.org/bot123456:ABCdef-ghi_jkl/send", ("123456:ABCdef-ghi_jkl",)),
        (
            "https://discord.com/api/webhooks/123456/fake-hook-token",
            ("123456/fake-hook-token", "fake-hook-token"),
        ),
        (
            "https://ptb.discordapp.com/api/webhooks/123456/fake-hook-token2",
            ("fake-hook-token2",),
        ),
        ("HTTPS://CANARY.DISCORD.COM/API/WEBHOOKS/1/FAKEHOOK", ("FAKEHOOK",)),
    ],
)
def test_secret_shaped_text_is_redacted_without_any_env(text, leaked):
    out = tvb._redact(text)

    for piece in leaked:
        assert piece not in out


def test_redaction_keeps_the_surrounding_text_readable():
    out = tvb._redact('{"sessionid":"fake-cookie-3","other":1}')

    assert out == '{"sessionid":"[REDACTED]","other":1}'


def test_every_configured_secret_variable_is_redacted(monkeypatch):
    for name in tvb._SECRET_ENV_VARS:
        monkeypatch.setenv(name, f"fake-value-for-{name.lower()}")

    text = " | ".join(f"fake-value-for-{name.lower()}" for name in tvb._SECRET_ENV_VARS)
    out = tvb._redact(text)

    assert "fake-value-for" not in out


def test_values_shorter_than_four_characters_are_left_alone(monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "ab")

    assert tvb._redact("chat ab here") == "chat ab here"


def test_bridge_error_never_carries_a_secret(monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", FAKE_SESSION)

    err = BridgeError("UPSTREAM_ERROR", f"boom {FAKE_SESSION}")

    assert FAKE_SESSION not in str(err)
    assert FAKE_SESSION not in err.message


def test_secret_in_a_bridge_error_reply_is_redacted_in_the_exception(make_client, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", _TRICKY)
    client = make_client()

    with pytest.raises(BridgeError) as exc:
        client.call("fail", {"code": "AUTH_ERROR", "message": f"rejected {_TRICKY}"})

    assert _TRICKY not in str(exc.value)
    assert _TRICKY not in repr(exc.value.to_envelope())


def test_non_string_error_message_from_the_bridge_is_handled(make_client):
    client = make_client()

    with pytest.raises(BridgeError) as exc:
        client.call("fail", {"code": "NO_DATA", "message": None})

    assert exc.value.code == "NO_DATA"
    assert exc.value.message == ""


# ---------------------------------------------------------------------------
# review additions: timeout alignment
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method, params, timeout_s, expected",
    [
        ("candles", {"timeoutMs": 30000}, 20.0, 40.0),  # 30 s + 5 s bridge grace + 5 s margin
        ("candles", {"timeoutMs": 1000}, 20.0, 20.0),  # the caller's larger value is kept
        ("candles", {"timeoutMs": 500}, 1.0, 11.0),  # bridge clamps up to 1 s
        ("candles", {"timeoutMs": 999999}, 20.0, 70.0),  # bridge clamps down to 60 s
        ("candles", {"timeoutMs": 15000}, 20.0, 25.0),
        ("candles", {}, 20.0, 25.0),  # bridge default is 15 s, so 20 s would race its deadline
        ("candles", None, 20.0, 25.0),
        ("quotes", {"symbols": ["X"]}, 20.0, 25.0),
        ("candles", {"timeoutMs": "30000"}, 20.0, 25.0),  # the bridge rejects non-numbers at once
        ("candles", {"timeoutMs": True}, 20.0, 25.0),
        ("candles", {"timeoutMs": float("nan")}, 20.0, 25.0),
        ("health", None, 20.0, 20.0),
        ("health", {}, 3.0, 3.0),
        ("sleep", {"s": 1}, 0.3, 0.3),
        ("sleep", {"s": 1, "timeoutMs": 2000}, 0.3, 12.0),
    ],
)
def test_effective_timeout_outwaits_the_bridge_deadline(method, params, timeout_s, expected):
    assert tvb._effective_timeout_s(method, params, timeout_s) == pytest.approx(expected)


def test_call_waits_for_the_bridge_when_timeout_ms_is_larger_than_timeout_s(client):
    # timeout_s alone would give up after 0.3 s; timeoutMs says the bridge may take longer.
    result = client.call("sleep", {"s": 0.8, "timeoutMs": 2000}, timeout_s=0.3)

    assert result == {"slept": 0.8}


def test_call_without_timeout_ms_still_honours_a_short_timeout(client):
    with pytest.raises(BridgeError) as exc:
        client.call("sleep", {"s": 2}, timeout_s=0.3)
    assert exc.value.code == "TIMEOUT"


# ---------------------------------------------------------------------------
# review additions: configuration reasons
# ---------------------------------------------------------------------------


def _fake_node(tmp_path, monkeypatch, major=22):
    node = tmp_path / "fake-node"
    node.write_text("#!/bin/sh\n", encoding="utf-8")
    node.chmod(0o755)
    monkeypatch.setenv("TRADINGVIEW_BRIDGE_NODE", str(node))
    monkeypatch.setattr(tvb, "_probe_node_major", lambda node_path, env: major)


def test_missing_default_script_points_to_the_path_override(tmp_path, monkeypatch):
    _fake_node(tmp_path, monkeypatch)
    missing = tmp_path / "site-packages" / "bridge" / "server.mjs"
    monkeypatch.setattr(tvb, "_DEFAULT_SCRIPT", missing)

    reason = BridgeClient().check_configured()

    assert reason is not None
    assert "TRADINGVIEW_BRIDGE_PATH" in reason
    assert str(missing) in reason


def test_missing_overridden_script_names_the_variable(tmp_path, monkeypatch):
    _fake_node(tmp_path, monkeypatch)
    missing = tmp_path / "elsewhere" / "server.mjs"
    monkeypatch.setenv("TRADINGVIEW_BRIDGE_PATH", str(missing))

    reason = BridgeClient().check_configured()

    assert reason is not None
    assert str(missing) in reason and "TRADINGVIEW_BRIDGE_PATH" in reason


def test_missing_default_script_makes_call_not_configured(tmp_path, monkeypatch):
    _fake_node(tmp_path, monkeypatch)
    monkeypatch.setattr(tvb, "_DEFAULT_SCRIPT", tmp_path / "nope" / "server.mjs")

    with pytest.raises(BridgeError) as exc:
        BridgeClient().call("health")

    assert exc.value.code == "NOT_CONFIGURED"
    assert "TRADINGVIEW_BRIDGE_PATH" in exc.value.to_envelope()["error"]["message"]


def test_failed_node_probe_is_retried_later(tmp_path, monkeypatch):
    node = tmp_path / "fake-node"
    node.write_text("#!/bin/sh\n", encoding="utf-8")
    node.chmod(0o755)
    monkeypatch.setenv("TRADINGVIEW_BRIDGE_NODE", str(node))
    answers = iter([None, 22])
    probes = []

    def probe(node_path, env):
        probes.append(node_path)
        return next(answers)

    monkeypatch.setattr(tvb, "_probe_node_major", probe)
    client = BridgeClient()

    first = client.check_configured()
    assert first is not None and "could not read the Node.js version" in first
    assert len(probes) == 1

    # Within the TTL a failed probe is not repeated on every call.
    client.check_configured()
    assert len(probes) == 1

    monkeypatch.setattr(tvb, "_AVAIL_TTL_S", 0.0)
    reason = client.check_configured()
    assert len(probes) == 2
    assert reason is None or "Node.js" not in reason


# ---------------------------------------------------------------------------
# review additions: stderr, concurrency, process death
# ---------------------------------------------------------------------------


def test_stderr_flood_does_not_deadlock_the_bridge(client):
    # Far more than a pipe buffer (64 KiB): only a continuously drained stderr survives it.
    assert client.call("flood", {"bytes": 2_000_000}, timeout_s=15) == {}
    assert client.call("echo", {"still": "alive"}) == {"still": "alive"}


def test_many_concurrent_calls_get_their_own_replies(client):
    def one(i):
        return client.call("echo", {"i": i, "pad": "x" * 2000})["i"]

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(one, range(200)))

    assert results == list(range(200))
    assert client._proc.pending == {}


def test_one_crash_with_calls_in_flight_fails_them_all_and_counts_once(client):
    with ThreadPoolExecutor(max_workers=4) as pool:
        sleepers = [pool.submit(client.call, "sleep", {"s": 30}) for _ in range(3)]
        assert _wait_until(lambda: client._proc is not None and len(client._proc.pending) == 3)
        crasher = pool.submit(client.call, "crash")

        for fut in [*sleepers, crasher]:
            with pytest.raises(BridgeError) as exc:
                fut.result(timeout=10)
            assert exc.value.code == "UPSTREAM_UNAVAILABLE"

    # Four orphaned requests are one process death: well below the cool-down threshold.
    assert client._fail_count == 1
    assert client.call("echo", {"back": True}) == {"back": True}


def test_bridge_killed_while_idle_is_restarted(client):
    client.call("health")
    first = client._proc.popen
    first.kill()
    first.wait()

    assert client.call("echo", {"again": 1}) == {"again": 1}
    assert client._proc.popen is not first


def test_pending_future_is_failed_when_the_process_dies_mid_call(client):
    import threading

    box = {}

    def slow():
        try:
            client.call("sleep", {"s": 30})
        except BridgeError as err:
            box["err"] = err

    worker = threading.Thread(target=slow)
    worker.start()
    assert _wait_until(lambda: client._proc is not None and len(client._proc.pending) == 1)
    client._proc.popen.kill()
    worker.join(timeout=10)

    assert not worker.is_alive()
    assert box["err"].code == "UPSTREAM_UNAVAILABLE"


def test_closing_during_a_call_does_not_count_as_a_failure(client):
    import threading

    box = {}

    def slow():
        try:
            client.call("sleep", {"s": 30})
        except BridgeError as err:
            box["err"] = err

    worker = threading.Thread(target=slow)
    worker.start()
    assert _wait_until(lambda: client._proc is not None and len(client._proc.pending) == 1)
    client.close()
    worker.join(timeout=10)

    assert box["err"].code == "UPSTREAM_UNAVAILABLE"
    assert client._fail_count == 0


def test_unparseable_and_id_less_lines_are_ignored(tmp_path):
    script = tmp_path / "noisy.py"
    script.write_text(
        "import sys, json\n"
        "for raw in sys.stdin:\n"
        "    req = json.loads(raw)\n"
        "    print('not json', flush=True)\n"
        "    print(json.dumps({'id': None, 'error': {'code': 'INVALID_PARAMETER', 'message': 'x'}}), flush=True)\n"
        "    print(json.dumps([1, 2]), flush=True)\n"
        "    print(json.dumps({'id': req['id'], 'result': 'ok'}), flush=True)\n",
        encoding="utf-8",
    )
    noisy = BridgeClient(command=[sys.executable, str(script)])
    try:
        assert noisy.call("anything") == "ok"
    finally:
        noisy.close()


def test_child_environment_excludes_every_other_secret(make_client, monkeypatch):
    for name in ("TELEGRAM_BOT_TOKEN", "DISCORD_WEBHOOK_URL", "WATCHER_LOCAL_TOKEN", "SOME_RANDOM_SECRET"):
        monkeypatch.setenv(name, "fake-value-1234")
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", FAKE_SESSION)
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "fake-sign-456")
    client = make_client("env")

    keys = set(client.call("echo", {})["keys"])

    assert {"TRADINGVIEW_SESSION_ID", "TRADINGVIEW_SESSION_SIGN"} <= keys
    assert not keys & {"TELEGRAM_BOT_TOKEN", "DISCORD_WEBHOOK_URL", "WATCHER_LOCAL_TOKEN", "SOME_RANDOM_SECRET"}


def test_importing_the_client_module_spawns_nothing():
    import subprocess

    code = (
        "import subprocess\n"
        "spawned = []\n"
        "subprocess.Popen = lambda *a, **k: spawned.append(a)\n"
        "subprocess.run = lambda *a, **k: spawned.append(a)\n"
        "import tradingview_mcp.core.services.tv_bridge_client as m\n"
        "assert spawned == [], spawned\n"
        "assert m._client is None\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=60,
        env={**__import__("os").environ, "TRADINGVIEW_MCP_NO_DOTENV": "1"},
    )

    assert done.returncode == 0, done.stderr
