# Scene Prompt Viewer v4.4 — Spec for Claude Code

Builds on v4.3. Three small refinements based on user testing.

Read all existing files in `scene_prompt_viewer/` before starting:
`__init__.py`, `nodes.py`, `utils.py`, `server_api.py`,
`js/scene_prompt_viewer.js`.

---

## Context

v4.3 added an "📂 Open folder" button that opens the OS file explorer at
`image_folder`. The user actually wanted the **opposite** workflow:
pick a folder via a native folder picker dialog, and have its path
auto-fill into `image_folder` (and trigger a rescan). The "open in
explorer" capability is being **removed entirely** — it doesn't serve
the user's actual need.

Also fixing two cosmetic bugs from v4.3 testing:

- Image dimensions ended up far right and overlapped the per-card
  action buttons (↻ ✕).
- Hidden output sockets don't visually signal that they're hidden — the
  labels are identical to non-hidden sockets, which is confusing when
  reading the node from a downstream perspective.

---

## Change 1 — Replace "Open folder" with "Browse" (tkinter folder picker)

### Remove from v4.3

- `_open_folder_handler` function and its route registration in
  `server_api.py`
- Any `subprocess` / `platform` imports that were added solely for the
  Open folder handler
- The `openFolderBtn` button in the toolbar in
  `js/scene_prompt_viewer.js`
- Its click handler

### Add in `server_api.py`

A new endpoint `/scene_prompt_viewer/browse_folder` that pops up a
native folder-selection dialog using `tkinter` and returns the chosen
path. tkinter is part of the Python standard library and ships with
ComfyUI's embedded Python.

```python
async def _browse_folder_handler(request: web.Request) -> web.Response:
    """
    Pop a native folder picker on the machine running ComfyUI. Returns
    the chosen path, or an empty string if the user cancelled.

    Only useful when the ComfyUI server is running on the same machine
    as the user. Remote/headless deployments will get an error.
    """
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return web.json_response(
            {"error": "tkinter is not available on this Python installation"},
            status=501,
        )

    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(title="Select image folder")
        root.destroy()
    except Exception as e:
        return web.json_response(
            {"error": f"folder picker failed: {e}"}, status=500
        )

    return web.json_response({"folder": folder or ""})


# Register alongside the other routes:
server.PromptServer.instance.routes.post(
    "/scene_prompt_viewer/browse_folder"
)(_browse_folder_handler)
```

Notes:
- We DON'T call `tkinter` in a thread executor — tkinter has main-thread
  requirements on macOS that make threading risky. A brief event-loop
  block while the user picks a folder is acceptable for a local tool.
- `askdirectory` returns `""` when the user cancels — we pass that
  through and the JS side treats empty as "no change".

### Add in `js/scene_prompt_viewer.js`

Replace the old `openFolderBtn` with a new `browseBtn`:

```js
const browseBtn = makeButton("📂 Browse");
browseBtn.title = "Pick an image folder via the OS file dialog";
```

Toolbar order:

```js
toolbar.appendChild(rescanBtn);
toolbar.appendChild(browseBtn);     // ← replaces openFolderBtn
toolbar.appendChild(importBtn);
toolbar.appendChild(exportBtn);
```

Click handler — picks folder, writes it back into `image_folder` widget,
auto-triggers Rescan:

```js
browseBtn.addEventListener("click", async () => {
    browseBtn.disabled = true;
    const origLabel = browseBtn.textContent;
    browseBtn.textContent = "Picking…";
    try {
        const resp = await api.fetchApi(
            "/scene_prompt_viewer/browse_folder",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            }
        );
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            refreshStatus(`browse failed: ${err.error || resp.statusText}`);
            return;
        }
        const data = await resp.json();
        if (!data.folder) {
            // User cancelled — say nothing
            return;
        }
        const folderWidget = this.widgets?.find(w => w.name === "image_folder");
        if (folderWidget) {
            folderWidget.value = data.folder;
            folderWidget.callback?.(data.folder);   // notify LiteGraph
        }
        this.setDirtyCanvas(true, true);
        // Auto-trigger rescan with the new path
        rescanBtn.click();
    } catch (e) {
        refreshStatus(`browse error: ${e.message || e}`);
    } finally {
        browseBtn.disabled = false;
        browseBtn.textContent = origLabel;
    }
});
```

---

## Change 2 — Dimensions next to filename; override badge on its own row

### Problem in v4.3

The filename row was `[filename] [dimensions] [override badge]` all in
one flex line. Combined with action buttons absolutely positioned in the
top-right (↻ ✕), the dimensions got pushed under the buttons.

### Fix in `js/scene_prompt_viewer.js`

In `buildCard`, restructure the fnameRow and add a separate
`overrideRow` for the badge.

**Before** (the v4.3 fnameRow):

```js
const fnameRow = document.createElement("div");
applyStyle(fnameRow, `display: flex; align-items: baseline; gap: 6px;
                     line-height: 1.5; min-height: 18px;`);

const fname = document.createElement("span"); /* filename */
const dims  = document.createElement("span"); /* dimensions if present */
const badge = document.createElement("span"); /* override if isOverridden */
// all three appended to fnameRow
```

**After**:

```js
const fnameRow = document.createElement("div");
applyStyle(fnameRow, `
    display: flex;
    align-items: baseline;
    gap: 6px;
    line-height: 1.5;
    min-height: 18px;
    padding-right: 56px;   /* reserve space for action buttons in corner */
`);

const fname = document.createElement("span");
applyStyle(fname, `
    font-size: 11px;
    color: ${COLORS.muted};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
`);
fname.textContent = scene.filename;
fnameRow.appendChild(fname);

if (scene.width && scene.height) {
    const dims = document.createElement("span");
    applyStyle(dims, `
        font-size: 10px;
        color: ${COLORS.dim};
        flex: 0 0 auto;
        white-space: nowrap;
    `);
    dims.textContent = `${scene.width}×${scene.height}`;
    fnameRow.appendChild(dims);
}

rightCol.appendChild(fnameRow);

// Override badge on its own row below the filename row
if (isOverridden) {
    const overrideRow = document.createElement("div");
    applyStyle(overrideRow, `
        font-size: 10px;
        color: ${COLORS.accent};
        font-style: italic;
        line-height: 1.4;
        margin-top: -2px;
    `);
    overrideRow.textContent = "← input override";
    rightCol.appendChild(overrideRow);
}
```

Result:

```
[01]  [thumb]  filename · 1920×1080         [↻] [✕]
               ← input override
               [textarea]
```

- Filename row reserves 56px on the right via `padding-right` so it
  doesn't slide under the action buttons
- Override badge is a separate row, only appears when needed

---

## Change 3 — Mark hidden output / input sockets with `(hide)` label

### Goal

When a scene is hidden (in the JS `_hiddenScenes` set), the
corresponding `image_N`, `prompt_N`, and `prompt_in_N` sockets get
their **display label** updated to e.g. `image_2 (hide)`. The socket's
internal `name` is unchanged (so connections still work). Unhiding
(via Rescan or workflow reload) reverts the label back.

LiteGraph distinguishes `socket.name` (internal identifier, used for
connections) from `socket.label` (displayed text). Setting `label` to a
string overrides the displayed text; setting it back to `undefined`
falls back to using `name`.

The socket dots stay their normal colour. We're only changing text.

### Add to `js/scene_prompt_viewer.js`

A helper function:

```js
function syncHiddenSocketLabels(node, hiddenScenes, scenes) {
    // For each scene that occupies a slot, mark or unmark its sockets.
    // Slots beyond what scenes occupy: leave their labels alone
    // (those are "unused", not "hidden" — different state).
    const sceneByIndex = new Map();   // 1-based slot → scene
    scenes.forEach((s, idx) => sceneByIndex.set(idx + 1, s));

    for (let i = 1; i <= 8; i++) {  // MAX_SLOTS
        const scene = sceneByIndex.get(i);
        const isHidden = scene && hiddenScenes.has(scene.filename);

        const setLabel = (slot, baseName) => {
            if (!slot) return;
            slot.label = isHidden ? `${baseName} (hide)` : undefined;
        };

        setLabel(
            node.outputs?.find(o => o.name === `image_${i}`),
            `image_${i}`
        );
        setLabel(
            node.outputs?.find(o => o.name === `prompt_${i}`),
            `prompt_${i}`
        );
        setLabel(
            node.inputs?.find(inp => inp.name === `prompt_in_${i}`),
            `prompt_in_${i}`
        );
    }
    node.setDirtyCanvas(true, true);
}
```

### Call it from the right places

In `renderCards`, at the end (after the loop that builds cards):

```js
syncHiddenSocketLabels(this, this._hiddenScenes, this.sceneState.scenes);
```

In `applySlotCount` (or wherever sockets are added/removed), call it
after the add/remove so newly-added sockets get correct labels:

```js
// At the end of applySlotCount:
if (node._hiddenScenes && node.sceneState?.scenes) {
    syncHiddenSocketLabels(node, node._hiddenScenes, node.sceneState.scenes);
}
```

In `onConfigure`, after restoring state and rendering, the call inside
`renderCards` covers it (because `_hiddenScenes` is always empty on
load, all labels will reset to `undefined`).

### Notes / edge cases

- When the user clicks ✕ to hide card #3, `renderCards` runs → labels
  update.
- When the user clicks Rescan, `_hiddenScenes.clear()` runs, then
  `renderCards()` → all labels revert to undefined.
- Slots beyond `scenes.length` (e.g. only 3 scenes but slot_count=5):
  no scene exists for slot 4/5, so `sceneByIndex.get(4)` returns
  undefined → `isHidden` is false → label cleared. Correct.

---

## Things NOT to break

- `_internal_state` widget still serializes correctly
- Rescan still clears `_hiddenScenes`
- Workflow save/reload still works (hidden state still resets on load)
- Import / Export still work
- `OUTPUT_NODE = True` stays
- All v4.3 functionality (per-card ↻, ✕, dimensions, prompt_in_N
  override, slot_count) still works
- Existing connections to `image_N` / `prompt_N` / `prompt_in_N`
  sockets stay connected when their labels change — labels only affect
  display, not identity

---

## Test checklist

After implementing all three changes:

- [ ] **📂 Browse, happy path** — click Browse, OS folder dialog opens,
      pick a folder with images, dialog closes. The `image_folder`
      widget auto-fills with the picked path. A Rescan triggers
      automatically. Cards appear.
- [ ] **📂 Browse, cancelled** — click Browse, then cancel the dialog.
      Nothing changes. No error.
- [ ] **📂 Browse on headless system** — (skip if not testable) on a
      machine without tkinter, button click shows a clear error in
      status, doesn't crash ComfyUI.
- [ ] **Filename + dimensions same row** — card shows
      `00 (1).png · 1920×1080` on one line. No overlap with the
      action buttons in the top-right corner.
- [ ] **Override badge below filename** — connect a string source to
      `prompt_in_1`. The card shows the filename row, then a separate
      italic `← input override` line below it, then the (greyed-out)
      textarea.
- [ ] **Hide socket labels** — click ✕ on card 3. The output socket
      labels on the right edge of the node update from `image_3` /
      `prompt_3` to `image_3 (hide)` / `prompt_3 (hide)`. Same for
      `prompt_in_3` on the left edge.
- [ ] **Rescan reverts labels** — click ↻ Rescan. All `(hide)` labels
      disappear and revert to plain `image_N` / `prompt_N` /
      `prompt_in_N`.
- [ ] **Connections survive label change** — connect `image_3` to a
      downstream node. Click ✕ on card 3. The label shows
      `image_3 (hide)`, but the connection is still there (line not
      broken). Output is black (because card 3 is hidden). Click
      Rescan → label reverts, output normal again.
- [ ] **slot_count + hide combine cleanly** — set slot_count=5, hide
      card 3. Sockets visible: image_1, prompt_1, image_2, prompt_2,
      image_3 (hide), prompt_3 (hide), image_4, prompt_4, image_5,
      prompt_5.
- [ ] **Reload page preserves dimensions** — after picking a folder
      and scanning, save the workflow. Reload. Dimensions appear next
      to filenames (because they're in the saved `scenes` data).
- [ ] **Old workflow without dimensions** — load a v4.2-era workflow
      that doesn't have dimensions. Cards render without a dimensions
      tag (no error). Click Rescan → dimensions appear.

---

## Python test additions (optional)

No new Python behavior — Change 3 is JS-only label cosmetics, Change 1
is a new endpoint with no behavioral test (would need GUI), Change 2 is
JS-only layout. Existing v4.3 tests should still pass unchanged.

---

End of spec.
