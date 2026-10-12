"""Phase 6a MCP surface: the gauntlet tools, the two prompts, and the new backtest arguments.

Routing only: the service logic is covered in services/test_gauntlet.py. Hermetic.
"""
import asyncio

from tradingview_mcp import server
from tradingview_mcp.server import mcp


def _tool(name):
    return next(t for t in mcp._tool_manager.list_tools() if t.name == name)


def _call(name, **kw):
    return asyncio.run(_tool(name).fn(**kw))


def test_gauntlet_tools_are_registered_read_only_with_titles():
    for name, title in (("strategy_gauntlet", "Strategy Gauntlet"), ("gauntlet_stats", "Gauntlet Statistics")):
        tool = _tool(name)
        assert tool.annotations.title == title
        assert tool.annotations.readOnlyHint is True and tool.annotations.destructiveHint is False


def test_the_gauntlet_docstring_says_it_writes_a_local_report():
    doc = _tool("strategy_gauntlet").description.lower()
    assert "report file" in doc and "gauntlet" in doc


def test_strategy_gauntlet_routes_every_argument(monkeypatch):
    seen = {}

    def fake(*args, **kwargs):
        seen["args"], seen["kwargs"] = args, kwargs
        return {"verdict": "FAIL: no stated edge"}
    monkeypatch.setattr(server, "run_gauntlet", fake)
    out = _call("strategy_gauntlet", symbol="BTC-USD", strategy="rsi", hypothesis="h" * 25,
                counterparty="c" * 25, cost_profile="binance_spot", interval="1h", period="1y",
                params={"period": 10}, data_source="tradingview", tv_symbol="BINANCE:BTCUSDT")
    assert out == {"verdict": "FAIL: no stated edge"}
    assert seen["args"] == ("BTC-USD", "rsi", "h" * 25, "c" * 25)
    assert seen["kwargs"] == {"cost_profile": "binance_spot", "interval": "1h", "period": "1y",
                              "params": {"period": 10}, "data_source": "tradingview",
                              "tv_symbol": "BINANCE:BTCUSDT"}


def test_gauntlet_stats_tool_returns_the_service_result(monkeypatch):
    monkeypatch.setattr(server, "_gauntlet_stats", lambda: {"total": 7})
    assert _call("gauntlet_stats") == {"total": 7}


def test_backtest_tool_passes_params_fill_and_cost_profile(monkeypatch):
    seen = {}
    monkeypatch.setattr(server, "run_backtest", lambda *a, **k: seen.update(k) or {"ok": True})
    _call("backtest_strategy", symbol="AAPL", strategy="rsi", params={"period": 9},
          fill="next_open", cost_profile="us_stock_broker")
    assert seen["params"] == {"period": 9} and seen["fill"] == "next_open"
    assert seen["cost_profile"] == "us_stock_broker"


def test_backtest_tool_defaults_leave_old_behaviour_alone(monkeypatch):
    seen = {}
    monkeypatch.setattr(server, "run_backtest", lambda *a, **k: seen.update(k) or {"ok": True})
    _call("backtest_strategy", symbol="AAPL", strategy="rsi")
    assert seen["params"] is None and seen["fill"] == "signal_close" and seen["cost_profile"] is None


def test_walk_forward_tool_passes_params_and_fill(monkeypatch):
    seen = {}
    monkeypatch.setattr(server, "walk_forward_backtest", lambda *a, **k: seen.update(k) or {"ok": True})
    _call("walk_forward_backtest_strategy", symbol="AAPL", strategy="rsi", params={"period": 9}, fill="next_open")
    assert seen["params"] == {"period": 9} and seen["fill"] == "next_open"


# ─── prompts ──────────────────────────────────────────────────────────────────

def test_both_prompts_are_registered():
    names = {p.name for p in mcp._prompt_manager.list_prompts()}
    assert {"strategy_builder", "strategy_reviewer"} <= names


def test_strategy_builder_walks_through_the_five_steps():
    text = server.strategy_builder("stocks", "1h")
    assert "stocks" in text and "1h" in text
    for needle in ("tv_hotlist", "tradability", "five hypotheses", "counterparty", "strategy_gauntlet", "honestly"):
        assert needle in text, needle


def test_strategy_builder_has_defaults():
    text = server.strategy_builder()
    assert "crypto" in text and "1d" in text


def test_strategy_reviewer_defaults_to_rejection_and_covers_the_attack_list():
    text = server.strategy_reviewer("ab" * 32)
    assert "ab" * 32 in text and "REJECT" in text and "rejection" in text
    for needle in ("Counterparty", "Cost drag", "Recent-year", "Sensitivity", "Trade count", "Survivorship"):
        assert needle in text, needle


def test_the_prompts_render_through_fastmcp():
    result = asyncio.run(mcp.get_prompt("strategy_reviewer", {"fingerprint": "f" * 64}))
    assert "f" * 64 in result.messages[0].content.text
