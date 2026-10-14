"""
@pyne

A minimal EMA-cross strategy for the gauntlet: buy when the fast EMA crosses above the slow one, sell when it
crosses back. Long only.

Use it:
    mkdir -p ~/.tradingview-mcp/strategies
    cp docs/examples/pine/ema_cross.py ~/.tradingview-mcp/strategies/
    # then call strategy_gauntlet with strategy="pine:ema_cross"

Running a Pyne script runs Python code with your rights: only use scripts you wrote or have read.
"""
from pynecore.lib import close, input, script, strategy, ta


@script.strategy("EMA cross", overlay=True)
def main(
    fast=input.int(9, "Fast", minval=2, maxval=50),
    slow=input.int(21, "Slow", minval=3, maxval=200),
):
    fast_ema = ta.ema(close, fast)
    slow_ema = ta.ema(close, slow)
    # Size explicitly. With no qty the default is 100% of equity, and an order that does not fit the
    # margin rules is dropped silently (the script then shows no trades at all).
    if ta.crossover(fast_ema, slow_ema):
        strategy.entry("long", strategy.long, qty=1)
    if ta.crossunder(fast_ema, slow_ema):
        strategy.close("long")
