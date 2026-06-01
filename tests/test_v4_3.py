"""
v4.3 tests for ScenePromptViewer.execute() — focused on the Change 4
Y-mode hidden behaviour:

  * individual slots are indexed by the scene's ORIGINAL scan position
    (a hidden scene keeps its slot, which becomes a black image + "")
  * the IMAGE batch + combined prompts EXCLUDE hidden scenes

Run with the ComfyUI embedded python (needs torch / numpy / PIL):

    python_embeded\\python.exe -m pytest tests\\test_v4_3.py -v
    # or simply:
    python_embeded\\python.exe tests\\test_v4_3.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

from PIL import Image

# --------------------------------------------------------------------------- #
# Import nodes.py as a package submodule so its `from .utils import ...`
# relative import resolves. The repo folder name has a hyphen, so we register
# a synthetic package name pointing at the repo root.
# --------------------------------------------------------------------------- #
PKG_DIR = Path(__file__).resolve().parent.parent
PKG_NAME = "spv_pkg"

if PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(PKG_NAME)
    _pkg.__path__ = [str(PKG_DIR)]
    sys.modules[PKG_NAME] = _pkg

_spec = importlib.util.spec_from_file_location(
    f"{PKG_NAME}.nodes", PKG_DIR / "nodes.py"
)
_nodes = importlib.util.module_from_spec(_spec)
sys.modules[f"{PKG_NAME}.nodes"] = _nodes
_spec.loader.exec_module(_nodes)

ScenePromptViewer = _nodes.ScenePromptViewer


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _make_folder(tmp: Path, names, size=(64, 48)):
    """Create solid-colour images named `names` in `tmp`."""
    for idx, name in enumerate(names):
        # distinct colour per file (not black, so we can tell them apart)
        colour = (40 + idx * 30, 80, 120)
        Image.new("RGB", size, colour).save(tmp / name)


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #
def test_hidden_scene_yields_black_slot_and_excluded_from_batch():
    """Spec's Python test: b.png hidden among a/b/c."""
    node = ScenePromptViewer()
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d)
        _make_folder(folder, ["a.png", "b.png", "c.png"])

        state = {
            "scenes": [],
            "prompts": {"a.png": "alpha", "b.png": "beta", "c.png": "gamma"},
            "hidden":  ["b.png"],
        }
        result = node.execute(str(folder), "filename_asc", 3, json.dumps(state))

        out = result["result"]
        ind = out[2:]
        # Slot 1: a.png (alpha), slot 2: BLACK + "" (b hidden), slot 3: c.png
        assert ind[1] == "alpha"
        assert ind[3] == "" and ind[2].abs().sum().item() == 0
        assert ind[5] == "gamma"
        # Batch has 2 images (a + c), not 3
        assert out[0].shape[0] == 2
        # combined prompts skip b
        assert out[1] == "alpha\ngamma"


def test_no_hidden_is_unchanged():
    """Sanity: with no hidden list, all scenes flow through normally."""
    node = ScenePromptViewer()
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d)
        _make_folder(folder, ["a.png", "b.png", "c.png"])

        state = {"prompts": {"a.png": "alpha", "b.png": "beta", "c.png": "gamma"}}
        result = node.execute(str(folder), "filename_asc", 3, json.dumps(state))

        out = result["result"]
        ind = out[2:]
        assert ind[1] == "alpha"
        assert ind[3] == "beta"
        assert ind[5] == "gamma"
        # batch has all 3
        assert out[0].shape[0] == 3
        assert out[1] == "alpha\nbeta\ngamma"


def test_all_hidden_still_produces_valid_batch():
    """Edge case: everything hidden → batch is a single black frame, no crash."""
    node = ScenePromptViewer()
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d)
        _make_folder(folder, ["a.png", "b.png"])

        state = {
            "prompts": {"a.png": "alpha", "b.png": "beta"},
            "hidden":  ["a.png", "b.png"],
        }
        result = node.execute(str(folder), "filename_asc", 2, json.dumps(state))

        out = result["result"]
        # batch falls back to a single black frame
        assert out[0].shape[0] == 1
        assert out[0].abs().sum().item() == 0
        assert out[1] == ""
        # both individual slots are black + empty
        ind = out[2:]
        assert ind[1] == "" and ind[0].abs().sum().item() == 0
        assert ind[3] == "" and ind[2].abs().sum().item() == 0


def test_hidden_excludes_from_batch_but_keeps_gap_with_override():
    """A prompt_in_N override on a visible slot still wins; hidden slot stays gap."""
    node = ScenePromptViewer()
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d)
        _make_folder(folder, ["a.png", "b.png", "c.png"])

        state = {
            "prompts": {"a.png": "alpha", "b.png": "beta", "c.png": "gamma"},
            "hidden":  ["b.png"],
        }
        # Override slot 3 (c.png) externally.
        result = node.execute(
            str(folder), "filename_asc", 3, json.dumps(state),
            prompt_in_3="OVERRIDE",
        )
        out = result["result"]
        ind = out[2:]
        assert ind[1] == "alpha"
        assert ind[3] == "" and ind[2].abs().sum().item() == 0   # b hidden
        assert ind[5] == "OVERRIDE"                              # c overridden
        assert out[0].shape[0] == 2
        assert out[1] == "alpha\nOVERRIDE"


# --------------------------------------------------------------------------- #
# Plain-script runner (so it works without pytest installed)
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL  {name}: {e}")
            except Exception as e:
                failures += 1
                print(f"ERROR {name}: {type(e).__name__}: {e}")
    print("-" * 50)
    print("all passed" if failures == 0 else f"{failures} failed")
    sys.exit(1 if failures else 0)
