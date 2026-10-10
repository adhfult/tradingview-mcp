"""Tests for the repo-root .env loader (stdlib only, no real .env is read)."""
from __future__ import annotations

import os
from pathlib import Path

from tradingview_mcp.core.utils import env_file
from tradingview_mcp.core.utils.env_file import load_env_file, load_env_file_once

REPO_ROOT = Path(__file__).resolve().parents[2]


def _isolate(monkeypatch, *names: str) -> None:
    """Make the names absent now, and absent again after the test."""
    for name in names:
        monkeypatch.setenv(name, "placeholder")
        monkeypatch.delenv(name)


def test_parses_comments_export_quotes_and_skips_bad_lines(tmp_path, monkeypatch):
    names = ["FAKE_PLAIN", "FAKE_EXPORTED", "FAKE_DOUBLE", "FAKE_SINGLE", "FAKE_SPACED"]
    _isolate(monkeypatch, "1BAD_KEY", "NO_EQUALS_SIGN", *names)
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "# a comment\n"
        "\n"
        "FAKE_PLAIN=plain-value\n"
        "export FAKE_EXPORTED=exported-value\n"
        'FAKE_DOUBLE="double quoted"\n'
        "FAKE_SINGLE='single quoted'\n"
        "  FAKE_SPACED = spaced-value  \n"
        "1BAD_KEY=nope\n"
        "NO_EQUALS_SIGN\n"
        "    # indented comment\n",
        encoding="utf-8",
    )

    loaded = load_env_file(dotenv)

    assert sorted(loaded) == sorted(names)
    assert os.environ["FAKE_PLAIN"] == "plain-value"
    assert os.environ["FAKE_EXPORTED"] == "exported-value"
    assert os.environ["FAKE_DOUBLE"] == "double quoted"
    assert os.environ["FAKE_SINGLE"] == "single quoted"
    assert os.environ["FAKE_SPACED"] == "spaced-value"
    assert "1BAD_KEY" not in os.environ


def test_never_overrides_existing_variables(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_KEEP", "from-process")
    _isolate(monkeypatch, "FAKE_NEW")
    dotenv = tmp_path / ".env"
    dotenv.write_text("FAKE_KEEP=from-file\nFAKE_NEW=new-value\n", encoding="utf-8")

    loaded = load_env_file(dotenv)

    assert os.environ["FAKE_KEEP"] == "from-process"
    assert os.environ["FAKE_NEW"] == "new-value"
    assert loaded == ["FAKE_NEW"]


def test_no_dotenv_flag_skips_loading(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_SKIPPED")
    monkeypatch.setenv("TRADINGVIEW_MCP_NO_DOTENV", "1")
    dotenv = tmp_path / ".env"
    dotenv.write_text("FAKE_SKIPPED=x\n", encoding="utf-8")

    assert load_env_file(dotenv) == []
    assert "FAKE_SKIPPED" not in os.environ


def test_other_flag_values_do_not_skip_loading(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_NOT_SKIPPED")
    monkeypatch.setenv("TRADINGVIEW_MCP_NO_DOTENV", "0")
    dotenv = tmp_path / ".env"
    dotenv.write_text("FAKE_NOT_SKIPPED=x\n", encoding="utf-8")

    assert load_env_file(dotenv) == ["FAKE_NOT_SKIPPED"]


def test_missing_file_is_fine(tmp_path, monkeypatch):
    monkeypatch.delenv("TRADINGVIEW_MCP_NO_DOTENV", raising=False)

    assert load_env_file(tmp_path / "absent.env") == []


def test_returns_names_only_never_values(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_SECRET_NAME")
    dotenv = tmp_path / ".env"
    dotenv.write_text("FAKE_SECRET_NAME=fake-session-123\n", encoding="utf-8")

    loaded = load_env_file(dotenv)

    assert loaded == ["FAKE_SECRET_NAME"]
    assert "fake-session-123" not in repr(loaded)
    assert os.environ["FAKE_SECRET_NAME"] == "fake-session-123"


def test_default_path_is_the_repo_root_dotenv():
    assert env_file.DEFAULT_ENV_PATH == REPO_ROOT / ".env"
    assert (env_file.DEFAULT_ENV_PATH.parent / "pyproject.toml").is_file()


def test_load_env_file_once_runs_only_once(monkeypatch):
    calls = []
    monkeypatch.setattr(env_file, "_once_done", False)
    monkeypatch.setattr(env_file, "load_env_file", lambda path=None: calls.append(path) or ["FAKE_ONCE"])

    assert load_env_file_once() == ["FAKE_ONCE"]
    assert load_env_file_once() == []
    assert len(calls) == 1


def test_utf8_bom_does_not_hide_the_first_variable(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_BOM_FIRST")
    dotenv = tmp_path / ".env"
    dotenv.write_bytes(b"\xef\xbb\xbfFAKE_BOM_FIRST=bom-value\n")

    assert load_env_file(dotenv) == ["FAKE_BOM_FIRST"]
    assert os.environ["FAKE_BOM_FIRST"] == "bom-value"


def test_a_value_the_environment_rejects_is_skipped_not_fatal(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_NUL", "FAKE_AFTER_NUL")
    dotenv = tmp_path / ".env"
    dotenv.write_bytes(b"FAKE_NUL=a\x00b\nFAKE_AFTER_NUL=fine\n")

    assert load_env_file(dotenv) == ["FAKE_AFTER_NUL"]
    assert "FAKE_NUL" not in os.environ


def test_directory_in_place_of_the_file_is_fine(tmp_path):
    assert load_env_file(tmp_path) == []


def test_binary_garbage_is_fine(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_bytes(b"\xff\xfe\x00\x80 not utf-8")

    assert load_env_file(dotenv) == []


def test_loading_logs_nothing(tmp_path, monkeypatch, caplog):
    import logging

    _isolate(monkeypatch, "FAKE_QUIET")
    caplog.set_level(logging.DEBUG)
    dotenv = tmp_path / ".env"
    dotenv.write_text("FAKE_QUIET=fake-session-123\n", encoding="utf-8")

    load_env_file(dotenv)

    assert "fake-session-123" not in caplog.text
