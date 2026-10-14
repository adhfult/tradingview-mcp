"""Phase 7c: Pyne scripts. Names, the strategies folder, availability and the missing-extra envelope.

Hermetic: no network. Nothing here needs the `pine` extra; tests that run a script are in the other pine files.
"""
from __future__ import annotations

import os
import sys

import pytest

from tradingview_mcp.core.services import pine_service as pine


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path))
    folder = tmp_path / "strategies"
    folder.mkdir()
    return folder


# ─── names ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["ema_cross", "a", "a-b_1", "x" * 64, "0day"])
def test_valid_names(name):
    assert pine.valid_name(name)


@pytest.mark.parametrize("name", ["", "X", "Ema", "../x", "a/b", "a\\b", "a.py", "a b", "x" * 65, "é", "a\n", ".hidden", None, 5])
def test_invalid_names(name):
    assert not pine.valid_name(name)


def test_is_pine_and_script_name():
    assert pine.is_pine("pine:ema_cross")
    assert not pine.is_pine("ema_cross") and not pine.is_pine("PINE:x") and not pine.is_pine(None)
    assert pine.script_name("pine:ema_cross") == "ema_cross"


# ─── the folder ───────────────────────────────────────────────────────────────

def test_the_folder_is_under_the_tradingview_mcp_home(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path))
    assert pine.strategies_dir() == tmp_path / "strategies"


def test_list_scripts_gives_valid_names_only_sorted(home):
    for name in ("b_two.py", "a_one.py", "Bad.py", "notes.txt", "c.pyc", "with space.py", ".hidden.py"):
        (home / name).write_text("x")
    (home / "adir.py").mkdir()                       # a folder named like a script is not a script
    assert pine.list_scripts() == ["a_one", "b_two"]


def test_list_scripts_without_a_folder_is_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGVIEW_MCP_HOME", str(tmp_path / "nowhere"))
    assert pine.list_scripts() == []


def test_script_path_finds_a_script(home):
    (home / "ema_cross.py").write_text("x")
    assert pine.script_path("ema_cross") == (home / "ema_cross.py").resolve()


@pytest.mark.parametrize("name", ["../x", "X", "", "a" * 65, "a/b"])
def test_script_path_refuses_bad_names_before_touching_the_disk(home, name):
    with pytest.raises(pine.PineError, match="name"):
        pine.script_path(name)


def test_script_path_says_which_script_is_missing_and_what_exists(home):
    (home / "have_it.py").write_text("x")
    with pytest.raises(pine.PineError) as exc:
        pine.script_path("nope")
    assert "nope" in str(exc.value) and "have_it" in str(exc.value)


def test_script_path_refuses_a_link_that_leaves_the_folder(home, tmp_path):
    outside = tmp_path.parent / "outside_script.py"
    outside.write_text("x")
    try:
        os.symlink(outside, home / "sneaky.py")
    except OSError:                                   # pragma: no cover (no symlinks on this system)
        pytest.skip("symlinks not available")
    assert "sneaky" not in pine.list_scripts()
    with pytest.raises(pine.PineError, match="outside"):
        pine.script_path("sneaky")


# ─── availability and the envelope ────────────────────────────────────────────

def test_available_is_false_on_python_3_10(monkeypatch):
    monkeypatch.setattr(pine, "_python_version", lambda: (3, 10))
    ok, reason = pine.available()
    assert not ok and "3.11" in reason


def test_available_is_false_when_the_extra_is_not_installed(monkeypatch):
    monkeypatch.setattr(pine, "_python_version", lambda: (3, 12))
    monkeypatch.setitem(sys.modules, "pynecore", None)          # makes `import pynecore` raise ImportError
    ok, reason = pine.available()
    assert not ok and "pip install" in reason


def test_available_is_true_with_the_extra():
    pytest.importorskip("pynecore")
    assert pine.available() == (True, "")


def test_the_missing_dependency_envelope_is_exactly_the_documented_one():
    err = pine.dependency_missing()
    assert err["error"]["code"] == "DEPENDENCY_MISSING"
    assert err["error"]["message"] == "Pine support needs Python 3.11+ and: pip install 'tradingview-mcp-server[pine]'"
