# ComfyUI Scene Prompt Viewer

You have a folder of images. You want to batch process them — upscale, remove background, edit with AI, change lighting — and when it's done, the output files should still be named after the originals.

That's what this does.

Load a folder, see every image as a card with its own editable prompt, connect to any processing node, save with original filenames intact.

![screenshot](docs/screenshot.png)

---

## What problem does this solve?

Without this node, batch processing in ComfyUI loses track of which output belongs to which source file. You end up with `output_00001.png`, `output_00002.png` — and no idea which scene is which, especially when handing off to someone else.

With this node:
- Every image stays paired with its filename through the entire workflow
- Each image gets its own prompt, written directly on its card
- Scene Output Saver writes results back using the original filenames

---

## Three ways to use it

**1. Batch process with original filenames preserved**

The most common use. Run upscaling, background removal, style transfer, or any image processing on a whole folder. Results come out named after the originals.

```
Scene Prompt Viewer → [upscale / rembg / any processing] → Scene Output Saver
```

Example output with `filename_suffix = _upscale`:
```
Hualien_sunset_upscale.png
Taipei_nightview_upscale.png
Kenting_beach_upscale.png
```

**2. Per-image AI editing with individual prompts**

Each card has its own prompt. Connect `prompts` to an AI editing node (image-to-image, style transfer, Qwen image edit, etc.) and every image gets processed with its own instruction — fully automated, no manual socket switching.

```
Scene Prompt Viewer
  ├── IMAGE  → batch to image list → AI edit node → image list to batch → Scene Output Saver
  └── prompts → split by newline  → AI edit node (prompt input)
```

For splitting `prompts` into per-image strings, use `KepStringListFromNewline` (Comfy_KepListStuff) or `TextSplitByDelimiter` (comfyui-mixlab-nodes).

**3. Visual library browser + individual handling**

Instead of opening Load Image for each file or toggling between folders, scan once and see everything. Use `slot_count` to expose individual `image_N` / `prompt_N` sockets for scenes that need special treatment — pull out specific images for separate downstream workflows without rebuilding your canvas.

---

## Nodes

**Scene Prompt Viewer** — the main node.
Scans a folder and shows one card per image: thumbnail, filename, dimensions, and an editable prompt textarea. Outputs a full batch and up to 8 individual sockets.

**Scene Output Saver** — the output node.
Takes the batch output and saves each image into a folder defined by a template (`{scene}/{date}_{version}`). Filenames follow the originals. Optionally writes a matching `prompt.txt` per image.

**Scene Prompt Text** — a small helper.
A multiline text box for feeding long prompts into `prompt_in_N` overrides. Use this instead of Primitive when your prompts are more than one line.

---

## Quick start

1. Drop **Scene Prompt Viewer** onto the canvas
2. Paste your image folder path into `image_folder`
3. Click **↻ Rescan** — one card appears per image
4. Write a prompt on each card (or leave blank if your workflow doesn't need them)
5. Connect `IMAGE` → your processing nodes → **Scene Output Saver**
6. Connect `filenames` directly to Scene Output Saver (skip over any processing nodes)
7. Set `scene` and `version` in Scene Output Saver
8. Queue

---

## Scene Prompt Viewer

### Inputs

| Field | Type | Description |
|-------|------|-------------|
| `image_folder` | STRING | Absolute path to a folder of `.jpg` `.jpeg` `.png` `.webp` |
| `sort_by` | COMBO | `filename_asc` (default) or `filename_desc` |
| `slot_count` | INT 0–8 | How many individual `image_N` / `prompt_N` sockets to expose |
| `prompt_in_1` … `prompt_in_8` | STRING (optional) | Connect to override that card's textarea — card becomes read-only when connected |

### Outputs

| Socket | Type | Description |
|--------|------|-------------|
| `IMAGE` | IMAGE | All non-hidden scenes as a batch |
| `prompts` | STRING | All non-hidden prompts, joined by `\n`, one per image |
| `filenames` | STRING | Original filenames (no extension), comma-separated — connect directly to Scene Output Saver |
| `image_1` … `image_8` | IMAGE | Individual scene outputs |
| `prompt_1` … `prompt_8` | STRING | Individual scene prompts |

### Toolbar

| Button | Action |
|--------|--------|
| ↻ Rescan | Re-scan folder, restore hidden scenes |
| 📂 Open | Open folder in file explorer |
| Import all prompts | Fill all cards from a pasted block |
| Export all prompts | Copy all prompts to clipboard |

### Per-card buttons

| Button | Action |
|--------|--------|
| ↻ | Reload this card's thumbnail |
| ✕ | Hide this scene for the session (Rescan to restore) |

---

## Scene Output Saver

Connect `IMAGE` from your last processing node, and `filenames` directly from Scene Prompt Viewer (bypassing any processing nodes in between).

### Inputs

| Socket | Type | Description |
|--------|------|-------------|
| `images` | IMAGE | Batch of processed images |
| `prompts` | STRING | (optional) Prompts to save alongside each image as `.txt` |
| `filenames` | STRING | Original filenames from Scene Prompt Viewer |

### Widgets

| Field | Default | Description |
|-------|---------|-------------|
| `output_root` | ComfyUI output folder | Root save directory — can be any absolute path |
| `folder_template` | `{scene}/{date}_{version}` | Subfolder structure — supports `{scene}` `{date}` `{version}` |
| `scene` | `scene` | Value for `{scene}` — use your project or batch name |
| `version` | `v1` | Value for `{version}` — change this each run to avoid overwriting |
| `filename_suffix` | _(empty)_ | Appended before the extension — `_upscale` → `pig_01_upscale.png` |
| `save_prompt_txt` | off | Write a `.txt` file alongside each image containing its prompt |
| `image_format` | `png` | png / jpg / webp |
| `jpg_quality` | `95` | jpg only |

**Folder template example** — `scene = CH01_forest`, `version = v2_warm`, `filename_suffix = _upscale`:
```
ComfyUI/output/CH01_forest/20260612_v2_warm/
  Hualien_sunset_upscale.png
  Taipei_nightview_upscale.png
  Kenting_beach_upscale.png
```

Change `version` each run (e.g. `v1`, `v2_warm`, `v3_final`) to keep iterations separate without overwriting previous results.

---

## Import / Export prompt formats

**Format A** — filename-mapped (recommended, order-independent):
```
scene_01.png | change to daytime, golden hour
scene_02.jpg | change to nighttime, neon lights
scene_03.webp | remove background, keep subject
```

**Format B** — one prompt per line, matched by scan order:
```
change to daytime, golden hour
change to nighttime, neon lights
remove background, keep subject
```

Both `|` and `｜` work. Format A is detected automatically if any line contains a filename.

---

## Known limitations

- **Open folder may open behind ComfyUI on Windows** — Alt-Tab to bring it forward
- **No folder picker dialog** — ComfyUI portable ships without `tkinter`; paste the path directly into `image_folder`
- **Max 8 individual sockets** — scenes 9+ are included in the batch outputs but have no individual socket
- **No subfolder scanning** — top-level files only
- **Large batches and VRAM** — the full image batch is sent downstream at once. For VRAM-heavy processing nodes, consider inserting a free memory node between processing steps, or keep batch sizes under 20 images

---

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/<your-username>/Comfyui-ScenePromptViewer.git
```

Restart ComfyUI. All nodes appear under **image → utils**.

No extra packages required — uses only what ComfyUI ships (`Pillow`, `torch`, `numpy`, `aiohttp`).

---

MIT License
