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
