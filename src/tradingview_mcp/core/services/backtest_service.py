"""
Backtesting Service for tradingview-mcp — v3 (v0.7.0)

Pure Python — no pandas, no numpy, no external backtesting libraries.

Supported strategies (6):
  rsi, bollinger, macd, ema_cross, supertrend, donchian

v0.7.0 additions:
  - 1h (hourly) timeframe support
  - Full trade log with per-trade detail
  - Equity curve data points
  - Walk-forward backtesting (overfitting detection)
"""
from __future__ import annotations

import inspect
import json
import math
import os
import statistics
import time
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from tradingview_mcp.core.services import freshness, tv_bridge_client
from tradingview_mcp.core.services.indicators_calc import (
    calc_rsi, calc_bollinger, calc_macd, calc_ema, calc_sma, calc_atr,
    calc_supertrend, calc_donchian,
)
from tradingview_mcp.core.services.tv_bridge_client import BridgeError
from tradingview_mcp.core.services.tv_data_service import (
    bridge_error_message, is_tv_symbol, tv_periods_per_year,
)

_UA       = "tradingview-mcp/0.7.0 backtest-bot"
_YF_BASE  = "https://query1.finance.yahoo.com/v8/finance/chart"

_VALID_PERIODS   = {"1mo", "3mo", "6mo", "1y", "2y"}
_VALID_INTERVALS = {"1d", "1h"}

# Annualization factor for Sharpe ratio
# Bars per year: 252 trading days; US regular session is 6.5 hours → 6.5
# hourly bars per day. Callers on other markets (e.g. EGX: ~245 sessions of
# 4.5h, EGP risk-free ~25%) should pass periods_per_year / risk_free_rate
# explicitly — these are US-market defaults.
_ANNUALIZATION = {"1d": 252, "1h": int(252 * 6.5)}
_DEFAULT_RISK_FREE = 0.04  # annual, decimal

_STRATEGY_LABELS = {
    "rsi":              "RSI Oversold/Overbought",
    "bollinger":        "Bollinger Band Mean Reversion",
    "macd":             "MACD Crossover",
    "ema_cross":        "EMA 20/50 Golden/Death Cross",
    "supertrend":       "Supertrend (ATR-based Trend Following)",
    "donchian":         "Donchian Channel Breakout",
    "rsi_pullback":     "RSI Pullback in Uptrend (SMA50>SMA200)",
    "keltner_breakout": "Keltner Channel Breakout (EMA20 + 2·ATR)",
    "triple_ema":       "EMA 20/50 Cross with SMA200 Trend Filter",
}

# Strategies that require SMA200 warmup → need ≥220 bars to produce signals
_SMA200_STRATEGIES = {"rsi_pullback", "triple_ema"}
_SMA200_MIN_BARS  = 220


# ─── TradingView candle source ────────────────────────────────────────────────
# Opt-in with data_source="tradingview". Yahoo (the default) is untouched.

_DATA_SOURCES = ("yahoo", "tradingview")
_TV_PERIOD_DAYS = {"1mo": 30, "3mo": 91, "6mo": 182, "1y": 365, "2y": 730, "3y": 1095, "5y": 1826}
_TV_INTERVAL_CODES = {"15m": "15", "1h": "60", "4h": "240", "1d": "D"}
_TIMEFRAME_LABELS = {
    "15m": "15-minute (15m)", "1h": "Hourly (1h)", "4h": "4-hour (4h)", "1d": "Daily (1d)",
}
# The library caps a `from` fetch at maxCount bars (default and bridge max 20,000), so
# each interval only allows the periods that fit under that cap.
_TV_MAX_BARS = 20000
_TV_PERIODS_BY_INTERVAL = {
    "15m": ("1mo", "3mo", "6mo"),
    "1h": ("1mo", "3mo", "6mo", "1y", "2y"),
    "4h": tuple(_TV_PERIOD_DAYS),
    "1d": tuple(_TV_PERIOD_DAYS),
}
_TV_TIMEOUT_MS = 60000        # bridge-side deadline; the bridge default is 15 s
_TV_CALL_TIMEOUT_S = 60       # client wait; the client adds its own margin on top
_TV_TRUNCATION_FRACTION = 0.10


def _normalize_source(data_source: Optional[str], tv_symbol: Optional[str]) -> tuple[str, Optional[str]]:
    ds = (data_source or "yahoo").strip().lower()
    tvs = tv_symbol.strip().upper() if isinstance(tv_symbol, str) else tv_symbol
    return ds, tvs


def _check_period_interval(
    period: str, interval: str, data_source: str, tv_symbol: Optional[str],
) -> Optional[str]:
    """Error message for a bad period/interval/source combination, or None.

    The Yahoo messages are the ones the tools have always returned.
    """
    if data_source == "tradingview":
        if not tv_symbol:
            return "tv_symbol is required when data_source is 'tradingview', e.g. BINANCE:BTCUSDT"
        if not is_tv_symbol(tv_symbol):
            return f"tv_symbol must look like EXCHANGE:SYMBOL, e.g. BINANCE:BTCUSDT; got {tv_symbol!r}"
        if interval not in _TV_INTERVAL_CODES:
            return f"Invalid interval '{interval}' for TradingView. Choose: {', '.join(_TV_INTERVAL_CODES)}"
        if period not in _TV_PERIOD_DAYS:
            return f"Invalid period '{period}' for TradingView. Choose: {', '.join(_TV_PERIOD_DAYS)}"
        allowed = _TV_PERIODS_BY_INTERVAL[interval]
        if period not in allowed:
            return (f"Period '{period}' is too long for interval '{interval}' on TradingView "
                    f"(the bridge returns at most {_TV_MAX_BARS:,} bars). Choose: {', '.join(allowed)}")
        return None
    if period not in _VALID_PERIODS:
        return f"Invalid period '{period}'. Choose: {', '.join(_VALID_PERIODS)}"
    if interval not in _VALID_INTERVALS:
        return f"Invalid interval '{interval}'. Choose: 1d or 1h"
    return None


def _check_data_source(data_source: str) -> Optional[str]:
    if data_source not in _DATA_SOURCES:
        return f"Invalid data_source '{data_source}'. Choose: yahoo or tradingview"
    return None


def _truncation_note(period: str, meta: dict) -> str:
    return (f"TradingView history starts {meta['first_date']}, later than the requested {period} "
            f"window. The symbol's history may be shorter than requested, or the "
            f"{_TV_MAX_BARS:,}-bar plan limit applied.")


def tv_bars_to_candles(bars: list, interval: str) -> list[dict]:
    """Bridge bars as backtest candles: sorted, one per date (the last bar seen wins).

    Pure (no network). Each candle keeps `time`, the bar's open time in unix seconds,
    so callers can tell a still-forming last bar from a closed one.
    """
    fmt = "%Y-%m-%d" if interval == "1d" else "%Y-%m-%d %H:%M"
    dated: list[tuple[int, dict]] = []
    for bar in bars:
        if not isinstance(bar, dict) or bar.get("time") is None:
            continue
        o, h, l, c = bar.get("open"), bar.get("high"), bar.get("low"), bar.get("close")
        if None in (o, h, l, c):
            continue
        ts = int(bar["time"])
        dated.append((ts, {
            "date":   datetime.fromtimestamp(ts, tz=timezone.utc).strftime(fmt),
            "time":   ts,
            "open":   round(o, 4),
            "high":   round(h, 4),
            "low":    round(l, 4),
            "close":  round(c, 4),
            "volume": bar.get("volume") or 0,
        }))
    dated.sort(key=lambda item: item[0])

    # Dates must be unique: a duplicate keeps the last bar seen.
    by_date: dict[str, dict] = {}
    for _, candle in dated:
        by_date[candle["date"]] = candle
    return list(by_date.values())


def _fetch_tv_candles(tv_symbol: str, period: str, interval: str) -> tuple[list[dict], dict]:
    """Bridge candles as backtest bars, plus metadata (source label, truncation).

    Raises RuntimeError with the bridge's message on failure, which run_backtest turns
    into its normal error dict.
    """
    client = tv_bridge_client.get_client()
    now = time.time()
    from_ts = int(now) - _TV_PERIOD_DAYS[period] * 86400
    try:
        bars = client.call(
            "candles",
            {
                "symbol": tv_symbol,
                "timeframe": _TV_INTERVAL_CODES[interval],
                "from": from_ts,
                "maxCount": _TV_MAX_BARS,
                "timeoutMs": _TV_TIMEOUT_MS,
            },
            timeout_s=_TV_CALL_TIMEOUT_S,
        )
    except BridgeError as err:
        raise RuntimeError(bridge_error_message(err)) from err

    auth = "session" if client.has_credentials() else "anonymous"
    freshness.record("tradingview_bridge", time.time(), auth=auth)
    if not isinstance(bars, list):
        raise RuntimeError("TradingView returned an unexpected candles reply")

    candles = tv_bars_to_candles(bars, interval)

    span = now - from_ts
    truncated = bool(candles) and (candles[0]["time"] - from_ts) > _TV_TRUNCATION_FRACTION * span
    meta = {
        "data_source": f"TradingView ({'session' if auth == 'session' else 'anonymous'})",
        "truncated": truncated,
        "first_date": candles[0]["date"] if candles else None,
    }
    return candles, meta


def _fetch_ohlcv_tv(tv_symbol: str, period: str, interval: str) -> list[dict]:
    """TradingView candles as backtest bars (see _fetch_tv_candles)."""
    return _fetch_tv_candles(tv_symbol, period, interval)[0]


def _load_candles(
    symbol: str, period: str, interval: str, data_source: str, tv_symbol: Optional[str],
) -> tuple[list[dict], dict]:
    """Candles for the chosen source, plus source metadata (empty for Yahoo)."""
    if data_source == "tradingview":
        return _fetch_tv_candles(tv_symbol, period, interval)
    return _fetch_ohlcv(symbol, period, interval), {}


# ─── Data Fetching ────────────────────────────────────────────────────────────

def _fetch_ohlcv(symbol: str, period: str, interval: str = "1d") -> list[dict]:
    url = f"{_YF_BASE}/{symbol}?interval={interval}&range={period}&includeAdjustedClose=true"
    req = urllib.request.Request(url, headers={"User-Agent": _UA})

    data = None
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        pass

    if data is None:
        try:
            from tradingview_mcp.core.services.proxy_manager import build_opener_with_proxy
            opener = build_opener_with_proxy(_UA)
            with opener.open(url, timeout=18) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            raise RuntimeError(f"Both direct and proxy connections failed: {e}")

    result     = data["chart"]["result"][0]
    timestamps = result["timestamp"]
    q          = result["indicators"]["quote"][0]
    date_fmt   = "%Y-%m-%d %H:%M" if interval == "1h" else "%Y-%m-%d"

    # Dividend/split adjustment: Yahoo's quote array is split-adjusted only.
    # High-yield markets (EGX pays 5-15% cash) book phantom losses on ex-div
    # gaps and understate buy-and-hold without this. Scale OHLC by the
    # per-bar adjclose/close factor when Yahoo provides adjclose (daily bars).
    adj = None
    try:
        adj = result["indicators"]["adjclose"][0]["adjclose"]
    except (KeyError, IndexError, TypeError):
        adj = None

    candles = []
    for i, ts in enumerate(timestamps):
        o, h, l, c, v = q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i]
        if None in (o, h, l, c):
            continue
        if adj is not None and i < len(adj) and adj[i] and c:
            factor = adj[i] / c
            o, h, l, c = o * factor, h * factor, l * factor, adj[i]
        candles.append({
            "date":   datetime.fromtimestamp(ts, tz=timezone.utc).strftime(date_fmt),
            "open":   round(o, 4),
            "high":   round(h, 4),
            "low":    round(l, 4),
            "close":  round(c, 4),
            "volume": v or 0,
        })
    freshness.record("yahoo", time.time())
    return candles


# ─── Strategy Engines ─────────────────────────────────────────────────────────

def _finalize_trades(trades: list, position, candles: list) -> list:
    """Close any still-open position at the final bar, flagged forced_exit.

    Silently discarding open positions biased every strategy's results: one
    currently underwater in an open trade reported only its closed winners,
    and trade counts flapped between adjacent periods.
    """
    if position is not None and candles:
        trades.append({
            **position,
            "exit_date": candles[-1]["date"],
            "exit_price": candles[-1]["close"],
            "forced_exit": True,
            "exit_idx": len(candles) - 1,
        })
    return trades


def _run_rsi(candles, oversold=40, overbought=60, period=14, **_):
    closes = [c["close"] for c in candles]
    rsi    = calc_rsi(closes, period)
    trades, position = [], None
    for i in range(1, len(candles)):
        if rsi[i] is None:
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        if position is None and rsi[i] < oversold:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "rsi"}
        elif position is not None and rsi[i] > overbought:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_bollinger(candles, period=20, std_mult=2.0, **_):
    closes = [c["close"] for c in candles]
    bb     = calc_bollinger(closes, period, std_mult)
    trades, position = [], None
    for i in range(1, len(candles)):
        if bb["lower"][i] is None:
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        if position is None and price < bb["lower"][i]:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "bollinger"}
        elif position is not None and price > bb["middle"][i]:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_macd(candles, fast=12, slow=26, signal=9, **_):
    closes = [c["close"] for c in candles]
    macd   = calc_macd(closes, fast, slow, signal)
    trades, position = [], None
    for i in range(1, len(candles)):
        m, s, mp, sp = macd["macd"][i], macd["signal"][i], macd["macd"][i-1], macd["signal"][i-1]
        if None in (m, s, mp, sp):
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        if position is None and mp < sp and m >= s:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "macd"}
        elif position is not None and mp > sp and m <= s:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_ema_cross(candles, fast_period=20, slow_period=50, **_):
    closes   = [c["close"] for c in candles]
    ema_fast = calc_ema(closes, fast_period)
    ema_slow = calc_ema(closes, slow_period)
    trades, position = [], None
    for i in range(1, len(candles)):
        f, s, fp, sp = ema_fast[i], ema_slow[i], ema_fast[i-1], ema_slow[i-1]
        if None in (f, s, fp, sp):
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        if position is None and fp < sp and f >= s:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "ema_cross"}
        elif position is not None and fp > sp and f <= s:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_supertrend(candles, atr_period=10, multiplier=3.0, **_):
    highs  = [c["high"]  for c in candles]
    lows   = [c["low"]   for c in candles]
    closes = [c["close"] for c in candles]
    st     = calc_supertrend(highs, lows, closes, atr_period, multiplier)
    trades, position = [], None
    for i in range(1, len(candles)):
        d, dp = st["direction"][i], st["direction"][i - 1]
        if d is None or dp is None:
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        if position is None and dp == -1 and d == 1:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "supertrend"}
        elif position is not None and dp == 1 and d == -1:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_donchian(candles, period=20, **_):
    highs  = [c["high"] for c in candles]
    lows   = [c["low"]  for c in candles]
    dc     = calc_donchian(highs, lows, period)
    trades, position = [], None
    for i in range(1, len(candles)):
        # Compare against the channel formed by the PRIOR window (index i-1).
        # dc["upper"][i]/[i] include bar i itself, so highs[i] can never exceed
        # dc["upper"][i] (a value can't beat a max that contains it) -> 0 trades.
        if dc["upper"][i - 1] is None or dc["lower"][i - 1] is None:
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        if position is None and highs[i] > dc["upper"][i - 1]:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "donchian"}
        elif position is not None and lows[i] < dc["lower"][i - 1]:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_rsi_pullback(candles, rsi_period=14, oversold=40, overbought=70,
                       fast_ma=50, slow_ma=200, **_):
    """Dip-buy in confirmed uptrend.

    Entry: SMA(fast_ma) > SMA(slow_ma)  AND  RSI < oversold
    Exit:  RSI > overbought              OR   close < SMA(fast_ma)
    """
    closes   = [c["close"] for c in candles]
    rsi      = calc_rsi(closes, rsi_period)
    sma_fast = calc_sma(closes, fast_ma)
    sma_slow = calc_sma(closes, slow_ma)
    trades, position = [], None
    for i in range(1, len(candles)):
        if rsi[i] is None or sma_fast[i] is None or sma_slow[i] is None:
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        in_uptrend  = sma_fast[i] > sma_slow[i]
        if position is None and in_uptrend and rsi[i] < oversold:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "rsi_pullback"}
        elif position is not None and (rsi[i] > overbought or price < sma_fast[i]):
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_keltner_breakout(candles, ema_period=20, atr_period=14, multiplier=2.0, **_):
    """ATR-normalized breakout (volatility-aware Donchian alternative).

    Upper = EMA(20) + multiplier · ATR(14)
    Entry: close > upper
    Exit:  close < EMA(20)
    """
    highs  = [c["high"]  for c in candles]
    lows   = [c["low"]   for c in candles]
    closes = [c["close"] for c in candles]
    ema    = calc_ema(closes, ema_period)
    atr    = calc_atr(highs, lows, closes, atr_period)
    trades, position = [], None
    for i in range(1, len(candles)):
        if ema[i] is None or atr[i] is None:
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        upper       = ema[i] + multiplier * atr[i]
        if position is None and price > upper:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "keltner_breakout"}
        elif position is not None and price < ema[i]:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


def _run_triple_ema(candles, fast_period=20, slow_period=50, trend_period=200, **_):
    """EMA 20/50 cross gated by long-term trend filter.

    Entry: EMA(20) crosses ABOVE EMA(50)  AND  close > SMA(200)
    Exit:  EMA(20) crosses BELOW EMA(50)
    """
    closes    = [c["close"] for c in candles]
    ema_fast  = calc_ema(closes, fast_period)
    ema_slow  = calc_ema(closes, slow_period)
    sma_trend = calc_sma(closes, trend_period)
    trades, position = [], None
    for i in range(1, len(candles)):
        f, s, fp, sp, t = ema_fast[i], ema_slow[i], ema_fast[i-1], ema_slow[i-1], sma_trend[i]
        if None in (f, s, fp, sp, t):
            continue
        price, date = candles[i]["close"], candles[i]["date"]
        bull_cross  = fp < sp and f >= s
        bear_cross  = fp > sp and f <= s
        if position is None and bull_cross and price > t:
            position = {"entry_date": date, "entry_price": price, "entry_idx": i, "strategy": "triple_ema"}
        elif position is not None and bear_cross:
            trades.append({**position, "exit_date": date, "exit_price": price, "exit_idx": i})
            position = None
    return _finalize_trades(trades, position, candles)


_STRATEGY_MAP = {
    "rsi":              _run_rsi,
    "bollinger":        _run_bollinger,
    "macd":             _run_macd,
    "ema_cross":        _run_ema_cross,
    "supertrend":       _run_supertrend,
    "donchian":         _run_donchian,
    "rsi_pullback":     _run_rsi_pullback,
    "keltner_breakout": _run_keltner_breakout,
    "triple_ema":       _run_triple_ema,
}

# Bars each strategy needs before its slowest indicator produces signals.
# Walk-forward test slices shorter than this cannot trade at all — scoring
# them 0.0 falsely reads as "fails out-of-sample" when the real cause is
# "window too small to even warm up".
_STRATEGY_WARMUP_BARS = {
    "rsi":              14,
    "bollinger":        20,
    "macd":             35,   # slow EMA 26 + signal 9
    "ema_cross":        50,   # slow EMA
    "supertrend":       10,   # ATR period
    "donchian":         20,
    "rsi_pullback":     200,  # SMA200 (excluded from walk-forward anyway)
    "keltner_breakout": 20,   # EMA20 / ATR14
    "triple_ema":       200,  # trend EMA (excluded from walk-forward anyway)
}


# Bar indexes (entry_idx / exit_idx) are internal: the gauntlet's next-open fill and
# no-lookahead checks use them. They are stripped from every result a caller sees.
_INTERNAL_TRADE_KEYS = ("entry_idx", "exit_idx")


def _public_trade(trade: dict) -> dict:
    return {k: v for k, v in trade.items() if k not in _INTERNAL_TRADE_KEYS}


# ─── Strategy parameters, fill model and the simulation engine ────────────────

_FILLS = ("signal_close", "next_open")
_LENGTH_NAMES = {"period", "fast", "slow", "signal", "fast_ma", "slow_ma"}
_POSITIVE_NAMES = {"multiplier", "std_mult"}
_ORDERED_PAIRS = (("fast_period", "slow_period"), ("fast", "slow"), ("fast_ma", "slow_ma"))


def _is_length_param(name: str) -> bool:
    return name in _LENGTH_NAMES or name.endswith("_period")


def strategy_param_defaults(strategy: str) -> dict:
    """Named tunable parameters of a strategy with their defaults.

    The first parameter (candles) and any **kwargs catch-all are not tunable.
    """
    params = {}
    sig = inspect.signature(_STRATEGY_MAP[strategy])
    for idx, (name, p) in enumerate(sig.parameters.items()):
        if idx == 0 or p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if p.default is not inspect.Parameter.empty:
            params[name] = p.default
    return params


def resolve_params(strategy: str, params: Optional[dict]) -> dict:
    """Strategy defaults overlaid with the caller's params, checked.

    Raises ValueError (message suitable for a tool error) on unknown names,
    non-numeric or non-finite values, lengths below 2, non-positive multipliers,
    and fast/slow or oversold/overbought orderings that do not hold.
    """
    allowed = strategy_param_defaults(strategy)
    resolved = dict(allowed)
    if params is not None:
        if not isinstance(params, dict):
            raise ValueError("params must be an object mapping parameter names to numbers")
        unknown = sorted(set(params) - set(allowed))
        if unknown:
            raise ValueError(
                f"Unknown parameter(s) for '{strategy}': {', '.join(unknown)}. "
                f"Allowed: {', '.join(allowed) or 'none'}")
        for name, value in params.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"Parameter '{name}' must be a finite number, got {value!r}")
            if _is_length_param(name):
                if value != int(value):
                    raise ValueError(f"Parameter '{name}' must be a whole number, got {value}")
                value = int(value)
                if value < 2:
                    raise ValueError(f"Parameter '{name}' must be at least 2, got {value}")
            if name in _POSITIVE_NAMES and value <= 0:
                raise ValueError(f"Parameter '{name}' must be greater than 0, got {value}")
            resolved[name] = value
    for fast_name, slow_name in _ORDERED_PAIRS:
        if fast_name in resolved and slow_name in resolved and not resolved[fast_name] < resolved[slow_name]:
            raise ValueError(f"{fast_name} ({resolved[fast_name]}) must be less than "
                             f"{slow_name} ({resolved[slow_name]})")
    if "oversold" in resolved and "overbought" in resolved and not resolved["oversold"] < resolved["overbought"]:
        raise ValueError(f"oversold ({resolved['oversold']}) must be less than "
                         f"overbought ({resolved['overbought']})")
    return resolved


def _apply_fill(trades: list[dict], candles: list[dict], fill: str) -> list[dict]:
    """Move trade prices to the bar after the signal when fill="next_open".

    A signal on the last bar has no next open: an entry there is dropped; an exit
    there keeps the last bar's close and is flagged forced_exit. "signal_close"
    returns the trades untouched.
    """
    if fill == "signal_close":
        return trades
    last = len(candles) - 1
    out = []
    for t in trades:
        entry_at = t["entry_idx"] + 1
        if entry_at > last:
            continue
        new = {**t, "entry_date": candles[entry_at]["date"], "entry_price": candles[entry_at]["open"]}
        exit_at = t["exit_idx"] + 1
        if exit_at <= last:
            new["exit_date"] = candles[exit_at]["date"]
            new["exit_price"] = candles[exit_at]["open"]
        else:
            new["exit_date"] = candles[last]["date"]
            new["exit_price"] = candles[last]["close"]
            new["forced_exit"] = True
        out.append(new)
    return out


def _trades_for(candles: list[dict], strategy: str, resolved: dict, fill: str) -> list[dict]:
    """Raw trades (before costs) for one candle window, with the fill applied."""
    return _apply_fill(_STRATEGY_MAP[strategy](candles, **resolved), candles, fill)


def _simulate(
    candles: list[dict],
    strategy: str,
    *,
    params: Optional[dict] = None,
    commission_pct: float,
    slippage_pct: float,
    fill: str = "signal_close",
    interval: str = "1d",
    periods_per_year: Optional[int] = None,
    risk_free_rate: Optional[float] = None,
    initial_capital: float = 10_000.0,
) -> dict:
    """One simulation: runner, fill, costs, metrics. Every backtest entry point goes through here.

    Returns {trades, metrics, bnh, params} where params are the resolved values.
    """
    if fill not in _FILLS:
        raise ValueError(f"Invalid fill '{fill}'. Choose: {', '.join(_FILLS)}")
    resolved = resolve_params(strategy, params)
    trades = _apply_costs(_trades_for(candles, strategy, resolved, fill), commission_pct, slippage_pct)
    metrics = _calc_metrics(trades, initial_capital, interval, candles=candles,
                            risk_free_rate=risk_free_rate, periods_per_year=periods_per_year)
    bnh = _buy_and_hold_return(candles, commission_pct, slippage_pct)
    return {"trades": trades, "metrics": metrics, "bnh": bnh, "params": resolved}


# ─── Cost profiles, tradability and cost summary (6.1, 6.3) ──────────────────

# ASSUMPTIONS: check against your real fees before trusting results.
COST_PROFILES = {
    "default":           {"commission_pct": 0.10, "slippage_pct": 0.05},
    "binance_spot":      {"commission_pct": 0.10, "slippage_pct": 0.05},
    "coinbase_advanced": {"commission_pct": 0.60, "slippage_pct": 0.10},
    "us_stock_broker":   {"commission_pct": 0.00, "slippage_pct": 0.05},
}

MULTIPLE_TESTING_WARNING = (
    "Picking the best of 9 strategies on one symbol overstates how good it is. "
    "Run the winner through strategy_gauntlet."
)

_HIGH_TURNOVER_PER_YEAR = 200
_THIN_ZERO_VOLUME_PCT = 5.0
_DEFAULT_MIN_DAILY_VALUE = 1_000_000.0


def _min_daily_value() -> float:
    raw = os.environ.get("TRADINGVIEW_MCP_MIN_DAILY_VALUE", str(int(_DEFAULT_MIN_DAILY_VALUE)))
    try:
        return float(raw)
    except ValueError:
        return _DEFAULT_MIN_DAILY_VALUE


def _tradability(candles: list[dict], interval: str = "1d") -> dict:
    """Liquidity of the bars: average traded value per day and the share of zero-volume bars.

    Value per bar is close x volume. Intraday bars are summed per calendar day
    first, then the days are averaged.
    """
    bars = len(candles)
    zero = sum(1 for c in candles if not c.get("volume"))
    zero_pct = round(100.0 * zero / bars, 2) if bars else 0.0
    if interval == "1d":
        values = [float(c["close"]) * float(c.get("volume") or 0) for c in candles]
    else:
        per_day: dict[str, float] = {}
        for c in candles:
            day = str(c["date"])[:10]
            per_day[day] = per_day.get(day, 0.0) + float(c["close"]) * float(c.get("volume") or 0)
        values = list(per_day.values())
    avg = sum(values) / len(values) if values else 0.0
    return {
        "avg_daily_value": round(avg, 2),
        "zero_volume_bar_pct": zero_pct,
        "bars": bars,
        "thin_market": avg < _min_daily_value() or zero_pct > _THIN_ZERO_VOLUME_PCT,
    }


def _cost_summary(trades: list[dict], initial_capital: float, bars: int, ann: int,
                  net_return_pct: float) -> dict:
    """Gross return compounded from per-trade gross returns, and what the costs took."""
    gross_capital = initial_capital
    for t in trades:
        gross_capital *= (1 + t["gross_return_pct"] / 100)
    gross = round((gross_capital - initial_capital) / initial_capital * 100, 2)
    drag = round(gross - net_return_pct, 2)
    trades_per_year = round(len(trades) * ann / bars, 2) if bars else 0.0
    warnings = []
    if trades_per_year > _HIGH_TURNOVER_PER_YEAR:
        warnings.append("High turnover (>200 trades/yr): costs dominate")
    if gross > 0 and drag > gross / 2:
        warnings.append("Costs consume more than half of gross return")
    return {
        "trades_per_year":   trades_per_year,
        "gross_return_pct":  gross,
        "net_return_pct":    net_return_pct,
        "cost_drag_pct":     drag,
        "cost_warnings":     warnings,
    }


# ─── Transaction Costs ────────────────────────────────────────────────────────

def _apply_costs(trades: list[dict], commission_pct: float, slippage_pct: float) -> list[dict]:
    total_cost_pct = (commission_pct + slippage_pct) * 2
    result = []
    for t in trades:
        gross = (t["exit_price"] - t["entry_price"]) / t["entry_price"] * 100
        net   = round(gross - total_cost_pct, 3)
        result.append({**t, "return_pct": net, "gross_return_pct": round(gross, 3),
                        "cost_pct": round(-total_cost_pct, 3)})
    return result


# ─── Trade Log & Equity Curve ─────────────────────────────────────────────────

def _build_trade_log(trades: list[dict], initial_capital: float) -> list[dict]:
    """Full per-trade log with holding days, running capital, cumulative return."""
    capital = initial_capital
    log = []
    for i, t in enumerate(trades):
        capital_before = capital
        capital *= (1 + t["return_pct"] / 100)
        cum_return = round((capital - initial_capital) / initial_capital * 100, 2)
        try:
            entry_dt     = datetime.fromisoformat(t["entry_date"].replace(" ", "T"))
            exit_dt      = datetime.fromisoformat(t["exit_date"].replace(" ", "T"))
            holding_days = max(1, (exit_dt - entry_dt).days)
        except Exception:
            holding_days = None
        log.append({
            "trade_no":              i + 1,
            "entry_date":            t["entry_date"],
            "entry_price":           t["entry_price"],
            "exit_date":             t["exit_date"],
            "exit_price":            t["exit_price"],
            "holding_days":          holding_days,
            "return_pct":            t["return_pct"],
            "gross_return_pct":      t.get("gross_return_pct", t["return_pct"]),
            "cost_pct":              t.get("cost_pct", 0),
            "capital_before":        round(capital_before, 2),
            "capital_after":         round(capital, 2),
            "cumulative_return_pct": cum_return,
        })
    return log


def _build_equity_curve(trades: list[dict], initial_capital: float) -> list[dict]:
    """Equity curve: capital + drawdown at each trade exit."""
    capital = initial_capital
    peak    = capital
    curve   = [{"date": "start", "equity": round(capital, 2), "drawdown_pct": 0.0}]
    for t in trades:
        capital *= (1 + t["return_pct"] / 100)
        peak     = max(peak, capital)
        dd       = round((peak - capital) / peak * 100, 2)
        curve.append({
            "date":         t["exit_date"],
            "equity":       round(capital, 2),
            "drawdown_pct": -dd,
        })
    return curve


# ─── Metrics ──────────────────────────────────────────────────────────────────

def _mark_to_market_equity(
    trades: list[dict], initial_capital: float, candles: list[dict],
) -> list[float]:
    """Per-BAR equity series: marks open positions to each bar's close.

    The old equity path updated only at trade exits, so a trade that rode a
    -40% dip before exiting at +2% showed near-zero drawdown (inflating
    Calmar), and Sharpe treated irregular per-trade returns as fixed-frequency
    periods. Equity is flat (cash) outside positions.
    """
    idx: dict[str, int] = {}
    for i, c in enumerate(candles):
        idx.setdefault(c["date"], i)

    spans = []
    for t in trades:
        ei, xi = idx.get(t["entry_date"]), idx.get(t["exit_date"])
        if ei is None or xi is None or xi < ei:
            continue
        spans.append((ei, xi, t))
    spans.sort(key=lambda s: s[0])

    equity = [float(initial_capital)] * len(candles)
    capital = float(initial_capital)
    cursor = 0
    for ei, xi, t in spans:
        for i in range(cursor, min(ei + 1, len(candles))):
            equity[i] = capital
        entry_capital = capital
        entry_price = t["entry_price"] or 1.0
        for i in range(ei + 1, xi):
            equity[i] = entry_capital * (candles[i]["close"] / entry_price)
        # Exit applies the trade's NET return (costs included) so the series
        # lands exactly on the compounded trade-level capital.
        capital = entry_capital * (1 + t["return_pct"] / 100)
        if xi < len(candles):
            equity[xi] = capital
        cursor = xi + 1
    for i in range(cursor, len(candles)):
        equity[i] = capital
    return equity


def _calc_metrics(
    trades: list[dict],
    initial_capital: float,
    interval: str = "1d",
    candles: Optional[list[dict]] = None,
    risk_free_rate: Optional[float] = None,
    periods_per_year: Optional[int] = None,
) -> dict:
    """Trade metrics. When `candles` is provided, drawdown/Calmar/Sharpe come
    from the per-bar mark-to-market equity series (intra-trade dips count and
    Sharpe annualizes actual bar-frequency returns); without candles (e.g.
    trades aggregated across walk-forward folds) it falls back to the
    per-trade approximation."""
    empty = {
        "total_trades": 0, "win_rate_pct": 0, "winning_trades": 0, "losing_trades": 0,
        "total_return_pct": 0, "final_capital": initial_capital,
        "avg_gain_pct": 0, "avg_loss_pct": 0, "max_drawdown_pct": 0,
        "profit_factor": 0, "sharpe_ratio": 0, "calmar_ratio": 0,
        "expectancy_pct": 0, "best_trade": None, "worst_trade": None,
    }
    if not trades:
        return empty

    winners = [t for t in trades if t["return_pct"] > 0]
    losers  = [t for t in trades if t["return_pct"] <= 0]

    capital = initial_capital
    for t in trades:
        capital *= (1 + t["return_pct"] / 100)

    if candles:
        equity = _mark_to_market_equity(trades, initial_capital, candles)
        returns = [
            equity[i] / equity[i - 1] - 1
            for i in range(1, len(equity))
            if equity[i - 1] > 0
        ]
    else:
        equity = []
        running = initial_capital
        for t in trades:
            running *= (1 + t["return_pct"] / 100)
            equity.append(running)
        returns = [t["return_pct"] / 100 for t in trades]

    peak = initial_capital
    max_dd = 0.0
    for v in equity:
        peak = max(peak, v)
        max_dd = max(max_dd, (peak - v) / peak * 100)

    total_return  = (capital - initial_capital) / initial_capital * 100
    avg_gain      = sum(t["return_pct"] for t in winners) / len(winners) if winners else 0
    avg_loss      = sum(t["return_pct"] for t in losers)  / len(losers)  if losers  else 0
    gp            = sum(t["return_pct"] for t in winners)
    gl            = abs(sum(t["return_pct"] for t in losers))
    profit_factor = round(gp / gl, 2) if gl > 0 else float("inf")

    ann = periods_per_year or _ANNUALIZATION.get(interval, 252)
    rf  = _DEFAULT_RISK_FREE if risk_free_rate is None else risk_free_rate
    sharpe = 0.0
    if len(returns) > 1:
        mean_r = statistics.mean(returns)
        std_r  = statistics.stdev(returns)
        if std_r > 0:
            sharpe = round((mean_r - rf / ann) / std_r * math.sqrt(ann), 2)

    calmar = round(total_return / max_dd, 2) if max_dd > 0 else 0.0

    wr         = len(winners) / len(trades)
    expectancy = round(wr * avg_gain + (1 - wr) * avg_loss, 2)
    best       = max(trades, key=lambda t: t["return_pct"])
    worst      = min(trades, key=lambda t: t["return_pct"])

    return {
        "total_trades":     len(trades),
        "winning_trades":   len(winners),
        "losing_trades":    len(losers),
        "win_rate_pct":     round(wr * 100, 1),
        "final_capital":    round(capital, 2),
        "total_return_pct": round(total_return, 2),
        "avg_gain_pct":     round(avg_gain, 2),
        "avg_loss_pct":     round(avg_loss, 2),
        "max_drawdown_pct": round(-max_dd, 2),
        "profit_factor":    profit_factor,
        "sharpe_ratio":     sharpe,
        "sharpe_risk_free_pct":     round(rf * 100, 2),
        "sharpe_periods_per_year":  ann,
        "calmar_ratio":     calmar,
        "expectancy_pct":   expectancy,
        "best_trade":       {k: best[k]  for k in ("entry_date", "exit_date", "return_pct")},
        "worst_trade":      {k: worst[k] for k in ("entry_date", "exit_date", "return_pct")},
    }


def _buy_and_hold_return(
    candles: list[dict],
    commission_pct: float = 0.0,
    slippage_pct: float = 0.0,
) -> float:
    """Benchmark return. Pass the strategy's costs so the comparison is fair —
    the cost-free benchmark gave buy-and-hold a structural edge in
    vs_buy_and_hold_pct (one round trip of the same commission+slippage)."""
    if len(candles) < 2:
        return 0.0
    gross = (candles[-1]["close"] - candles[0]["close"]) / candles[0]["close"] * 100
    return round(gross - (commission_pct + slippage_pct) * 2, 2)


# ─── Numeric input validation ─────────────────────────────────────────────────

# Commission and slippage are per-trade percentages. 100% per side is already
# absurd, so the cap simply rejects grossly out-of-range inputs (e.g. a value
# passed in basis points, 250, instead of as a percent, 2.5) before they
# silently corrupt results.
_MAX_COST_PCT = 100.0


def _validate_numeric_inputs(
    initial_capital: float,
    commission_pct: float,
    slippage_pct: float,
) -> Optional[str]:
    """Return an error message if a capital/cost input is out of range, else None.

    Follows the same structured-error convention as the strategy/period checks:
    callers return ``{"error": msg}`` rather than raising. Without this, two
    silent-corruption paths are reachable from the public tools:

      * ``initial_capital <= 0`` → division by initial_capital in the trade log,
        equity curve, and metrics (0 raises ZeroDivisionError; negative flips the
        sign of every return).
      * negative ``commission_pct``/``slippage_pct`` → costs become a *credit*,
        silently inflating every trade's net return above its gross.
    """
    if initial_capital <= 0:
        return f"initial_capital must be positive, got {initial_capital}"
    if not (0 <= commission_pct <= _MAX_COST_PCT):
        return f"commission_pct must be between 0 and {_MAX_COST_PCT}, got {commission_pct}"
    if not (0 <= slippage_pct <= _MAX_COST_PCT):
        return f"slippage_pct must be between 0 and {_MAX_COST_PCT}, got {slippage_pct}"
    return None


# ─── Public API: run_backtest ─────────────────────────────────────────────────

def run_backtest(
    symbol: str,
    strategy: str,
    period: str = "1y",
    initial_capital: float = 10_000.0,
    commission_pct: float = 0.1,
    slippage_pct: float = 0.05,
    interval: str = "1d",
    include_trade_log: bool = False,
    include_equity_curve: bool = False,
    risk_free_rate: Optional[float] = None,
    periods_per_year: Optional[int] = None,
    data_source: str = "yahoo",
    tv_symbol: Optional[str] = None,
    params: Optional[dict] = None,
    fill: str = "signal_close",
    cost_profile: Optional[str] = None,
) -> dict:
    strategy = strategy.lower().strip()
    period   = period.lower().strip()
    interval = interval.lower().strip()
    data_source, tv_symbol = _normalize_source(data_source, tv_symbol)

    if strategy not in _STRATEGY_MAP:
        return {"error": f"Unknown strategy '{strategy}'. Choose: {', '.join(_STRATEGY_MAP)}"}
    src_err = _check_data_source(data_source)
    if src_err:
        return {"error": src_err}
    pi_err = _check_period_interval(period, interval, data_source, tv_symbol)
    if pi_err:
        return {"error": pi_err}

    # A named cost profile wins over commission_pct / slippage_pct when given.
    profile_name = None
    if cost_profile is not None:
        profile_name = cost_profile.strip().lower()
        if profile_name not in COST_PROFILES:
            return {"error": f"Unknown cost_profile '{cost_profile}'. Choose: {', '.join(COST_PROFILES)}"}
        commission_pct = COST_PROFILES[profile_name]["commission_pct"]
        slippage_pct = COST_PROFILES[profile_name]["slippage_pct"]

    num_err = _validate_numeric_inputs(initial_capital, commission_pct, slippage_pct)
    if num_err:
        return {"error": num_err}

    if fill not in _FILLS:
        return {"error": f"Invalid fill '{fill}'. Choose: {', '.join(_FILLS)}"}
    try:
        resolve_params(strategy, params)
    except ValueError as e:
        return {"error": str(e)}

    try:
        candles, source_meta = _load_candles(symbol, period, interval, data_source, tv_symbol)
    except Exception as e:
        return {"error": f"Failed to fetch data for '{symbol}': {e}"}

    min_bars = 30 if interval == "1d" else 100
    if len(candles) < min_bars:
        return {"error": f"Not enough data ({len(candles)} bars). Try a longer period."}

    if strategy in _SMA200_STRATEGIES and len(candles) < _SMA200_MIN_BARS:
        return {"error": (f"Strategy '{strategy}' needs ≥{_SMA200_MIN_BARS} bars "
                          f"(SMA200 warmup); got {len(candles)}. "
                          f"Use period='1y' or '2y'.")}

    ppy = periods_per_year
    if data_source == "tradingview" and periods_per_year is None:
        ppy = tv_periods_per_year(tv_symbol, interval)

    sim     = _simulate(candles, strategy, params=params, commission_pct=commission_pct,
                        slippage_pct=slippage_pct, fill=fill, interval=interval,
                        periods_per_year=ppy, risk_free_rate=risk_free_rate,
                        initial_capital=initial_capital)
    trades, metrics, bnh = sim["trades"], sim["metrics"], sim["bnh"]

    result = {
        "symbol":                  symbol.upper(),
        "strategy":                strategy,
        "strategy_label":          _STRATEGY_LABELS[strategy],
        "period":                  period,
        "interval":                interval,
        "timeframe":               _TIMEFRAME_LABELS[interval],
        "candles_analyzed":        len(candles),
        "date_from":               candles[0]["date"],
        "date_to":                 candles[-1]["date"],
        "initial_capital":         round(initial_capital, 2),
        "commission_pct":          commission_pct,
        "slippage_pct":            slippage_pct,
        **metrics,
        "buy_and_hold_return_pct": bnh,
        "vs_buy_and_hold_pct":     round(metrics["total_return_pct"] - bnh, 2),
        "recent_trades":           [_public_trade(t) for t in trades[-5:]],
        "data_source":             source_meta.get("data_source", "Yahoo Finance"),
        "disclaimer":              "Past performance does not guarantee future results. For educational use only.",
        "timestamp":               datetime.now(timezone.utc).isoformat(),
    }
    # Optional inputs appear in the result only when the caller used them.
    if params is not None:
        result["params"] = sim["params"]
    if fill != "signal_close":
        result["fill"] = fill
    if profile_name is not None:
        result["cost_profile"] = profile_name
    ann = ppy or _ANNUALIZATION.get(interval, 252)
    result.update(_cost_summary(trades, initial_capital, len(candles), ann,
                                metrics["total_return_pct"]))
    result["tradability"] = _tradability(candles, interval)

    if data_source == "tradingview":
        result["tv_symbol"] = tv_symbol
        if source_meta["truncated"]:
            result["truncated"] = True
            result["note"] = _truncation_note(period, source_meta)

    if include_trade_log:
        result["trade_log"] = _build_trade_log(trades, initial_capital)

    if include_equity_curve:
        result["equity_curve"] = _build_equity_curve(trades, initial_capital)

    return result


# ─── Public API: compare_strategies ──────────────────────────────────────────

def compare_strategies(
    symbol: str,
    period: str = "1y",
    initial_capital: float = 10_000.0,
    commission_pct: float = 0.1,
    slippage_pct: float = 0.05,
    interval: str = "1d",
    risk_free_rate: Optional[float] = None,
    periods_per_year: Optional[int] = None,
    data_source: str = "yahoo",
    tv_symbol: Optional[str] = None,
) -> dict:
    """Run all 9 strategies on one symbol. Supports 1d and 1h intervals (and 15m and 4h
    with data_source="tradingview")."""
    period   = period.lower().strip()
    interval = interval.lower().strip()
    data_source, tv_symbol = _normalize_source(data_source, tv_symbol)
    src_err = _check_data_source(data_source)
    if src_err:
        return {"error": src_err}
    pi_err = _check_period_interval(period, interval, data_source, tv_symbol)
    if pi_err:
        return {"error": pi_err}

    num_err = _validate_numeric_inputs(initial_capital, commission_pct, slippage_pct)
    if num_err:
        return {"error": num_err}

    try:
        candles, source_meta = _load_candles(symbol, period, interval, data_source, tv_symbol)
    except Exception as e:
        return {"error": f"Failed to fetch data for '{symbol}': {e}"}

    min_bars = 30 if interval == "1d" else 100
    if len(candles) < min_bars:
        return {"error": f"Not enough data ({len(candles)} bars)."}

    sma200_ok = len(candles) >= _SMA200_MIN_BARS

    ppy = periods_per_year
    if data_source == "tradingview" and periods_per_year is None:
        ppy = tv_periods_per_year(tv_symbol, interval)

    results = []
    for strat, fn in _STRATEGY_MAP.items():
        raw    = fn(candles)
        trades = _apply_costs(raw, commission_pct, slippage_pct)
        m      = _calc_metrics(trades, initial_capital, interval, candles=candles,
                               risk_free_rate=risk_free_rate, periods_per_year=ppy)
        results.append({
            "strategy":         strat,
            "strategy_label":   _STRATEGY_LABELS[strat],
            "total_return_pct": m["total_return_pct"],
            "win_rate_pct":     m["win_rate_pct"],
            "total_trades":     m["total_trades"],
            "profit_factor":    m["profit_factor"],
            "sharpe_ratio":     m["sharpe_ratio"],
            "calmar_ratio":     m["calmar_ratio"],
            "max_drawdown_pct": m["max_drawdown_pct"],
            "expectancy_pct":   m["expectancy_pct"],
        })

    results.sort(key=lambda x: x["total_return_pct"], reverse=True)
    for i, r in enumerate(results):
        r["rank"] = i + 1

    bnh = _buy_and_hold_return(candles, commission_pct, slippage_pct)

    warnings = None
    if not sma200_ok:
        warnings = (f"Strategies {sorted(_SMA200_STRATEGIES)} need ≥{_SMA200_MIN_BARS} "
                    f"bars (use period='1y' or '2y') to produce signals; "
                    f"their zero-trade results below are not meaningful.")

    out = {
        "symbol":                  symbol.upper(),
        "period":                  period,
        "interval":                interval,
        "timeframe":               _TIMEFRAME_LABELS[interval],
        "candles_analyzed":        len(candles),
        "date_from":               candles[0]["date"],
        "date_to":                 candles[-1]["date"],
        "initial_capital":         round(initial_capital, 2),
        "commission_pct":          commission_pct,
        "slippage_pct":            slippage_pct,
        "buy_and_hold_return_pct": bnh,
        "winner":                  results[0]["strategy"] if results else None,
        "ranking":                 results,
        "warnings":                warnings,
        "multiple_testing_warning": MULTIPLE_TESTING_WARNING,
        "disclaimer":              "Past performance does not guarantee future results.",
        "timestamp":               datetime.now(timezone.utc).isoformat(),
    }
    # Yahoo output keeps its existing keys; the source is added only for TradingView.
    if data_source == "tradingview":
        out["data_source"] = source_meta["data_source"]
        out["tv_symbol"] = tv_symbol
        if source_meta["truncated"]:
            out["truncated"] = True
            out["note"] = _truncation_note(period, source_meta)
    return out


# ─── Public API: walk_forward_backtest ────────────────────────────────────────

def _walk_forward_on_candles(
    candles: list[dict],
    strategy: str,
    *,
    initial_capital: float = 10_000.0,
    commission_pct: float = 0.1,
    slippage_pct: float = 0.05,
    n_splits: int = 3,
    train_ratio: float = 0.7,
    interval: str = "1d",
    risk_free_rate: Optional[float] = None,
    periods_per_year: Optional[int] = None,
    params: Optional[dict] = None,
    fill: str = "signal_close",
) -> dict:
    """Folds, averages and verdict for candles that are already fetched (no network).

    Returns ``{"error": ...}`` on failure, otherwise the walk-forward fields that
    walk_forward_backtest reports. Callers validate n_splits, train_ratio and params.
    """
    resolved    = resolve_params(strategy, params)
    fold_size   = len(candles) // n_splits
    warmup_bars = _STRATEGY_WARMUP_BARS.get(strategy, 20)

    folds: list[dict]   = []
    all_test_trades: list[dict] = []
    insufficient_folds = 0

    for fold_i in range(n_splits):
        start  = fold_i * fold_size
        end    = (start + fold_size) if fold_i < n_splits - 1 else len(candles)
        window = candles[start:end]
        split  = int(len(window) * train_ratio)

        train_c = window[:split]
        test_c  = window[split:]

        if len(train_c) < 20 or len(test_c) < 5:
            continue

        # A test slice too short for the strategy's slowest indicator can
        # never trade — recording fold_rob=0.0 would falsely count it as
        # out-of-sample failure. Mark it and exclude it from the average.
        insufficient = len(test_c) < warmup_bars + 5

        train_t = _apply_costs(_trades_for(train_c, strategy, resolved, fill), commission_pct, slippage_pct)
        test_t  = _apply_costs(_trades_for(test_c, strategy, resolved, fill),  commission_pct, slippage_pct)
        train_m = _calc_metrics(train_t, initial_capital, interval, candles=train_c,
                                risk_free_rate=risk_free_rate, periods_per_year=periods_per_year)
        test_m  = _calc_metrics(test_t,  initial_capital, interval, candles=test_c,
                                risk_free_rate=risk_free_rate, periods_per_year=periods_per_year)

        all_test_trades.extend(test_t)

        tr, te = train_m["total_return_pct"], test_m["total_return_pct"]
        if insufficient:
            fold_rob = None
            insufficient_folds += 1
        elif tr == 0:
            fold_rob = 1.0 if te == 0 else 0.0
        elif tr < 0 and te < 0:
            # Both windows lost money: robustness = did the test lose LESS?
            # tr/te > 1 when the test loss is smaller than the train loss.
            # (The old te/tr rewarded losing MORE out-of-sample: train -1%,
            # test -2% scored a capped 2.0 — "maximally robust".)
            fold_rob = round(max(min(tr / te, 2.0), 0.0), 2)
        elif tr < 0:
            fold_rob = 0.0
        else:
            fold_rob = round(max(min(te / tr, 2.0), -1.0), 2)

        folds.append({
            "fold":                  fold_i + 1,
            "train_from":            train_c[0]["date"],
            "train_to":              train_c[-1]["date"],
            "train_candles":         len(train_c),
            "train_return_pct":      train_m["total_return_pct"],
            "train_trades":          train_m["total_trades"],
            "train_sharpe":          train_m["sharpe_ratio"],
            "test_from":             test_c[0]["date"],
            "test_to":               test_c[-1]["date"],
            "test_candles":          len(test_c),
            "test_return_pct":       test_m["total_return_pct"],
            "test_trades":           test_m["total_trades"],
            "test_sharpe":           test_m["sharpe_ratio"],
            "fold_robustness_score": fold_rob,
            "insufficient_data":     insufficient,
        })

    if not folds:
        return {"error": "Could not generate any valid folds. Try a longer period or fewer splits."}

    scored_folds = [f for f in folds if not f["insufficient_data"]]
    if not scored_folds:
        return {"error": (f"Every test window is shorter than the ~{warmup_bars}-bar "
                          f"warmup '{strategy}' needs to trade at all. Use a longer "
                          f"period or fewer splits."), "folds": folds}

    avg_train  = round(statistics.mean(f["train_return_pct"] for f in scored_folds), 2)
    avg_test   = round(statistics.mean(f["test_return_pct"]  for f in scored_folds), 2)
    avg_robust = round(statistics.mean(f["fold_robustness_score"] for f in scored_folds), 2)
    oos_m      = _calc_metrics(all_test_trades, initial_capital, interval,
                               risk_free_rate=risk_free_rate, periods_per_year=periods_per_year)

    if avg_robust >= 0.8:
        verdict = "ROBUST — strategy performs consistently in-sample and out-of-sample"
    elif avg_robust >= 0.5:
        verdict = "MODERATE — some degradation out-of-sample, use with caution"
    elif avg_robust >= 0.2:
        verdict = "WEAK — significant out-of-sample degradation, likely overfitted"
    else:
        verdict = "OVERFITTED — strategy fails out-of-sample, do not trade live"

    return {
        "folds":               folds,
        "scored_folds":        len(scored_folds),
        "insufficient_folds":  insufficient_folds,
        "avg_train":           avg_train,
        "avg_test":            avg_test,
        "avg_robust":          avg_robust,
        "oos_m":               oos_m,
        "verdict":             verdict,
        "warmup_bars":         warmup_bars,
    }


def walk_forward_backtest(
    symbol: str,
    strategy: str,
    period: str = "2y",
    initial_capital: float = 10_000.0,
    commission_pct: float = 0.1,
    slippage_pct: float = 0.05,
    n_splits: int = 3,
    train_ratio: float = 0.7,
    interval: str = "1d",
    risk_free_rate: Optional[float] = None,
    periods_per_year: Optional[int] = None,
    data_source: str = "yahoo",
    tv_symbol: Optional[str] = None,
    params: Optional[dict] = None,
    fill: str = "signal_close",
) -> dict:
    """
    Walk-forward backtesting — detect overfitting via train/test splits.

    Splits full history into n_splits folds. Each fold:
      - Train (70%): in-sample strategy simulation
      - Test  (30%): out-of-sample forward validation

    Robustness score (test_return / train_return; train/test when both are
    negative, so losing LESS out-of-sample scores higher):
      >= 0.8  → ROBUST    (no overfitting)
      >= 0.5  → MODERATE  (some degradation)
      >= 0.2  → WEAK      (likely overfitted)
      < 0.2   → OVERFITTED (do not trade live)

    Folds whose test slice is shorter than the strategy's indicator warmup
    are flagged ``insufficient_data`` and excluded from the average — a
    window too small to trade is not evidence of out-of-sample failure.
    """
    strategy = strategy.lower().strip()
    period   = period.lower().strip()
    interval = interval.lower().strip()
    data_source, tv_symbol = _normalize_source(data_source, tv_symbol)

    if strategy not in _STRATEGY_MAP:
        return {"error": f"Unknown strategy '{strategy}'. Choose: {', '.join(_STRATEGY_MAP)}"}
    src_err = _check_data_source(data_source)
    if src_err:
        return {"error": src_err}
    pi_err = _check_period_interval(period, interval, data_source, tv_symbol)
    if pi_err:
        return {"error": pi_err}
    if not (2 <= n_splits <= 10):
        return {"error": "n_splits must be between 2 and 10"}
    if not (0.5 <= train_ratio <= 0.9):
        return {"error": "train_ratio must be between 0.5 and 0.9"}
    if strategy in _SMA200_STRATEGIES:
        return {"error": (f"Strategy '{strategy}' requires SMA200 warmup "
                          f"(~{_SMA200_MIN_BARS} bars) which exceeds typical "
                          f"walk-forward fold sizes. Use run_backtest with "
                          f"period='2y' instead, or pick a shorter-warmup strategy.")}
    if fill not in _FILLS:
        return {"error": f"Invalid fill '{fill}'. Choose: {', '.join(_FILLS)}"}
    try:
        resolved = resolve_params(strategy, params)
    except ValueError as e:
        return {"error": str(e)}

    num_err = _validate_numeric_inputs(initial_capital, commission_pct, slippage_pct)
    if num_err:
        return {"error": num_err}

    try:
        candles, source_meta = _load_candles(symbol, period, interval, data_source, tv_symbol)
    except Exception as e:
        return {"error": f"Failed to fetch data for '{symbol}': {e}"}

    min_bars = max(60, n_splits * 20)
    if len(candles) < min_bars:
        return {"error": f"Not enough data ({len(candles)} bars) for {n_splits} splits. Try longer period."}

    ppy = periods_per_year
    if data_source == "tradingview" and periods_per_year is None:
        ppy = tv_periods_per_year(tv_symbol, interval)

    wf = _walk_forward_on_candles(
        candles, strategy, initial_capital=initial_capital, commission_pct=commission_pct,
        slippage_pct=slippage_pct, n_splits=n_splits, train_ratio=train_ratio, interval=interval,
        risk_free_rate=risk_free_rate, periods_per_year=ppy, params=params, fill=fill,
    )
    if "error" in wf:
        return wf
    oos_m = wf["oos_m"]

    out = {
        "symbol":                  symbol.upper(),
        "strategy":                strategy,
        "strategy_label":          _STRATEGY_LABELS[strategy],
        "period":                  period,
        "interval":                interval,
        "timeframe":               _TIMEFRAME_LABELS[interval],
        "total_candles":           len(candles),
        "n_splits":                n_splits,
        "train_ratio":             train_ratio,
        "date_from":               candles[0]["date"],
        "date_to":                 candles[-1]["date"],
        "avg_train_return_pct":    wf["avg_train"],
        "avg_test_return_pct":     wf["avg_test"],
        "robustness_score":        wf["avg_robust"],
        "scored_folds":            wf["scored_folds"],
        "insufficient_data_folds": wf["insufficient_folds"],
        "verdict":                 wf["verdict"],
        "caveat": ("No parameters are optimised on the train window (fixed "
                   "defaults run on both slices), so this score measures "
                   "regime consistency across windows, not parameter "
                   "overfitting in the classical sense."),
        "oos_total_trades":        oos_m["total_trades"],
        "oos_win_rate_pct":        oos_m["win_rate_pct"],
        "oos_sharpe_ratio":        oos_m["sharpe_ratio"],
        "oos_max_drawdown_pct":    oos_m["max_drawdown_pct"],
        "oos_total_return_pct":    oos_m["total_return_pct"],
        "buy_and_hold_return_pct": _buy_and_hold_return(candles, commission_pct, slippage_pct),
        "folds":                   wf["folds"],
        "initial_capital":         round(initial_capital, 2),
        "commission_pct":          commission_pct,
        "slippage_pct":            slippage_pct,
        "data_source":             source_meta.get("data_source", "Yahoo Finance"),
        "disclaimer":              "Past performance does not guarantee future results. For educational use only.",
        "timestamp":               datetime.now(timezone.utc).isoformat(),
    }
    if params is not None:
        out["params"] = resolved
    if fill != "signal_close":
        out["fill"] = fill
    if data_source == "tradingview":
        out["tv_symbol"] = tv_symbol
        if source_meta["truncated"]:
            out["truncated"] = True
            out["note"] = _truncation_note(period, source_meta)
    return out
