# ComfyUI Scene Prompt Viewer

A ComfyUI custom node for pairing a folder of images with prompts via an
inline card UI. Each image becomes its own card with an editable prompt
textarea right next to its thumbnail. Comes with up to 8 individual
output sockets (configurable), per-card actions, and external prompt
override.

![screenshot](docs/screenshot.png)
<!-- TODO: replace with a real screenshot once available -->

## What's in the box

Three nodes:

- **Scene Prompt Viewer** — the main node. Scans a folder, displays an
  editable card per image, outputs both a batch and individual sockets.
- **Scene Prompt Text** — a small helper. Multiline STRING source for
  feeding external prompts into Scene Prompt Viewer's `prompt_in_N`
  inputs. (Use this instead of Primitive when you want a multiline
  text box.)
- **Scene Output Saver** — a terminal (sink) node. Takes the
  `IMAGE` / `prompts` / `filenames` batch outputs, expands a folder
  template, and writes each image to disk with a matching `prompt.txt`.
  See [`scene_output_saver_v1_0_spec.md`](scene_output_saver_v1_0_spec.md).

All live under **image → utils** in the node browser.

## Features

- **Card-per-image layout** — each scanned image becomes a card with
  its thumbnail, filename, dimensions, and an editable prompt textarea.
- **Configurable output sockets** — `slot_count` (0–8) controls how
  many individual `image_N` / `prompt_N` socket pairs are exposed. The
  matching `prompt_in_N` input sockets appear on the left for external
  overrides.
- **External prompt override** — connecting anything to `prompt_in_N`
  greys out card N's textarea and uses the connected string instead.
  Disconnect → textarea is editable again, original text preserved.
- **Per-card actions** — ↻ Reload to refresh a single thumbnail after
  external editing, ✕ Hide to skip a scene for this session.
- **Folder rescan** — server-side endpoint streams thumbnails back to
  the UI without re-running the whole workflow.
- **Persistent prompts** — typed prompts save into the workflow JSON,
  keyed by filename, so they survive workflow save/reload and survive
  rescans where the file still exists.
- **Bulk import/export** — paste a prompt block in Format A or B to
  fill all cards at once, or copy all prompts back to the clipboard.

## Install

### Option 1 — Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/<your-username>/Comfyui-ScenePromptViewer.git
```

Restart ComfyUI. Both nodes appear under **image → utils**.

### Option 2 — ComfyUI Manager

After the repo is listed in the Manager registry, search for
`ScenePromptViewer` and click Install.

No additional Python packages required — uses only what ComfyUI ships
(`Pillow`, `torch`, `numpy`, `aiohttp`).

## Quick start

1. Drop a **Scene Prompt Viewer** onto the canvas.
2. Paste your image folder's absolute path into `image_folder`.
3. Click **↻ Rescan**. Thumbnails appear, one card per image.
4. Type a prompt into each card's textarea.
5. Set `slot_count` to the number of individual outputs you need
   (default 1, max 8).
6. Connect outputs:
   - `IMAGE` / `prompts` — all scenes as a batch (excludes hidden)
   - `image_N` / `prompt_N` — individual scenes (slots 1 through
     `slot_count`)
7. Queue the workflow.

## Inputs

| Field | Type | Description |
|-------|------|-------------|
| `image_folder` | STRING | Absolute path to a folder of `.jpg`/`.jpeg`/`.png`/`.webp` |
| `sort_by` | COMBO | `filename_asc` (default) or `filename_desc` |
| `slot_count` | INT (0–8) | Number of individual `image_N`/`prompt_N` sockets to expose |
| `prompt_in_1` … `prompt_in_8` | STRING (optional) | External prompt sources — when connected, override the textarea for that slot |

`_internal_state` is also declared as a required input but is hidden
from the UI by the JS extension — it holds the workflow-serialized
scene state (cards, prompts, thumbnails). Don't connect to its
convert-to-input dot.

## Outputs

| Socket | Type | Description |
|--------|------|-------------|
| `IMAGE` | IMAGE | All non-hidden scenes letterboxed to the first image's size, stacked as a batch |
| `prompts` | STRING | All non-hidden prompts joined by `\n` |
| `filenames` | STRING | All non-hidden source filenames (no extension) joined by `,`, parallel to the `IMAGE` batch. Feeds **Scene Output Saver**. |
| `image_1` … `image_8` | IMAGE | Each slot's image as a 1-frame batch (black placeholder when slot is unused or scene hidden) |
| `prompt_1` … `prompt_8` | STRING | Each slot's prompt (empty string when slot is unused or scene hidden) |

When a scene is hidden via ✕, the socket label updates to e.g.
`image_3 (hide)` — connections stay valid, output becomes a black image
+ empty string. Click Rescan to restore.

Scenes beyond the 8th still appear in the card list and are included in
the `IMAGE` / `prompts` batch outputs, but have no individual socket.

## Toolbar buttons

| Button | What it does |
|--------|--------------|
| **↻ Rescan** | Re-scan the image folder; clears the session hide list |
| **📂 Open** | Open the image folder in your OS file explorer (may open behind the ComfyUI window on Windows — see Known limitations) |
| **Import all prompts** | Paste a bulk block in Format A or B to fill all cards |
| **Export all prompts** | Copy all current prompts to the clipboard in Format A |

## Per-card buttons

In the top-right corner of each card:

| Button | What it does |
|--------|--------------|
| **↻** | Re-fetch this card's thumbnail (useful after editing the image externally) |
| **✕** | Hide this scene for the current session — Rescan to restore |

## Import / Export prompt formats

**Format A — filename mapping (preferred when filenames matter):**

```
scene_01.png | a lone figure on a cliff at dusk
scene_02.jpg | crowded night market with neon lights
scene_03.webp ｜ a misty pine forest at dawn
```

Half-width `|` and full-width `｜` both work. Whitespace around the
separator doesn't matter. Filename matching is case-insensitive. Lines
without a recognised image filename on the left are skipped.

**Format B — one prompt per line (matches scan order):**

```
a lone figure on a cliff at dusk
crowded night market with neon lights
a misty pine forest at dawn
```

Line N maps to scene N (after sorting). Blank lines are skipped.

Format detection: if at least one line has `<image-filename> | <text>`,
Format A is used; otherwise Format B.

## Connecting external prompt sources

Each `prompt_in_N` socket accepts any STRING output. Recommended sources:

- **Scene Prompt Text** (shipped in this package) — multiline textarea
  + STRING output. Best for most cases.
- Built-in `Primitive` — single-line, fine for short prompts.
- Any other STRING-emitting node — wildcard processors, style mixers,
  comfyui-easy-use's `easy positive` / `easy negative`, etc.

When connected, card N's textarea greys out and a small
`← input override` badge appears below the filename. The card's typed
text is preserved — disconnect to use it again.

## Behavior notes

- **Letterboxing**: all images fit into the first image's dimensions
  with black padding so the batch tensor is uniform. To avoid this,
  pre-resize your images to matching dimensions.
- **Empty prompts**: cards with empty textareas produce empty strings
  on the downstream output — feeding into a CLIP text encoder yields
  empty conditioning, not an error.
- **Hidden scenes** (per-card ✕): not processed during execution.
  Their individual slots emit black + empty string; their entries are
  removed from the IMAGE batch and combined prompts. Hidden state
  resets on every Rescan and on workflow reload — it's session-only.
- **Slot count vs hidden vs scene count**: these are three independent
  things.
  - `slot_count` controls how many sockets are *visible* on the node.
  - Hidden via ✕ controls which scenes are *processed*.
  - Total scene count is just whatever's in your folder.
- **Persistent state**: scenes (with thumbnails) and prompts are
  serialised into the workflow JSON. For 15 images expect ~100 KB of
  workflow file growth from the embedded base64 thumbnails.

## Known limitations

- **Open folder may open in the background on Windows** — this is
  caused by Windows' foreground lock for windows opened from background
  processes. Alt-tab or click the Explorer icon in the taskbar to
  bring it forward.
- **No native folder picker** — ComfyUI Windows portable ships an
  embedded Python without `tkinter`, so we can't show a folder-select
  dialog. Use Open folder to verify your path visually, then paste it
  into `image_folder`.
- **Max 8 individual sockets** — set at `MAX_SLOTS = 8` in
  `utils.py`. Scenes 9+ work fine but only via the batch output.
- **No subfolder recursion** — only the top-level files in
  `image_folder` are scanned.

## License

MIT — see [LICENSE](LICENSE).
