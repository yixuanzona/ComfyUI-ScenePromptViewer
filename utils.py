"""
Shared helpers used by both the node and the scan endpoint.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import List

from PIL import Image

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

# Base64 thumbnail size for UI preview (rendered at 96x72, sent at 2x).
THUMB_MAX = (192, 144)

# Max number of individual (image_N, prompt_N) output socket pairs.
MAX_SLOTS = 8


def scan_folder(folder: Path, sort_by: str = "filename_asc") -> List[Path]:
    """Return sorted list of supported image paths in `folder`."""
    files = [
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    ]
    files.sort(
        key=lambda p: p.name.lower(),
        reverse=(sort_by == "filename_desc"),
    )
    return files


def make_thumb_b64(img: Image.Image) -> str:
    """Return a base64-encoded JPEG thumbnail."""
    thumb = img.copy()
    thumb.thumbnail(THUMB_MAX, Image.LANCZOS)
    if thumb.mode != "RGB":
        thumb = thumb.convert("RGB")
    buf = io.BytesIO()
    thumb.save(buf, format="JPEG", quality=82, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def make_thumb_data(img: Image.Image) -> dict:
    """Return {thumbnail, width, height} for the UI scene record."""
    return {
        "thumbnail": make_thumb_b64(img),
        "width":     img.width,
        "height":    img.height,
    }


def clean_path(s: str) -> str:
    """Strip surrounding quotes and whitespace from a path string."""
    return s.strip().strip('"').strip("'")
