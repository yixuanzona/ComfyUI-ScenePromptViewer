"""
Scene Output Saver — ComfyUI custom node (v1.0).

Terminal (sink) node. Takes an IMAGE batch plus parallel prompt / filename
streams from Scene Prompt Viewer, expands a folder template, and writes each
image to disk alongside an optional `.txt` holding its prompt.

See scene_output_saver_v1_0_spec.md for the contract.
"""

from __future__ import annotations

import datetime
import re
from pathlib import Path
from typing import List

import numpy as np
import torch
from PIL import Image

try:
    import folder_paths  # provided by ComfyUI at runtime
except ImportError:  # pragma: no cover — only missing outside ComfyUI
    folder_paths = None

from .utils import clean_path


def _default_output_root() -> str:
    """ComfyUI's output dir, resolved at node-registration time. Falls back to
    a relative path when folder_paths isn't importable (e.g. unit tests)."""
    if folder_paths is not None:
        try:
            return folder_paths.get_output_directory()
        except Exception:
            pass
    return "./output/scenes"

# Folder-template variables resolved per workflow run.
_FOLDER_VARS = {"scene", "date", "version"}

_VAR_RE = re.compile(r"\{(\w+)\}")

# Pillow save settings per format. jpg_quality only feeds JPEG (per spec).
_FORMAT_EXT = {"png": "png", "jpg": "jpg", "webp": "webp"}


def _expand_template(template: str, mapping: dict) -> str:
    """
    Replace every `{var}` that exists in `mapping`. Unknown variables are left
    verbatim and logged (spec §8), so a typo'd template fails loudly-ish rather
    than silently dropping a path segment.
    """
    def repl(m: re.Match) -> str:
        key = m.group(1)
        if key in mapping:
            return str(mapping[key])
        print(f"[SceneOutputSaver] WARNING: unknown template variable "
              f"'{{{key}}}' left unexpanded.")
        return m.group(0)

    return _VAR_RE.sub(repl, template)


def _tensor_to_pil(img_tensor: torch.Tensor) -> Image.Image:
    """[H,W,C] float (0..1) tensor → PIL Image (RGB or RGBA)."""
    arr = img_tensor.detach().cpu().numpy()
    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        return Image.fromarray(arr, mode="L").convert("RGB")
    channels = arr.shape[-1]
    if channels == 4:
        return Image.fromarray(arr, mode="RGBA")
    if channels == 1:
        return Image.fromarray(arr[..., 0], mode="L").convert("RGB")
    return Image.fromarray(arr[..., :3], mode="RGB")


class SceneOutputSaver:
    """
    Save an IMAGE batch into a templated folder, one prompt.txt per image.
    No output sockets — this is an OUTPUT_NODE sink.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                # Defaults to ComfyUI's output dir; user may override with any
                # absolute (or relative) path.
                "output_root": ("STRING", {"default": _default_output_root()}),
                "folder_template": ("STRING", {
                    "default": "{scene}/{date}_{version}",
                }),
                "scene": ("STRING", {"default": "scene"}),
                "version": ("STRING", {"default": "v1"}),
                # Appended to each stem before the extension. Supports
                # template vars — notably {index} (3-digit batch order).
                # "" → pig_01.png ; "_upscale" → pig_01_upscale.png ;
                # "_{index}" → pig_01_001.png
                "filename_suffix": ("STRING", {"default": ""}),
                "save_prompt_txt": ("BOOLEAN", {"default": True}),
                "image_format": (["png", "jpg", "webp"], {"default": "png"}),
                "jpg_quality": ("INT", {
                    "default": 95, "min": 1, "max": 100, "step": 1,
                }),
            },
            "optional": {
                # Both arrive from Scene Prompt Viewer's batch outputs.
                # prompts: newline-joined (SD prompts contain commas, so the
                # main node joins with "\n" — we split on the same).
                # filenames: comma-joined stems (no extension).
                "prompts": ("STRING", {"forceInput": True}),
                "filenames": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "image/utils"
    OUTPUT_NODE = True

    # ------------------------------------------------------------------ #
    def execute(
        self,
        images: torch.Tensor,
        output_root: str,
        folder_template: str,
        scene: str,
        version: str,
        filename_suffix: str,
        save_prompt_txt: bool,
        image_format: str,
        jpg_quality: int,
        prompts: str = "",
        filenames: str = "",
    ):
        n = int(images.shape[0])

        # 1. resolve per-image prompts (split on newline — matches main node)
        prompt_list = self._split_prompts(prompts, n)

        # 2. resolve per-image filenames (comma-separated stems), with fallback
        name_list = self._resolve_filenames(filenames, n)

        # 3. expand folder template → absolute target dir
        date_str = datetime.datetime.now().strftime("%Y%m%d")
        mapping = {"scene": scene, "date": date_str, "version": version}
        folder_rel = _expand_template(folder_template, mapping)

        root = Path(clean_path(output_root)).expanduser()
        target_dir = (root / folder_rel) if folder_rel else root
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise RuntimeError(
                f"[SceneOutputSaver] cannot create output folder "
                f"'{target_dir}': {e}"
            ) from e

        ext = _FORMAT_EXT.get(image_format, "png")
        save_kwargs = self._save_kwargs(image_format, jpg_quality)

        # 4. write each image (+ optional prompt.txt)
        for i in range(n):
            # {original stem}{suffix} — suffix may embed {index} (and any of
            # the folder vars), expanded per image.
            suffix = _expand_template(
                filename_suffix,
                {**mapping, "index": f"{i + 1:03d}"},
            )
            base = name_list[i] + suffix
            img = _tensor_to_pil(images[i])
            if image_format in ("jpg", "webp") and img.mode == "RGBA":
                img = img.convert("RGB")

            img_path = target_dir / f"{base}.{ext}"
            img.save(img_path, **save_kwargs)

            if save_prompt_txt:
                txt_path = target_dir / f"{base}.txt"
                txt_path.write_text(prompt_list[i], encoding="utf-8")

        print(f"[SceneOutputSaver] saved {n} image(s) to {target_dir}")
        return {}

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _split_prompts(prompts: str, n: int) -> List[str]:
        """N prompts, one per image. Missing → '', extras dropped (spec §8)."""
        if not prompts:
            items: List[str] = []
        else:
            items = prompts.split("\n")
        if len(items) != n:
            print(f"[SceneOutputSaver] WARNING: prompts count "
                  f"({len(items)}) != image count ({n}); "
                  f"padding/truncating to match.")
        out = [items[i] if i < len(items) else "" for i in range(n)]
        return out

    @staticmethod
    def _resolve_filenames(filenames: str, n: int) -> List[str]:
        """
        N filename stems. Each missing/blank slot falls back to image_00X
        (spec §8). Extras beyond N are ignored.
        """
        raw = [s.strip() for s in filenames.split(",")] if filenames else []
        # Strip a stray extension if one slipped through.
        raw = [Path(s).stem if s else "" for s in raw]
        if len([s for s in raw if s]) != n:
            print(f"[SceneOutputSaver] WARNING: filenames count "
                  f"({len([s for s in raw if s])}) != image count ({n}); "
                  f"filling gaps with image_00X.")
        out: List[str] = []
        for i in range(n):
            stem = raw[i] if i < len(raw) else ""
            out.append(stem if stem else f"image_{i + 1:03d}")
        return out

    @staticmethod
    def _save_kwargs(image_format: str, jpg_quality: int) -> dict:
        if image_format == "jpg":
            return {"format": "JPEG", "quality": int(jpg_quality)}
        if image_format == "webp":
            return {"format": "WEBP"}
        return {"format": "PNG"}
