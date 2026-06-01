"""
ScenePromptViewer v3 node implementation.

The node's JS side renders a card per scanned image with an inline editable
textarea. All per-image prompts are kept in a JSON payload stored in a hidden
widget (`_internal_state`), which gets passed to this `execute()` method when
the workflow runs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch
from PIL import Image

from .utils import (
    MAX_SLOTS,
    SUPPORTED_EXTS,
    clean_path,
    scan_folder,
)


class ScenePromptViewer:
    """
    Read a folder of images, pair each with a prompt typed directly into
    the node's card UI, and expose every scene as both a batch and (up to 8)
    individual image/prompt output sockets.
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            f"prompt_in_{i}": ("STRING", {"forceInput": True, "multiline": True})
            for i in range(1, MAX_SLOTS + 1)
        }
        return {
            "required": {
                "image_folder": ("STRING", {
                    "default": "",
                    "multiline": False,
                }),
                "sort_by": (
                    ["filename_asc", "filename_desc"],
                    {"default": "filename_asc"},
                ),
                "slot_count": ("INT", {
                    "default": 1,
                    "min": 0,
                    "max": MAX_SLOTS,
                    "step": 1,
                }),
                # Hidden in the UI by the JS extension; stores the per-image
                # prompts and thumbnail cache as a JSON string. The leading
                # underscore signals "private — do not convert to input".
                "_internal_state": ("STRING", {
                    "default": "{}",
                    "multiline": True,
                }),
            },
            "optional": optional,
        }

    RETURN_TYPES = (
        "IMAGE", "STRING",
        *(("IMAGE", "STRING") * MAX_SLOTS),
    )
    RETURN_NAMES = (
        "IMAGE", "prompts",
        *(
            f"{kind}_{i + 1}"
            for i in range(MAX_SLOTS)
            for kind in ("image", "prompt")
        ),
    )
    FUNCTION = "execute"
    CATEGORY = "image/utils"
    OUTPUT_NODE = True

    # ------------------------------------------------------------------ #
    # main entry
    # ------------------------------------------------------------------ #
    def execute(
        self,
        image_folder: str,
        sort_by: str,
        slot_count: int,
        _internal_state: str,
        **kwargs,
    ):
        folder_str = clean_path(image_folder)
        folder = Path(folder_str)
        if not folder.is_dir():
            raise FileNotFoundError(
                f"image_folder does not exist or is not a directory: {folder_str}"
            )

        # 1. parse the prompt map + hidden set from the JS widget JSON
        prompts_map, hidden_set = self._parse_state(_internal_state)

        # 2. scan folder fresh — files may have been added/removed since
        #    the last rescan in the UI.
        image_paths = scan_folder(folder, sort_by)
        if not image_paths:
            raise ValueError(
                f"No supported images (.jpg/.jpeg/.png/.webp) in: {folder_str}"
            )

        # 3. load images, pair with prompts by filename
        paired: List[Tuple[str, str, Image.Image]] = []
        load_failures: List[str] = []

        for fpath in image_paths:
            prompt_text = prompts_map.get(fpath.name.lower(), "")
            try:
                img = Image.open(fpath)
                img.load()
                img = img.convert("RGB")
            except Exception as e:
                print(f"[ScenePromptViewer] WARNING: failed to load "
                      f"{fpath.name}: {e}")
                load_failures.append(fpath.name)
                continue
            paired.append((fpath.name, prompt_text, img))

        if not paired:
            raise ValueError(
                "All images failed to load — check console for warnings."
            )

        # 4. letterbox to first image's dimensions
        target_w, target_h = paired[0][2].size

        # Per-slot data (kept in original scan order, Y-mode)
        slot_tensors:  List[torch.Tensor] = []   # for individual outputs
        slot_prompts:  List[str]          = []
        batch_tensors: List[torch.Tensor] = []   # IMAGE batch (filters hidden)
        batch_prompts: List[str]          = []
        scene_data:    List[dict]         = []
        filled = empty = hidden_count = 0

        for i, (fname, prompt_text, img) in enumerate(paired, start=1):
            is_hidden = fname.lower() in hidden_set
            # External per-slot override wins over the card textarea.
            override = kwargs.get(f"prompt_in_{i}")
            final_prompt = override if isinstance(override, str) else prompt_text

            if is_hidden:
                hidden_count += 1
                # Slot N gets a black image + empty prompt (gap preserved)
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
                "index":      i,
                "filename":   fname,
                "prompt":     prompt_text,
                "hidden":     is_hidden,
                "has_socket": i <= MAX_SLOTS,
            })

        # 5. build outputs
        # Batch: only non-hidden scenes. If everything is hidden, still produce
        # a valid tensor (single black frame) so downstream nodes don't error.
        if batch_tensors:
            image_batch = torch.stack(batch_tensors, dim=0)
        else:
            image_batch = torch.zeros(
                (1, target_h, target_w, 3), dtype=torch.float32
            )
        combined_prompt = "\n".join(batch_prompts)

        # Individual outputs (Y-mode: indexed by original position)
        individual: list = []
        black = torch.zeros(
            (1, target_h, target_w, 3), dtype=torch.float32
        )
        for i in range(MAX_SLOTS):
            if i < len(slot_tensors):
                individual.append(slot_tensors[i].unsqueeze(0))  # [1,H,W,C]
                individual.append(slot_prompts[i])
            else:
                individual.append(black)
                individual.append("")

        # status text
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

        return {
            "ui": {
                "scene_data": scene_data,
                "status":     [status],
                "slot_count": [slot_count],
                "max_slots":  [MAX_SLOTS],
            },
            "result": (image_batch, combined_prompt, *individual),
        }

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _parse_state(scene_data_json: str) -> Tuple[Dict[str, str], set]:
        """
        Returns ({filename_lower: prompt}, {filename_lower hidden set}).
        Returns ({}, set()) on any parse failure.
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

    @staticmethod
    def _letterbox(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
        if img.size == (target_w, target_h):
            return img
        sw, sh = img.size
        scale = min(target_w / sw, target_h / sh)
        nw = max(1, int(round(sw * scale)))
        nh = max(1, int(round(sh * scale)))
        resized = img.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGB", (target_w, target_h), (0, 0, 0))
        canvas.paste(resized, ((target_w - nw) // 2, (target_h - nh) // 2))
        return canvas
