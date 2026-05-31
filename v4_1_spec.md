# Scene Prompt Viewer v4.1 — Spec for Claude Code

Builds on v4. Three small changes, plus a fallback path if the second one
doesn't pan out.

Read all existing files in `scene_prompt_viewer/` before starting:
`__init__.py`, `nodes.py`, `utils.py`, `server_api.py`, `js/scene_prompt_viewer.js`.

---

## Context

In v4, there's a hidden widget named `scene_data_json` declared in
`INPUT_TYPES["required"]` that stores the per-scene state (scenes + prompts)
as a JSON string. It's hidden via `type = "hidden"`, `computeSize = [0, -4]`,
and `hidden = true` flags on the JS side.

**Problem**: the new ComfyUI Vue frontend renders a small "convert widget
to input" indicator dot next to every widget — including hidden ones.
That dot appears very close to `prompt_in_1` and is visually confusing
because users might think it's a real socket. If they right-click and
convert it, they get a string socket that exposes the internal JSON state,
which is not what anyone wants.

We can't fully remove that dot — it's an unavoidable ComfyUI frontend
behavior that applies to every widget on every node. But we can make it
**obvious that it's internal and shouldn't be touched**.

---

## Confirmed changes for v4.1

1. **Rename** `scene_data_json` → `_internal_state` (the leading underscore
   is a clear "private" signal, and the label that appears in the
   right-click "Convert ... to input" menu now says
   "Convert _internal_state to input" — clearly do-not-touch).
2. **Add `multiline: True`** to each `prompt_in_N` optional input. This is
   a hint that *might* make Primitive nodes render their value field as a
   multiline textarea when connected — works in some ComfyUI versions.
3. **(Fallback for #2 if it doesn't work)** Add a new small node called
   `ScenePromptText` to the same package — a multiline STRING source node
   that's nicer than Primitive for typing prompts to feed into
   `prompt_in_N`.

---

## Change 1: Rename `scene_data_json` → `_internal_state`

### `nodes.py`

Change the widget name everywhere it appears. Keep it in
`INPUT_TYPES["required"]` (do **not** move it to `optional` — that could
flip it from a widget to a socket in newer ComfyUI versions and break
state serialization). Just rename it.

Before:
```python
"scene_data_json": ("STRING", {"default": "{}", "multiline": True}),
```

After:
```python
"_internal_state": ("STRING", {"default": "{}", "multiline": True}),
```

Update the `execute()` method signature to match:
```python
def execute(
    self,
    image_folder: str,
    sort_by: str,
    slot_count: int,
    _internal_state: str,
    **kwargs,
):
    ...
```

And update the internal usage:
```python
prompts_map = self._parse_prompts_map(_internal_state)
```

### `js/scene_prompt_viewer.js`

Search-and-replace every `"scene_data_json"` with `"_internal_state"`. There
are at least 3 occurrences:
- In `onNodeCreated`: `this.widgets?.find(w => w.name === "scene_data_json")`
- In `onConfigure`: same find call
- Anywhere else if a fourth slipped in

The variable name `dataWidget` inside JS can stay — it's just a local var.

### Expected effect

- The right-click context menu on the dot now reads "Convert _internal_state
  to input" instead of "Convert scene_data_json to input" — clear "don't
  touch" signal.
- The dot may or may not visually move — that depends on the user's
  ComfyUI frontend version. **This is not under our control.** Don't try
  to hack it further; it will just create version-compatibility issues.

### Backward compat

Existing v4 workflows saved with the old name will not load the saved
state, because ComfyUI looks up widget values by name. The hidden widget
will get its `default` value of `"{}"` and the user will need to click
Rescan again to repopulate.

This is acceptable — the workflow won't crash, just the card list will
be empty until rescan. Mention this in the README under a "Migrating from
v4" note.

---

## Change 2: Try `multiline: True` on `prompt_in_N`

### `nodes.py`

In `INPUT_TYPES.optional`, add `multiline: True` to each `prompt_in_N`:

Before:
```python
optional = {
    f"prompt_in_{i}": ("STRING", {"forceInput": True})
    for i in range(1, MAX_SLOTS + 1)
}
```

After:
```python
optional = {
    f"prompt_in_{i}": ("STRING", {"forceInput": True, "multiline": True})
    for i in range(1, MAX_SLOTS + 1)
}
```

### How to verify it worked

After restarting ComfyUI:

1. Add a Primitive node
2. Add a Scene Prompt Viewer node
3. Connect Primitive's STRING output to Scene Prompt Viewer's `prompt_in_1`
4. Look at the Primitive node — the `value` field below the connector

**Pass**: The `value` field is a multiline textarea (multiple rows tall,
resizable).

**Fail**: The `value` field is still a single-line text box.

If pass: done with this change.

If fail: implement Change 3 below.

---

## Change 3 (fallback for Change 2): Add `ScenePromptText` node

If Change 2 doesn't make Primitive render multiline, add a dedicated small
node to the package.

### New file: `prompt_text_node.py`

```python
"""
ScenePromptText — a tiny multiline STRING source node.

Designed to feed into ScenePromptViewer's prompt_in_N input sockets when
you want a per-slot prompt that's typed externally. More ergonomic than
Primitive for multi-line prompts.
"""

from __future__ import annotations


class ScenePromptText:
    """Multiline text → STRING output. Nothing fancy."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "Type prompt here…",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("STRING",)
    FUNCTION = "execute"
    CATEGORY = "image/utils"

    def execute(self, text: str):
        return (text,)
```

### Update `__init__.py`

Before:
```python
from .nodes import ScenePromptViewer
from . import server_api  # noqa: F401

NODE_CLASS_MAPPINGS = {
    "ScenePromptViewer": ScenePromptViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScenePromptViewer": "Scene Prompt Viewer",
}
```

After:
```python
from .nodes import ScenePromptViewer
from .prompt_text_node import ScenePromptText
from . import server_api  # noqa: F401

NODE_CLASS_MAPPINGS = {
    "ScenePromptViewer": ScenePromptViewer,
    "ScenePromptText":   ScenePromptText,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScenePromptViewer": "Scene Prompt Viewer",
    "ScenePromptText":   "Scene Prompt Text",
}
```

### Update README

Add a short section under Usage:

```markdown
### Connecting external prompt sources

Each visible `prompt_in_N` input socket on the left accepts any STRING
output. The package includes a helper node called **Scene Prompt Text**
under the same `image/utils` category — a simple multiline textarea
that's more comfortable than Primitive for long prompts.

If you'd rather use comfyui-easy-use's `easy positive` / `easy negative`,
or any other STRING source, they work too.
```

---

## Things NOT to break

- `_internal_state` widget still serializes to the workflow JSON correctly
  (test: save workflow, reload, cards should still be there)
- Rescan button still works
- Existing v4 functionality (slot_count, import/export, override badge) all
  works
- `OUTPUT_NODE = True` stays
- No new Python dependencies

---

## Test checklist

After implementing all changes:

- [ ] **Fresh node** — only `image_1`/`prompt_1` outputs visible (slot_count=1)
- [ ] **Right-click the fake dot near `prompt_in_1`** — menu shows
      "Convert _internal_state to input" (not the old name)
- [ ] **Add Primitive, connect to `prompt_in_1`** — check if Primitive's
      `value` field is multiline. Record result for the Change 2 verdict
- [ ] **(If Change 2 worked)** type a multi-paragraph prompt in
      Primitive's value field; run workflow; verify `prompt_1` output
      carries the full multi-line text
- [ ] **(If Change 2 didn't work and Change 3 was added)** Add a
      `Scene Prompt Text` node from `image → utils`; type prompt; connect
      to `prompt_in_1`; run; verify output
- [ ] **Save workflow + reload** — `_internal_state` repopulates cards
      correctly
- [ ] **Old v4 workflow** — loads without crashing; cards empty until
      user clicks Rescan (expected migration behavior)
- [ ] **Slot count change** — increasing slot_count adds new
      `prompt_in_N` sockets; decreasing removes them
- [ ] **Import/Export buttons** — still work as before
- [ ] **Rescan** — still works as before

---

## Optional: Python unit test addition

Extend any existing test with a renamed-arg sanity check:

```python
# Case: renamed internal state argument
state = {"scenes": [], "prompts": {"a.png": "from card"}}
result = node.execute(
    folder, "filename_asc", 1,
    _internal_state=json.dumps(state),
)
ind = result["result"][2:]
assert ind[1] == "from card"
```

If a `ScenePromptText` node is added, also test it:

```python
from scene_prompt_viewer.prompt_text_node import ScenePromptText
out = ScenePromptText().execute("hello\nworld")
assert out == ("hello\nworld",)
```

---

End of spec.
