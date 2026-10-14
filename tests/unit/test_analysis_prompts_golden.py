"""Golden text of the ten analysis prompts rendered with their defaults.

Adham's wording (Appendix A of the N0 plan) and the tool guidance must not change by accident.
A deliberate edit: run `UPDATE_GOLDEN=1 pytest tests/unit/test_analysis_prompts_golden.py`,
read the diff of the fixture, and commit it with the prompt change.
"""

import asyncio
import json
import os
from pathlib import Path

from tradingview_mcp.server import mcp

GOLDEN = Path(__file__).parent / "fixtures" / "analysis_prompts_golden.json"
NAMES = [
    "business_analysis", "financial_trends", "earnings_and_call", "fair_value", "stock_comparison",
    "catalysts_and_risks", "bull_base_bear", "technical_analysis", "investment_decision_checklist",
    "portfolio_risk_review",
]


def _render_defaults():
    out = {}
    for name in NAMES:
        result = asyncio.run(mcp.get_prompt(name, {}))
        out[name] = "\n".join(m.content.text for m in result.messages)
    return out


def test_default_renderings_match_golden_text():
    rendered = _render_defaults()
    if os.environ.get("UPDATE_GOLDEN") == "1":
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(json.dumps(rendered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert sorted(golden) == sorted(NAMES)
    for name in NAMES:
        assert rendered[name] == golden[name], f"{name} changed; see the docstring to update on purpose"
