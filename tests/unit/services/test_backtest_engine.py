"""Phase 6a engine tests: parameter validation, next-open fills, cost profiles,
tradability, cost warnings and the no-lookahead check for all 9 strategies.

Hermetic: no network, no bridge.
"""
from __future__ import annotations

import pytest

from .test_backtest_snapshot import snapshot_candles
from tradingview_mcp.core.services import backtest_service as bt


# ─── params validation ────────────────────────────────────────────────────────

def test_resolve_params_fills_defaults_and_applies_overrides():
    resolved = bt.resolve_params("rsi", {"period": 10})
    assert resolved["period"] == 10
    assert resolved["oversold"] == 40 and resolved["overbought"] == 60


def test_resolve_params_none_gives_the_defaults():
    assert bt.resolve_params("ema_cross", None) == {"fast_period": 20, "slow_period": 50}


@pytest.mark.parametrize("strategy, params, fragment", [
    ("rsi", {"bogus": 1}, "bogus"),                              # unknown name lists the allowed ones
    ("rsi", {"period": "ten"}, "period"),                        # not a number
    ("rsi", {"period": float("nan")}, "period"),                 # not finite
    ("rsi", {"period": 1}, "period"),                            # length below 2
    ("ema_cross", {"fast_period": 60, "slow_period": 50}, "fast"),  # fast must stay below slow
    ("rsi", {"oversold": 70, "overbought": 60}, "oversold"),     # oversold must stay below overbought
    ("supertrend", {"multiplier": 0}, "multiplier"),             # must be positive
])
def test_resolve_params_rejects_bad_values(strategy, params, fragment):
    with pytest.raises(ValueError) as err:
        bt.resolve_params(strategy, params)
    assert fragment in str(err.value)


def test_unknown_param_error_names_the_allowed_parameters():
    with pytest.raises(ValueError) as err:
        bt.resolve_params("rsi", {"bogus": 1})
    assert "period" in str(err.value) and "oversold" in str(err.value)


def test_run_backtest_turns_a_bad_param_into_an_error_dict(monkeypatch):
    monkeypatch.setattr(bt, "_fetch_ohlcv", lambda *a, **k: snapshot_candles())
    result = bt.run_backtest("TEST", "rsi", params={"bogus": 1})
    assert "error" in result and "bogus" in result["error"]


# ─── next-open fills on a hand-made series ────────────────────────────────────

def _bars(n=10):
    return [{"date": f"2024-01-{i + 1:02d}", "open": 100 + i, "high": 120, "low": 90,
             "close": 200 + i, "volume": 1} for i in range(n)]


def _trade(entry_idx, exit_idx):
    return {"entry_idx": entry_idx, "exit_idx": exit_idx, "entry_date": "x", "entry_price": 0.0,
            "exit_date": "y", "exit_price": 0.0}


def test_signal_close_leaves_trades_untouched():
    trades = [_trade(2, 5)]
    assert bt._apply_fill(trades, _bars(), "signal_close") == trades


def test_next_open_moves_entry_and_exit_to_the_following_bar():
    out = bt._apply_fill([_trade(2, 5)], _bars(), "next_open")
    assert len(out) == 1
    assert out[0]["entry_date"] == "2024-01-04" and out[0]["entry_price"] == 103   # bar 3 open
    assert out[0]["exit_date"] == "2024-01-07" and out[0]["exit_price"] == 106     # bar 6 open
    assert "forced_exit" not in out[0]


def test_next_open_drops_an_entry_on_the_last_bar():
    assert bt._apply_fill([_trade(9, 9)], _bars(), "next_open") == []


def test_next_open_forces_the_exit_to_the_last_close_when_there_is_no_next_bar():
    out = bt._apply_fill([_trade(4, 9)], _bars(), "next_open")
    assert out[0]["entry_price"] == 105                     # bar 5 open
    assert out[0]["exit_price"] == 209 and out[0]["forced_exit"] is True   # last close


def test_invalid_fill_is_an_error():
    with pytest.raises(ValueError):
        bt._simulate(_bars(), "rsi", commission_pct=0.1, slippage_pct=0.05, fill="midpoint")


def test_runners_record_bar_indexes_but_results_hide_them(monkeypatch):
    candles = snapshot_candles()
    trades = bt._trades_for(candles, "ema_cross", bt.resolve_params("ema_cross", None), "signal_close")
    assert trades and all("entry_idx" in t and "exit_idx" in t for t in trades)
    assert all(t["entry_idx"] < t["exit_idx"] for t in trades)
    monkeypatch.setattr(bt, "_fetch_ohlcv", lambda *a, **k: candles)
    result = bt.run_backtest("TEST", "ema_cross", include_trade_log=True)
    assert "entry_idx" not in str(result) and "exit_idx" not in str(result)


# ─── cost profiles, cost warnings, tradability ────────────────────────────────

def test_cost_profile_sets_costs_and_is_reported(monkeypatch):
    monkeypatch.setattr(bt, "_fetch_ohlcv", lambda *a, **k: snapshot_candles())
    result = bt.run_backtest("TEST", "ema_cross", cost_profile="coinbase_advanced")
    assert result["cost_profile"] == "coinbase_advanced"
    assert result["commission_pct"] == 0.6 and result["slippage_pct"] == 0.1


def test_cost_profile_wins_over_explicit_costs(monkeypatch):
    monkeypatch.setattr(bt, "_fetch_ohlcv", lambda *a, **k: snapshot_candles())
    result = bt.run_backtest("TEST", "ema_cross", commission_pct=5.0, cost_profile="us_stock_broker")
    assert result["commission_pct"] == 0.0 and result["slippage_pct"] == 0.05


def test_unknown_cost_profile_lists_the_names(monkeypatch):
    monkeypatch.setattr(bt, "_fetch_ohlcv", lambda *a, **k: snapshot_candles())
    result = bt.run_backtest("TEST", "ema_cross", cost_profile="free_lunch")
    assert "error" in result and "binance_spot" in result["error"]


def test_no_cost_profile_key_without_a_profile(monkeypatch):
    monkeypatch.setattr(bt, "_fetch_ohlcv", lambda *a, **k: snapshot_candles())
    assert "cost_profile" not in bt.run_backtest("TEST", "ema_cross")


def _trades(count, gross):
    return [{"gross_return_pct": gross} for _ in range(count)]


def test_cost_summary_warns_on_high_turnover():
    out = bt._cost_summary(_trades(300, 1.0), 10_000.0, bars=252, ann=252, net_return_pct=10.0)
    assert out["trades_per_year"] == 300.0
    assert any("High turnover" in w for w in out["cost_warnings"])


def test_cost_summary_warns_when_costs_eat_over_half_the_gross_return():
    out = bt._cost_summary(_trades(10, 1.0), 10_000.0, bars=252, ann=252, net_return_pct=2.0)
    assert out["gross_return_pct"] > 0 and out["cost_drag_pct"] > out["gross_return_pct"] / 2
    assert any("more than half" in w for w in out["cost_warnings"])


def test_cost_summary_is_quiet_for_a_cheap_strategy():
    out = bt._cost_summary(_trades(10, 1.0), 10_000.0, bars=252, ann=252, net_return_pct=9.5)
    assert out["cost_warnings"] == []


def _candles_with(price, volume, n=100, zero_every=0):
    return [{"date": f"2024-01-{i % 28 + 1:02d}", "close": price,
             "volume": 0 if zero_every and i % zero_every == 0 else volume} for i in range(n)]


def test_liquid_market_is_not_thin():
    t = bt._tradability(_candles_with(100.0, 1_000_000))
    assert t["thin_market"] is False and t["avg_daily_value"] == 100_000_000.0
    assert t["zero_volume_bar_pct"] == 0.0 and t["bars"] == 100


def test_low_traded_value_is_thin():
    assert bt._tradability(_candles_with(1.0, 100))["thin_market"] is True


def test_many_zero_volume_bars_are_thin_even_when_value_is_high():
    t = bt._tradability(_candles_with(100.0, 10_000_000, zero_every=10))   # 10% zero bars
    assert t["zero_volume_bar_pct"] == 10.0 and t["thin_market"] is True


def test_thin_threshold_can_be_set_by_environment(monkeypatch):
    candles = _candles_with(100.0, 20_000)   # 2,000,000 a day
    assert bt._tradability(candles)["thin_market"] is False
    monkeypatch.setenv("TRADINGVIEW_MCP_MIN_DAILY_VALUE", "5000000")
    assert bt._tradability(candles)["thin_market"] is True


def test_intraday_value_is_summed_per_day_first():
    candles = [{"date": f"2024-01-02 {h:02d}:00", "close": 10.0, "volume": 100} for h in range(5)]
    assert bt._tradability(candles, "1h")["avg_daily_value"] == 5000.0   # one day, five bars


# ─── no lookahead ─────────────────────────────────────────────────────────────

_COMPARE = ("entry_idx", "exit_idx", "entry_date", "exit_date", "entry_price", "exit_price")


def _lookahead_violations(strategy: str) -> tuple[int, list]:
    """(trades checked, violations): a trade closed before bar k must reappear when only bars 0..k are known.

    400 bars, except the two strategies with a 200-bar warm-up, which make no trades on 400 (600 there).
    """
    n = 600 if bt._STRATEGY_WARMUP_BARS[strategy] >= 200 else 400
    candles = snapshot_candles(n)
    resolved = bt.resolve_params(strategy, None)
    full = bt._trades_for(candles, strategy, resolved, "signal_close")
    warmup = bt._STRATEGY_WARMUP_BARS[strategy]
    checked, violations = 0, []
    for k in range(warmup + 20, n, 10):
        truncated = bt._trades_for(candles[:k + 1], strategy, resolved, "signal_close")
        seen = {tuple(t[key] for key in _COMPARE) for t in truncated}
        for t in full:
            if t["exit_idx"] < k:                      # closed strictly before the cut-off
                checked += 1
                if tuple(t[key] for key in _COMPARE) not in seen:
                    violations.append((k, t["entry_idx"], t["exit_idx"]))
    return checked, violations


@pytest.mark.parametrize("strategy", sorted(bt._STRATEGY_MAP))
def test_no_lookahead(strategy):
    checked, violations = _lookahead_violations(strategy)
    assert not violations, f"{strategy} used future bars: {violations[:3]}"
    assert checked > 0, f"{strategy}: no trade was ever checked"


def test_the_lookahead_check_catches_a_strategy_that_peeks(monkeypatch):
    def cheat(candles, **_):
        trades = []
        for i in range(0, len(candles) - 10, 10):
            if candles[i + 8]["close"] > candles[i]["close"]:    # decides using bar i+8 ...
                trades.append({"entry_idx": i, "exit_idx": i + 3,  # ... but exits at bar i+3
                               "entry_date": candles[i]["date"], "exit_date": candles[i + 3]["date"],
                               "entry_price": candles[i]["close"], "exit_price": candles[i + 3]["close"]})
        return trades

    monkeypatch.setitem(bt._STRATEGY_MAP, "cheat", cheat)
    monkeypatch.setitem(bt._STRATEGY_WARMUP_BARS, "cheat", 5)
    checked, violations = _lookahead_violations("cheat")
    assert checked > 0 and violations
