# Scene Prompt Viewer v4.5 — Spec for Claude Code

Small patch on top of v4.4. Reverts one change.

Read all existing files in `scene_prompt_viewer/` before starting.

---

## Context

In v4.4 we replaced "📂 Open folder" (subprocess to OS file explorer)
with "📂 Browse" (tkinter native folder picker). After testing, the
tkinter approach failed because **ComfyUI Windows portable's embedded
Python ships without tkinter** — it gets stripped to keep the
distribution small.

Rather than patch tkinter into portable (fragile, breaks on ComfyUI
updates) or hack around with browser-side file APIs, we're **reverting
to the original Open folder behaviour** from v4.3.

The dimensions-row fix (Change 2) and hidden-socket-label feature
(Change 3) from v4.4 stay in place — those work fine.

---

## The revert

### `server_api.py`

**Remove**:
- The `_browse_folder_handler` function added in v4.4
- Its route registration for `/scene_prompt_viewer/browse_folder`
- Any unused tkinter import

**Add back** (the v4.3 implementation):

```python
import platform
import subprocess


async def _open_folder_handler(request: web.Request) -> web.Response:
    """
    Open the OS file explorer at the given folder. Local-only; no-op on
    headless deployments.
    """
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
            subprocess.Popen(["explorer", str(folder)])
        elif system == "Darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True})


# Register alongside the other routes:
server.PromptServer.instance.routes.post(
    "/scene_prompt_viewer/open_folder"
)(_open_folder_handler)
```

Note about `explorer.exe`: it sometimes returns a non-zero exit code
even when it successfully opened the window — that's a known Windows
quirk. We use `subprocess.Popen` (fire and forget) rather than `.run`
specifically so we don't read or check the exit code.

### `js/scene_prompt_viewer.js`

**Remove**:
- The `browseBtn` button creation
- Its click handler (the async function that calls `/browse_folder`)
- Any references to `browseBtn` in the toolbar setup

**Add back**:

```js
const openFolderBtn = makeButton("📂 Open");
openFolderBtn.title = "Open the image folder in your OS file explorer";
```

Toolbar order:

```js
toolbar.appendChild(rescanBtn);
toolbar.appendChild(openFolderBtn);   // ← between Rescan and Import
toolbar.appendChild(importBtn);
toolbar.appendChild(exportBtn);
```

Click handler:

```js
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

- v4.4 Change 2 (filename + dimensions same row, override on its own
  row, padding-right reservation) stays
- v4.4 Change 3 (hidden sockets get `(hide)` label, sync helper, reset
  on Rescan) stays
- All v4.3 functionality (per-card ↻, ✕, slot_count, prompt_in_N
  override) stays
- `_internal_state` serialization, Rescan, Import / Export all
  unchanged

---

## Test checklist

- [ ] **Open folder, happy path** — fill `image_folder` with a valid
      path, click 📂 Open, OS file explorer opens at that folder
- [ ] **Open folder, empty path** — clear `image_folder`, click 📂
      Open, status shows "image_folder is empty", no crash
- [ ] **Open folder, bad path** — type a nonsense path, click 📂 Open,
      status shows "open failed: folder not found: ..."
- [ ] **All v4.4 layout fixes still work** — filename + dimensions
      same row, no overlap with action buttons, override badge on its
      own row below
- [ ] **All v4.4 hidden socket labels still work** — clicking ✕ adds
      `(hide)` suffix to corresponding `image_N` / `prompt_N` /
      `prompt_in_N`, Rescan reverts

---

End of spec.
