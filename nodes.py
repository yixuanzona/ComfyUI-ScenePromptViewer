"""
ScenePromptViewer v3 node implementation.

The node's JS side renders a card per scanned image with an inline editable
textarea. All per-image prompts are kept in a JSON payload stored in a hidden
widget (`scene_data_json`), which gets passed to this `execute()` method when
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
            f"prompt_in_{i}": ("STRING", {"forceInput": True})
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
                # prompts and thumbnail cache as a JSON string.
                "scene_data_json": ("STRING", {
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
        scene_data_json: str,
        **kwargs,
    ):
        folder_str = clean_path(image_folder)
        folder = Path(folder_str)
        if not folder.is_dir():
            raise FileNotFoundError(
                f"image_folder does not exist or is not a directory: {folder_str}"
            )

        # 1. parse the prompt map from the JS widget JSON
        prompts_map = self._parse_prompts_map(scene_data_json)

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

        tensors: List[torch.Tensor] = []
        output_prompts: List[str] = []
        scene_data: List[dict] = []
        filled = empty = 0

        for i, (fname, prompt_text, img) in enumerate(paired, start=1):
            # External per-slot override wins over the card textarea.
            override = kwargs.get(f"prompt_in_{i}")
            final_prompt = override if isinstance(override, str) else prompt_text

            if final_prompt.strip():
                filled += 1
            else:
                empty += 1
            output_prompts.append(final_prompt)

            fitted = self._letterbox(img, target_w, target_h)
            arr = np.asarray(fitted, dtype=np.float32) / 255.0
            tensors.append(torch.from_numpy(arr))

            scene_data.append({
                "index": i,
                "filename": fname,
                "prompt": prompt_text,
                "has_socket": i <= MAX_SLOTS,
            })

        # 5. build outputs
        image_batch = torch.stack(tensors, dim=0)
        combined_prompt = "\n".join(output_prompts)

        individual: list = []
        black = torch.zeros(
            (1, target_h, target_w, 3), dtype=torch.float32
        )
        for i in range(MAX_SLOTS):
            if i < len(tensors):
                individual.append(tensors[i].unsqueeze(0))  # [1,H,W,C]
                individual.append(output_prompts[i])
            else:
                individual.append(black)
                individual.append("")

        # status text
        total = len(paired)
        status = f"{filled} / {total} filled"
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
    def _parse_prompts_map(scene_data_json: str) -> Dict[str, str]:
        """
        Extract the {filename_lower: prompt} map from the widget JSON.
        Returns an empty dict on any parse failure.
        """
        if not scene_data_json:
            return {}
        try:
            state = json.loads(scene_data_json)
        except (json.JSONDecodeError, TypeError):
            return {}
        if not isinstance(state, dict):
            return {}
        prompts = state.get("prompts", {})
        if not isinstance(prompts, dict):
            return {}
        return {
            k.lower(): v
            for k, v in prompts.items()
            if isinstance(k, str) and isinstance(v, str)
        }

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
