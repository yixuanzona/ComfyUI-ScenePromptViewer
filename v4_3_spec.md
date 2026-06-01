# Scene Prompt Viewer v4.3 — Spec for Claude Code

Builds on v4.2. Adds per-card actions, image dimensions, an open-folder
button, and fixes the filename rendering bug.

Read all existing files in `scene_prompt_viewer/` before starting:
`__init__.py`, `nodes.py`, `utils.py`, `server_api.py`,
`js/scene_prompt_viewer.js`.

---

## Context

After v4.2 the node lets you scan a folder, edit per-scene prompts, and
expose up to 8 individual `image_N` / `prompt_N` outputs (plus a batch).

This release adds:

- **Bug fix** — filename text gets vertically clipped when the
  `← input override` italic badge is present, because the parent div has
  `overflow: hidden` with no explicit `line-height` and inline italic
  metrics push the line-box past the auto height. Fix by restructuring
  filename + badge into a flex row with explicit `line-height: 1.5`.
- **Image dimensions** displayed next to the filename (e.g.
  `00 (1).png · 1920×1080`).
- **Per-card Reload** button (↻) — re-fetch a single image's thumbnail
  without rescanning the whole folder. Useful when you edited one image
  externally (Photoshop, Gemini, etc.) and want to see the update.
- **Per-card Hide** button (✕) — visually hide a scene for this session.
  Hidden scenes are not processed (slot becomes black + empty string,
  removed from batch). Rescan brings them all back. Hidden state is
  **not persisted** across workflow save/reload.
- **Open folder** button — opens the OS file explorer at the
  `image_folder` path, so the user can drop new images in and then
  Rescan.
- **Y-mode hidden behavior** — when a scene is hidden, its slot index
  is preserved (e.g. hiding scene 3 means `image_3` becomes black and
  the visible cards remain numbered 1, 2, 4, 5, …). The batch output
  filters out hidden scenes entirely.

---

## Change 1 — Filename clipping fix

### `js/scene_prompt_viewer.js`

In `buildCard`, replace the current filename + badge block:

```js
const fname = document.createElement("div");
applyStyle(fname, `
    font-size: 11px;
    color: ${COLORS.muted};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`);
fname.textContent = scene.filename;
if (isOverridden) {
    const badge = document.createElement("span");
    badge.textContent = " ← input override";
    badge.style.cssText = `
        font-size: 10px;
        color: ${COLORS.accent};
        margin-left: 6px;
        font-style: italic;
    `;
    fname.appendChild(badge);
}
rightCol.appendChild(fname);
```

…with a flex row that separates the filename, the dimensions tag (new),
and the badge into independent elements:

```js
const fnameRow = document.createElement("div");
applyStyle(fnameRow, `
    display: flex;
    align-items: baseline;
    gap: 6px;
    line-height: 1.5;
    min-height: 18px;
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

// Dimensions (Change 2 — see below for `scene.width` / `scene.height`)
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

if (isOverridden) {
    const badge = document.createElement("span");
    applyStyle(badge, `
        font-size: 10px;
        color: ${COLORS.accent};
        font-style: italic;
        flex: 0 0 auto;
        white-space: nowrap;
    `);
    badge.textContent = "← input override";
    fnameRow.appendChild(badge);
}

rightCol.appendChild(fnameRow);
```

Key changes:
- Flex row container so each child gets its own inline box
- Explicit `line-height: 1.5` and `min-height: 18px` so descenders
  (`(`, `)`, `g`, `y`, `p`) don't get clipped
- Only the filename has `overflow: hidden` + ellipsis; the badge and
  dimensions stay full-size with `flex: 0 0 auto`
- `min-width: 0` on the filename is required so flex doesn't refuse to
  shrink it for ellipsis to kick in

---

## Change 2 — Image dimensions

### `utils.py`

Add a helper that bundles thumbnail + dimensions:

```python
def make_thumb_data(img: Image.Image) -> dict:
    """Return {thumbnail, width, height} for the UI scene record."""
    return {
        "thumbnail": make_thumb_b64(img),
        "width":     img.width,
        "height":    img.height,
    }
```

### `server_api.py`

In `_scan_handler`, replace the per-scene dict construction so each scene
includes `width` and `height`:

```python
scenes.append({
    "filename": fpath.name,
    **make_thumb_data(img),
})
```

(Import `make_thumb_data` from `.utils`.)

### `js/scene_prompt_viewer.js`

Already handled by the new fnameRow in Change 1 — it reads
`scene.width` and `scene.height` and renders the dimension tag if both
are present.

### Backward compat

Old `_internal_state` payloads (saved before v4.3) won't have
`width`/`height` on scenes. The `if (scene.width && scene.height)` check
hides the tag gracefully in that case. After the next Rescan, the new
scan data includes dimensions.

---

## Change 3 — Per-card Reload button (↻)

### `server_api.py`

Add a new route `/scene_prompt_viewer/scan_single` that returns one
scene's data:

```python
async def _scan_single_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)

    folder_str = clean_path(str(data.get("folder", "")))
    filename   = str(data.get("filename", "")).strip()

    if not folder_str or not filename:
        return web.json_response(
            {"error": "folder and filename are required"}, status=400
        )

    fpath = Path(folder_str) / filename
    if not fpath.is_file():
        return web.json_response(
            {"error": f"file not found: {filename}"}, status=404
        )
    if fpath.suffix.lower() not in SUPPORTED_EXTS:
        return web.json_response(
            {"error": f"unsupported extension: {fpath.suffix}"}, status=400
        )

    try:
        img = Image.open(fpath)
        img.load()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({
        "filename": fpath.name,
        **make_thumb_data(img),
    })


# At the bottom, alongside the existing route registration:
server.PromptServer.instance.routes.post(
    "/scene_prompt_viewer/scan_single"
)(_scan_single_handler)
```

### `js/scene_prompt_viewer.js`

Add a per-card action bar with the Reload button. Place it absolutely in
the **top-right corner of the card** so it doesn't shift content.

Inside `buildCard`, after setting up the card div:

```js
card.style.position = "relative";  // for absolute-positioned actions
```

After all the existing children have been appended:

```js
const actions = document.createElement("div");
applyStyle(actions, `
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 4px;
    z-index: 1;
`);

const reloadBtn = makeCardIconButton("↻", "Reload this image's thumbnail");
reloadBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onReload(scene.filename);
});
actions.appendChild(reloadBtn);

// Hide button — see Change 4
const hideBtn = makeCardIconButton("✕", "Hide this scene for this session");
hideBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onHide(scene.filename);
});
hideBtn.addEventListener("mouseenter", () => {
    hideBtn.style.background = "rgba(180, 60, 60, 0.7)";
    hideBtn.style.borderColor = "#a04040";
});
hideBtn.addEventListener("mouseleave", () => {
    hideBtn.style.background = "rgba(80, 80, 80, 0.6)";
    hideBtn.style.borderColor = "#555";
});
actions.appendChild(hideBtn);

card.appendChild(actions);
```

`buildCard` should accept two new callbacks: `onReload` and `onHide`.
Update the signature:

```js
function buildCard(scene, index, prompt, isBatchOnly, isOverridden,
                   onPromptChange, onReload, onHide) {
```

Add a small helper `makeCardIconButton` near the existing `makeButton`:

```js
function makeCardIconButton(label, tooltip) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = tooltip;
    btn.style.cssText = `
        width: 22px;
        height: 22px;
        background: rgba(80, 80, 80, 0.6);
        border: 1px solid #555;
        color: #ccc;
        font-size: 12px;
        border-radius: 3px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        font-family: inherit;
    `;
    return btn;
}
```

In the `renderCards` loop, wire up the callbacks:

```js
const card = buildCard(
    scene,
    i,
    currentPrompt,
    i > MAX_SLOTS,
    isOverridden,
    (fname, val) => {
        this.sceneState.prompts[fname] = val;
        persistState();
        refreshStatus();
    },
    (fname) => this._reloadScene(fname),   // ↻
    (fname) => this._hideScene(fname),     // ✕
);
```

Implement `_reloadScene` as a method on the node:

```js
this._reloadScene = async (filename) => {
    const folderWidget = this.widgets?.find(w => w.name === "image_folder");
    const folder = (folderWidget?.value || "").trim();
    if (!folder) return;
    try {
        const resp = await api.fetchApi("/scene_prompt_viewer/scan_single", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder, filename }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            refreshStatus(`reload failed: ${err.error || resp.statusText}`);
            return;
        }
        const data = await resp.json();
        // Replace just this scene in the state; keep order
        const idx = this.sceneState.scenes.findIndex(s => s.filename === filename);
        if (idx >= 0) {
            this.sceneState.scenes[idx] = data;
            persistState();
            renderCards();
        }
    } catch (e) {
        refreshStatus(`reload error: ${e.message || e}`);
    }
};
```

---

## Change 4 — Per-card Hide button (✕), session-only

### Key design points

- Hidden scenes live in a JS-side `Set` (`this._hiddenScenes`), keyed by
  filename.
- Hidden state is **included in `_internal_state.value`** at execution
  time so Python can skip them, **but cleared on every Rescan and on
  workflow reload** (in `onConfigure`).
- Rendering: hidden scenes are not drawn in the card list.
- **Y-mode numbering**: the visible cards keep their *original* index
  numbers — i.e. if scene 3 is hidden, the visible cards are still
  labelled 01, 02, 04, 05, … (not renumbered to 01, 02, 03, 04).
- Show a status note: "5 scenes · 1 hidden · Rescan to restore".

### `js/scene_prompt_viewer.js`

In `onNodeCreated`, initialise:

```js
this._hiddenScenes = new Set();
```

Update `persistState` to inject the hidden list:

```js
const persistState = () => {
    if (!this._dataWidget) return;
    const payload = {
        scenes:  this.sceneState.scenes,
        prompts: this.sceneState.prompts,
        hidden:  Array.from(this._hiddenScenes),  // session-only
    };
    this._dataWidget.value = JSON.stringify(payload);
};
```

Add a method `_hideScene`:

```js
this._hideScene = (filename) => {
    this._hiddenScenes.add(filename);
    persistState();
    renderCards();
};
```

In `renderCards`, filter out hidden scenes from the visible list but
**keep the original 1-based index** for each remaining scene:

```js
const allScenes = this.sceneState.scenes;
let hiddenCount = 0;

allScenes.forEach((scene, idx) => {
    if (this._hiddenScenes.has(scene.filename)) {
        hiddenCount++;
        return;  // skip rendering this card
    }
    const i = idx + 1;  // original index — keeps gaps after hides
    // ... rest of card building exactly as before
});
```

Update `refreshStatus` to include the hidden count:

```js
const refreshStatus = (extra) => {
    const total = this.sceneState.scenes.length;
    if (total === 0) { /* … existing empty case … */ return; }
    const hidden = this._hiddenScenes.size;
    let filled = 0;
    for (const s of this.sceneState.scenes) {
        if (this._hiddenScenes.has(s.filename)) continue;
        const p = this.sceneState.prompts[s.filename] || "";
        if (p.trim()) filled++;
    }
    const visible = total - hidden;
    let text = `${filled} / ${visible} filled`;
    if (hidden > 0) text += ` · ${hidden} hidden (rescan to restore)`;
    if (total > MAX_SLOTS) text += ` · slots ${MAX_SLOTS + 1}-${total} batch-only`;
    if (extra) text = `${extra} · ${text}`;
    statusEl.textContent = text;
    statusEl.style.color = (filled === visible && visible > 0)
        ? COLORS.success : COLORS.muted;
};
```

In the Rescan handler, **reset the hidden list**:

```js
// Inside rescanBtn click handler, after successful scan:
this.sceneState.scenes = newScenes;
this._hiddenScenes.clear();   // ← add this line
persistState();
renderCards();
```

In `onConfigure`, **don't restore hidden state** (session-only):

```js
const onConfigure = nodeType.prototype.onConfigure;
nodeType.prototype.onConfigure = function () {
    const r = onConfigure?.apply(this, arguments);
    const dataWidget = this.widgets?.find(w => w.name === "_internal_state");
    if (dataWidget?.value) {
        try {
            const state = JSON.parse(dataWidget.value);
            this.sceneState = {
                scenes:  Array.isArray(state.scenes) ? state.scenes : [],
                prompts: (state.prompts && typeof state.prompts === "object")
                            ? state.prompts : {},
            };
        } catch {
            this.sceneState = { scenes: [], prompts: {} };
        }
    }
    this._hiddenScenes = new Set();   // ← always start fresh
    // Re-persist immediately to strip any saved hidden list:
    if (this._dataWidget) {
        this._dataWidget.value = JSON.stringify({
            scenes: this.sceneState.scenes,
            prompts: this.sceneState.prompts,
            hidden: [],
        });
    }
    // ... rest of onConfigure (apply slot_count, render, etc.)
};
```

### Python (`nodes.py`)

Read the hidden list from `_internal_state` and apply it during pairing:

In `_parse_prompts_map`, split into two helpers — one for prompts, one
for hidden list:

```python
@staticmethod
def _parse_state(scene_data_json: str) -> Tuple[Dict[str, str], set]:
    """
    Returns ({filename_lower: prompt}, {filename_lower hidden set}).
    """
    if not scene_data_json:
        return {}, set()
    try:
        state = json.loads(scene_data_json)
    except (json.JSONDecodeError, TypeError):
        return {}, set()
    if not isinstance(state, dict):
        return {}, set()
    prompts_raw = state.get("prompts", {})
    hidden_raw  = state.get("hidden",  [])
    prompts = {
        k.lower(): v for k, v in (prompts_raw or {}).items()
        if isinstance(k, str) and isinstance(v, str)
    } if isinstance(prompts_raw, dict) else {}
    hidden = {
        h.lower() for h in (hidden_raw or [])
        if isinstance(h, str)
    } if isinstance(hidden_raw, list) else set()
    return prompts, hidden
```

Update `execute()`:

```python
prompts_map, hidden_set = self._parse_state(_internal_state)
```

When building outputs, **Y-mode** means individual slots are indexed by
the scene's position in the scanned list, regardless of hidden status.
Hidden scenes give a black placeholder + empty string. The batch outputs
**exclude** hidden scenes.

Restructure the main loop:

```python
target_w, target_h = paired[0][2].size

# Per-slot data (kept in original scan order, Y-mode)
slot_tensors:  List[torch.Tensor] = []   # for individual outputs
slot_prompts:  List[str]          = []
batch_tensors: List[torch.Tensor] = []   # for the IMAGE batch (filters out hidden)
batch_prompts: List[str]          = []
scene_data:    List[dict]         = []
filled = empty = hidden_count = 0

black_placeholder_first = None  # lazy-init from first non-hidden tensor

for i, (fname, prompt_text, img) in enumerate(paired, start=1):
    is_hidden = fname.lower() in hidden_set
    override = kwargs.get(f"prompt_in_{i}")
    final_prompt = override if isinstance(override, str) else prompt_text

    if is_hidden:
        hidden_count += 1
        # Slot N gets a black image + empty prompt
        slot_tensors.append(
            torch.zeros((target_h, target_w, 3), dtype=torch.float32)
        )
        slot_prompts.append("")
    else:
        if final_prompt.strip():
            filled += 1
        else:
            empty += 1
        fitted = self._letterbox(img, target_w, target_h)
        arr = np.asarray(fitted, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(arr)
        slot_tensors.append(tensor)
        slot_prompts.append(final_prompt)
        batch_tensors.append(tensor)
        batch_prompts.append(final_prompt)

    scene_data.append({
        "index":    i,
        "filename": fname,
        "prompt":   prompt_text,
        "hidden":   is_hidden,
        "has_socket": i <= MAX_SLOTS,
    })

# Batch: only non-hidden scenes. If everything is hidden, still produce
# a valid tensor (single black frame) so downstream nodes don't error.
if batch_tensors:
    image_batch = torch.stack(batch_tensors, dim=0)
else:
    image_batch = torch.zeros((1, target_h, target_w, 3), dtype=torch.float32)
combined_prompt = "\n".join(batch_prompts)

# Individual outputs (Y-mode: indexed by original position)
individual: list = []
black = torch.zeros((1, target_h, target_w, 3), dtype=torch.float32)
for i in range(MAX_SLOTS):
    if i < len(slot_tensors):
        individual.append(slot_tensors[i].unsqueeze(0))
        individual.append(slot_prompts[i])
    else:
        individual.append(black)
        individual.append("")
```

Status text:

```python
total = len(paired)
visible = total - hidden_count
status = f"{filled} / {visible} filled"
if hidden_count:
    status += f" · {hidden_count} hidden"
if empty:
    status += f" · {empty} empty"
if load_failures:
    status += f" · {len(load_failures)} load failures"
if total > slot_count:
    status += f" · slots {slot_count + 1}-{total} batch-only"
```

---

## Change 5 — Open folder button

### `server_api.py`

Add a route that opens the OS file explorer at the folder. Be careful
to fail safely if the path is invalid (don't shell-inject).

```python
import platform
import subprocess

async def _open_folder_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)

    folder_str = clean_path(str(data.get("folder", "")))
    if not folder_str:
        return web.json_response({"error": "folder is empty"}, status=400)

    folder = Path(folder_str)
    if not folder.is_dir():
        return web.json_response(
            {"error": f"folder not found: {folder_str}"}, status=404
        )

    try:
        system = platform.system()
        if system == "Windows":
            # Use explorer with the resolved path — no shell, no injection risk
            subprocess.Popen(["explorer", str(folder)])
        elif system == "Darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True})


# Register alongside the others:
server.PromptServer.instance.routes.post(
    "/scene_prompt_viewer/open_folder"
)(_open_folder_handler)
```

### `js/scene_prompt_viewer.js`

Add a button to the toolbar, between Rescan and Import:

```js
const openFolderBtn = makeButton("📂 Open");
openFolderBtn.title = "Open the image folder in your OS file explorer";
toolbar.appendChild(rescanBtn);
toolbar.appendChild(openFolderBtn);   // ← new, right after rescan
toolbar.appendChild(importBtn);
toolbar.appendChild(exportBtn);

openFolderBtn.addEventListener("click", async () => {
    const folderWidget = this.widgets?.find(w => w.name === "image_folder");
    const folder = (folderWidget?.value || "").trim();
    if (!folder) {
        refreshStatus("image_folder is empty");
        return;
    }
    try {
        const resp = await api.fetchApi("/scene_prompt_viewer/open_folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            refreshStatus(`open failed: ${err.error || resp.statusText}`);
        }
    } catch (e) {
        refreshStatus(`open error: ${e.message || e}`);
    }
});
```

---

## Things NOT to break

- `_internal_state` widget still serializes correctly across save/reload
- Rescan still works as before (and now also clears the hidden list)
- Import / Export still work — Import should NOT affect hidden state
- `OUTPUT_NODE = True` stays
- Letterbox-to-first-image behavior preserved
- Existing v4.2 workflows load without crashing (no `width`/`height` on
  old scenes → dimensions tag silently absent until next Rescan)
- Existing `prompt_in_N` override behavior unchanged

---

## Manual test checklist

After implementing all five changes:

- [ ] **Filename + override badge** — connect a string source to
      `prompt_in_1`. The card should show `00 (1).png · 1920×1080
      ← input override` with no clipped letters
- [ ] **Dimensions tag** — without an override, the card shows
      `00 (1).png · 1920×1080`. Try images with different resolutions
- [ ] **↻ Reload** — edit one image externally in PS/etc., click ↻ on
      its card, the thumbnail updates without re-scanning the whole
      folder; other cards unchanged
- [ ] **✕ Hide** — click ✕ on card 3. Card disappears from view, card 4
      is still numbered 04 (not renumbered to 03). Status shows
      "X hidden"
- [ ] **Hidden + workflow execute** — with card 3 hidden, run the
      workflow. `image_3` output is black, `prompt_3` is empty.
      `image_1`, `image_2`, `image_4` etc. still work correctly.
      The IMAGE batch contains only visible scenes (one less than before)
- [ ] **Rescan restores hidden** — click Rescan; all previously hidden
      cards reappear
- [ ] **Reload page** — save workflow, close tab, reopen. All cards
      should be visible (hidden list reset). Prompts and scenes still
      restored from saved state
- [ ] **📂 Open folder** — click button, OS file explorer opens at
      `image_folder` path. Drop a new file in, click Rescan, new file
      appears as a card
- [ ] **Empty folder field + Open** — clear `image_folder`, click
      📂 Open → status shows "image_folder is empty", no crash
- [ ] **Bad path + Open** — set `image_folder` to nonsense, click
      📂 Open → status shows "open failed: folder not found: ..."
- [ ] **Import / Export** — still works as before, hidden cards do not
      affect import behavior
- [ ] **Slot count change** — increasing/decreasing `slot_count` still
      adds/removes sockets correctly

---

## Python test additions

```python
# Case: hidden scene → individual slot is black, batch excludes it
state = {
    "scenes": [],
    "prompts": {"a.png": "alpha", "b.png": "beta", "c.png": "gamma"},
    "hidden":  ["b.png"],
}
result = node.execute(folder, "filename_asc", 3, json.dumps(state))
ind = result["result"][2:]
# Slot 1: a.png (alpha), slot 2: BLACK + "" (b hidden), slot 3: c.png (gamma)
assert ind[1] == "alpha"
assert ind[3] == "" and ind[2].abs().sum().item() == 0
assert ind[5] == "gamma"
# Batch has 2 images (a + c), not 3
assert result["result"][0].shape[0] == 2
assert result["result"][1] == "alpha\ngamma"   # combined prompts skip b
```

---

End of spec.
