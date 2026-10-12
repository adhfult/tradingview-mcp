"""tradingview-mcp-paper: run a gauntlet-passed strategy on live candles, hypothetical trades only.

It never places an order and never talks to a broker or exchange. See the README, "Paper trading".
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading
import time

from tradingview_mcp.core.services import paper_service as ps
from tradingview_mcp.core.services.tv_bridge_client import BridgeError, get_client
from tradingview_mcp.core.services.tv_data_service import bridge_error_message


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tradingview-mcp-paper",
        description="Paper trade a strategy that passed the gauntlet. Hypothetical trades only: no orders, ever.")
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--report", metavar="FINGERPRINT", help="a stored gauntlet report to follow")
    which.add_argument("--latest-pass", nargs=2, metavar=("STRATEGY", "TV_SYMBOL"),
                       help="the newest passing gauntlet run for this strategy and TradingView symbol")
    parser.add_argument("--once", action="store_true", help="process the latest closed bar once, then exit")
    parser.add_argument("--dry-run", action="store_true", help="print notifications instead of sending them")
    return parser


def main(argv=None, *, client=None, clock=None) -> int:
    """`client` and `clock` exist so tests can pass fakes; the command line never sets them."""
    args = _parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        plan = ps.load_plan(ps.resolve_fingerprint(args.report, args.latest_pass))
        ps.resolve_timezone(os.environ)
    except ps.PaperRefusal as err:
        print(f"paper: refused: {err}", file=sys.stderr)
        return 2
    client = client or get_client()
    clock = clock or time.time

    if args.once:
        try:
            events = ps.process_once(plan, client=client, now=clock(), dry_run=args.dry_run)
        except BridgeError as err:
            print(f"paper: {bridge_error_message(err)}", file=sys.stderr)
            return 1
        print(f"paper: {len(events)} new hypothetical event(s)")
        return 0

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())              # finish the current step, then exit 0
    ps.run_loop(plan, client=client, clock=clock, sleep=stop.wait, stop=stop, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
