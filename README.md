# ComfyUI Scene Prompt Viewer

A ComfyUI custom node for pairing a folder of images with prompts in an
inline card UI. Each image gets its own editable textarea right next to its
thumbnail, with up to 8 individual output sockets plus a batch output.

![screenshot](docs/screenshot.png)
<!-- TODO: replace with an actual screenshot of the node in ComfyUI -->

## Features

- **Card-per-image layout** — every scanned image becomes a card with its
  own editable prompt textarea. No more juggling a separate prompt file.
- **8 individual output sockets** (`image_1` … `image_8`, `prompt_1` …
  `prompt_8`) plus a batch `IMAGE` and combined `prompts` output, so you
  can route specific scenes to different downstream branches.
- **Folder rescan** with a single button — the node calls a server-side
  endpoint to list the folder and stream back thumbnails.
- **Prompts persist with the workflow** — typed prompts are saved into
  the workflow JSON, keyed by filename, so they survive saves and reloads
  (and even survive folder rescans where the file still exists).
- **Import / Export** — paste a bulk prompt block in Format A
  (`filename | prompt`) or Format B (one prompt per line) to fill all
  cards at once; export everything back as text to the clipboard.

## Install

### Option 1 — Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/<your-username>/ComfyUI-ScenePromptViewer.git
```

Restart ComfyUI. The node appears under **image → utils → Scene Prompt
Viewer**.

### Option 2 — ComfyUI Manager

After the repo is registered, search for `ScenePromptViewer` in
ComfyUI Manager and click Install.

No additional Python packages required — uses only what ComfyUI already
ships (`Pillow`, `torch`, `numpy`, `aiohttp`).

## Usage

1. Paste the absolute path of your image folder into `image_folder`.
2. Click **↻ Rescan**. Thumbnails appear, one card per image.
3. Type a prompt into each card's textarea. (Or click **Import** to paste
   a bulk block.)
4. Connect the outputs you need:
   - `IMAGE` / `prompts` — all images and prompts as a batch
   - `image_N` / `prompt_N` — individual scenes (first 8 only)
5. Queue the workflow. The node re-reads the folder on every run, so
   files added after the last rescan still get processed (with empty
   prompts unless you fill them in and rescan).

### Prompt formats (for Import)

**Format A — filename mapping:**

```
scene_01.png | a lone figure on a cliff at dusk
scene_02.jpg | crowded night market with neon lights
scene_03.webp ｜ a misty pine forest at dawn
```

Half-width `|` and full-width `｜` both work, whitespace around the
separator doesn't matter, filename matching is case-insensitive.

**Format B — one prompt per line (matches scan order):**

```
a lone figure on a cliff at dusk
crowded night market with neon lights
a misty pine forest at dawn
```

### Connecting external prompt sources

Each visible `prompt_in_N` input socket on the left accepts any STRING
output. The package includes a helper node called **Scene Prompt Text**
under the same `image/utils` category — a simple multiline textarea
that's more comfortable than Primitive for long prompts.

If you'd rather use comfyui-easy-use's `easy positive` / `easy negative`,
or any other STRING source, they work too.

## Outputs

| Socket | Type | Description |
|--------|------|-------------|
| `IMAGE` | IMAGE | All scenes letterboxed to the first image's size, stacked as a batch |
| `prompts` | STRING | All prompts joined by `\n`, in batch order |
| `image_1` … `image_8` | IMAGE | Each of the first 8 scenes as a single-image batch |
| `prompt_1` … `prompt_8` | STRING | The corresponding prompt for each individual image socket |

Scenes beyond the 8th are visible in the card list (marked `batch`)
and included in the `IMAGE` batch, but have no individual socket.
Unused individual slots emit a same-size black image and an empty string.

## Behavior notes

- **Letterboxing**: all images are fit into the first image's dimensions
  with black padding so the batch tensor is uniform. To avoid letterboxing,
  put images of matching dimensions in the folder.
- **Empty prompts**: cards with empty textareas produce empty strings on
  the downstream output — feeding them into a CLIP text encoder will yield
  empty conditioning, not an error.
- **Rescan preserves prompts**: when you rescan, prompts attached to files
  that still exist are kept; prompts for missing files are kept in the
  state too, so they reappear if the file comes back.
- **Workflow file size**: thumbnails are stored in the workflow JSON
  (as base64 JPEGs, ~5–10 KB each). For 15 images expect roughly an extra
  100 KB in the saved workflow.

## Migrating from v4

In v4.1 the hidden internal-state widget was renamed from `scene_data_json`
to `_internal_state` (the leading underscore is a clear "private — don't
touch" signal in the right-click "Convert … to input" menu).

ComfyUI looks up saved widget values by name, so a workflow saved with v4
won't restore its card state into the renamed widget. The node still loads
fine — it just starts with an empty card list. Click **↻ Rescan** once to
repopulate the cards, then re-save the workflow. New v4.1 workflows are
unaffected.

## License

MIT — see [LICENSE](LICENSE).
