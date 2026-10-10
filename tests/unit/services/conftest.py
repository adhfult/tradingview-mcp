"""Shared stub for the TradingView bridge client (Phase 3 tests).

Hermetic: the stub never starts Node and never touches the network. Tests set
``tv_stub.replies[method]`` to a value, an exception, or a callable taking the
params, and read ``tv_stub.calls`` to see what was sent.
"""
from __future__ import annotations

import pytest

from tradingview_mcp.core.services import tv_bridge_client


class StubClient:
    """Same surface as BridgeClient for the calls the Phase 3 code makes."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict, float]] = []
        self.replies: dict = {}
        self.has_creds = False
        self.reason = None
        self.cooldown_s = 0.0

    def call(self, method, params=None, timeout_s=20.0):
        params = {} if params is None else params
        self.calls.append((method, params, timeout_s))
        reply = self.replies.get(method)
        if isinstance(reply, BaseException):
            raise reply
        if callable(reply):
            return reply(params)
        return reply

    def check_configured(self):
        return self.reason

    def has_credentials(self) -> bool:
        return self.has_creds

    def is_available(self) -> bool:
        return self.reason is None and self.cooldown_s <= 0.0

    def cooling_down(self) -> bool:
        return self.cooldown_s > 0.0

    def cooldown_remaining_s(self) -> float:
        return self.cooldown_s


@pytest.fixture
def tv_stub(monkeypatch):
    """Patch the process-wide bridge client with a stub, anonymous by default."""
    stub = StubClient()
    monkeypatch.setattr(tv_bridge_client, "get_client", lambda: stub)
    monkeypatch.setenv("TRADINGVIEW_SESSION_ID", "")
    monkeypatch.setenv("TRADINGVIEW_SESSION_SIGN", "")
    return stub
