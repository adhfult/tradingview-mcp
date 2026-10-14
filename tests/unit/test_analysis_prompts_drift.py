"""Keep analysis prompt tool references aligned with this server and N0b."""

import asyncio
import re
from pathlib import Path

import pytest

from tradingview_mcp.server import mcp


ANALYSIS_PROMPT_NAMES = (
    "business_analysis",
    "financial_trends",
    "earnings_and_call",
    "fair_value",
    "stock_comparison",
    "catalysts_and_risks",
    "bull_base_bear",
    "technical_analysis",
    "investment_decision_checklist",
    "portfolio_risk_review",
)

TOOL_LIKE_TOKEN_RE = re.compile(
    r"\b(?:openbb:|alphadesk:)?[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b"
)

# No current default contains a false-positive underscore phrase. If one is
# added later, give each exception a one-line reason here.
NON_TOOL_TOKEN_ALLOWLIST: dict[str, str] = {}


def _n0b_tool_names(prefix: str) -> set[str]:
    repo_root = Path(__file__).resolve().parents[2]
    names_file = repo_root / "docs" / "handoffs" / "n0b-tool-names.txt"
    return {
        line.strip()
        for line in names_file.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith(prefix)
    }


def _analysis_argument_names() -> set[str]:
    prompts = asyncio.run(mcp.list_prompts())
    return {
        argument.name
        for prompt in prompts
        if prompt.name in ANALYSIS_PROMPT_NAMES
        for argument in prompt.arguments
    }


def _unregistered_tool_tokens(prompt_text: str) -> set[str]:
    """Return snake_case mentions that are not registered tools or N0b OpenBB tools."""
    registered_tool_names = {tool.name for tool in mcp._tool_manager.list_tools()}
    openbb_tool_names = _n0b_tool_names("openbb:")
    argument_names = _analysis_argument_names()
    unregistered = set()

    for token in TOOL_LIKE_TOKEN_RE.findall(prompt_text):
        if token in NON_TOOL_TOKEN_ALLOWLIST or token in argument_names:
            continue
        if token.startswith("openbb:"):
            if token not in openbb_tool_names:
                unregistered.add(token)
        elif token.startswith("alphadesk:") or token not in registered_tool_names:
            unregistered.add(token)

    return unregistered


def _render_default_prompt(name: str) -> str:
    result = asyncio.run(mcp.get_prompt(name))
    assert len(result.messages) == 1
    return result.messages[0].content.text


@pytest.fixture(scope="module")
def analysis_prompt_texts() -> dict[str, str]:
    registered_prompts = {prompt.name for prompt in asyncio.run(mcp.list_prompts())}
    missing_prompts = sorted(set(ANALYSIS_PROMPT_NAMES) - registered_prompts)
    assert not missing_prompts, f"analysis prompts not registered: {missing_prompts}"
    return {name: _render_default_prompt(name) for name in ANALYSIS_PROMPT_NAMES}


def test_analysis_prompt_tool_mentions_are_registered_or_listed_in_n0b(
    analysis_prompt_texts: dict[str, str],
) -> None:
    unresolved = {
        name: sorted(tokens)
        for name, text in analysis_prompt_texts.items()
        if (tokens := _unregistered_tool_tokens(text))
    }
    assert not unresolved, f"unregistered tool-like prompt mentions: {unresolved}"


def test_analysis_prompts_do_not_mention_alphadesk_tools(
    analysis_prompt_texts: dict[str, str],
) -> None:
    alphadesk_tool_names = _n0b_tool_names("alphadesk:")
    mentions = {
        name: sorted(
            tool_name
            for tool_name in alphadesk_tool_names
            if tool_name in text
        )
        for name, text in analysis_prompt_texts.items()
    }
    namespace_mentions = {
        name: sorted(set(re.findall(r"\balphadesk:[A-Za-z0-9_]+\b", text)))
        for name, text in analysis_prompt_texts.items()
    }
    namespace_mentions = {
        name: tokens for name, tokens in namespace_mentions.items() if tokens
    }
    mentions = {name: tools for name, tools in mentions.items() if tools}
    assert not mentions and not namespace_mentions, (
        f"AlphaDesk tool references found: {mentions or namespace_mentions}"
    )


def test_tool_token_check_reports_a_renamed_real_tool(
    analysis_prompt_texts: dict[str, str],
) -> None:
    prompt_text = analysis_prompt_texts["financial_trends"]
    original_name = "openbb:sec_income_statement"
    renamed_name = "openbb:sec_income_statementt"
    assert original_name in prompt_text

    mutated_prompt_text = prompt_text.replace(original_name, renamed_name, 1)

    assert _unregistered_tool_tokens(mutated_prompt_text) == {renamed_name}
