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


# ---------------------------------------------------------------------------
# TRADINGVIEW_ENV_FILE and duplicate keys
# ---------------------------------------------------------------------------


def test_env_file_variable_points_at_another_file(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_FROM_OVERRIDE")
    monkeypatch.delenv("TRADINGVIEW_MCP_NO_DOTENV", raising=False)
    custom = tmp_path / "custom.env"
    custom.write_text("FAKE_FROM_OVERRIDE=override-value\n", encoding="utf-8")
    monkeypatch.setenv("TRADINGVIEW_ENV_FILE", str(custom))
    # If the default path were read instead, this sentinel would be loaded.
    monkeypatch.setattr(env_file, "DEFAULT_ENV_PATH", tmp_path / "does-not-exist.env")

    assert load_env_file() == ["FAKE_FROM_OVERRIDE"]
    assert os.environ["FAKE_FROM_OVERRIDE"] == "override-value"


def test_env_file_variable_wins_over_the_default_path(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_DEFAULT_ONLY", "FAKE_OVERRIDE_ONLY")
    monkeypatch.delenv("TRADINGVIEW_MCP_NO_DOTENV", raising=False)
    default = tmp_path / "default.env"
    default.write_text("FAKE_DEFAULT_ONLY=1\n", encoding="utf-8")
    custom = tmp_path / "custom.env"
    custom.write_text("FAKE_OVERRIDE_ONLY=1\n", encoding="utf-8")
    monkeypatch.setattr(env_file, "DEFAULT_ENV_PATH", default)
    monkeypatch.setenv("TRADINGVIEW_ENV_FILE", str(custom))

    assert load_env_file() == ["FAKE_OVERRIDE_ONLY"]
    assert "FAKE_DEFAULT_ONLY" not in os.environ


def test_explicit_path_argument_beats_the_env_file_variable(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_ARG", "FAKE_VAR")
    monkeypatch.delenv("TRADINGVIEW_MCP_NO_DOTENV", raising=False)
    arg = tmp_path / "arg.env"
    arg.write_text("FAKE_ARG=1\n", encoding="utf-8")
    var = tmp_path / "var.env"
    var.write_text("FAKE_VAR=1\n", encoding="utf-8")
    monkeypatch.setenv("TRADINGVIEW_ENV_FILE", str(var))

    assert load_env_file(arg) == ["FAKE_ARG"]
    assert "FAKE_VAR" not in os.environ


def test_env_file_variable_pointing_at_a_missing_file_is_a_quiet_noop(tmp_path, monkeypatch, caplog):
    import logging

    _isolate(monkeypatch, "FAKE_DEFAULT_SENTINEL")
    monkeypatch.delenv("TRADINGVIEW_MCP_NO_DOTENV", raising=False)
    default = tmp_path / "default.env"
    default.write_text("FAKE_DEFAULT_SENTINEL=1\n", encoding="utf-8")
    monkeypatch.setattr(env_file, "DEFAULT_ENV_PATH", default)
    missing = tmp_path / "secret-dir-name" / "missing.env"
    monkeypatch.setenv("TRADINGVIEW_ENV_FILE", str(missing))
    caplog.set_level(logging.DEBUG)

    assert load_env_file() == []
    # It does not fall back to the default file either.
    assert "FAKE_DEFAULT_SENTINEL" not in os.environ
    debug = [r for r in caplog.records if r.name == "tradingview_mcp.env_file"]
    assert len(debug) == 1
    assert debug[0].levelno == logging.DEBUG
    assert "TRADINGVIEW_ENV_FILE" in debug[0].getMessage()
    assert "secret-dir-name" not in caplog.text


def test_empty_env_file_variable_is_ignored(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_EMPTY_VAR_DEFAULT")
    monkeypatch.delenv("TRADINGVIEW_MCP_NO_DOTENV", raising=False)
    default = tmp_path / "default.env"
    default.write_text("FAKE_EMPTY_VAR_DEFAULT=1\n", encoding="utf-8")
    monkeypatch.setattr(env_file, "DEFAULT_ENV_PATH", default)
    monkeypatch.setenv("TRADINGVIEW_ENV_FILE", "")

    assert load_env_file() == ["FAKE_EMPTY_VAR_DEFAULT"]


def test_duplicate_keys_last_one_wins(tmp_path, monkeypatch):
    _isolate(monkeypatch, "FAKE_DUP", "FAKE_OTHER")
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "FAKE_DUP=first\nFAKE_OTHER=other\nexport FAKE_DUP='second'\nFAKE_DUP=third\n",
        encoding="utf-8",
    )

    loaded = load_env_file(dotenv)

    assert os.environ["FAKE_DUP"] == "third"
    assert os.environ["FAKE_OTHER"] == "other"
    assert loaded == ["FAKE_DUP", "FAKE_OTHER"]


def test_duplicate_keys_never_override_a_preexisting_variable(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_DUP_KEEP", "from-process")
    dotenv = tmp_path / ".env"
    dotenv.write_text("FAKE_DUP_KEEP=one\nFAKE_DUP_KEEP=two\n", encoding="utf-8")

    assert load_env_file(dotenv) == []
    assert os.environ["FAKE_DUP_KEEP"] == "from-process"
