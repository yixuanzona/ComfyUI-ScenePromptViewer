"""
Server-side HTTP routes for the Scene Prompt Viewer UI.

Registers the following on ComfyUI's aiohttp server:
  POST /scene_prompt_viewer/scan          — full folder scan (Rescan button)
  POST /scene_prompt_viewer/scan_single   — re-fetch one image (↻ per card)
  POST /scene_prompt_viewer/open_folder   — open folder in OS file explorer

The JS extension calls these without running the workflow.
"""

from __future__ import annotations

import platform
import subprocess
from pathlib import Path

from aiohttp import web
from PIL import Image

from .utils import (
    SUPPORTED_EXTS,
    clean_path,
    make_thumb_data,
    scan_folder,
)

try:
    # importing server registers PromptServer.instance
    import server  # type: ignore
except Exception as e:
    print(f"[ScenePromptViewer] WARNING: could not import ComfyUI server: {e}")
    server = None


async def _scan_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response(
            {"error": "request body is not valid JSON"}, status=400
        )

    folder_str = clean_path(str(data.get("folder", "")))
    sort_by = str(data.get("sort_by", "filename_asc"))
    if sort_by not in ("filename_asc", "filename_desc"):
        sort_by = "filename_asc"

    if not folder_str:
        return web.json_response(
            {"error": "image_folder is empty"}, status=400
        )

    folder = Path(folder_str)
    if not folder.is_dir():
        return web.json_response(
            {"error": f"folder not found: {folder_str}"}, status=404
        )

    image_paths = scan_folder(folder, sort_by)
    if not image_paths:
        return web.json_response(
            {"error": "no supported images (.jpg/.jpeg/.png/.webp) in folder"},
            status=200,  # not an error — just an empty result
        )

    scenes = []
    for fpath in image_paths:
        try:
            img = Image.open(fpath)
            img.load()
            scenes.append({
                "filename": fpath.name,
                **make_thumb_data(img),
            })
        except Exception as e:
            # Skip unreadable image, log a warning, continue with the rest.
            print(f"[ScenePromptViewer] WARNING: failed to thumb "
                  f"{fpath.name}: {e}")
            continue

    return web.json_response({"scenes": scenes})


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


# Register the route if the server is available. Import-time registration
# is the standard ComfyUI custom-node pattern.
if server is not None and getattr(server, "PromptServer", None) is not None:
    try:
        routes = server.PromptServer.instance.routes
        routes.post("/scene_prompt_viewer/scan")(_scan_handler)
        routes.post("/scene_prompt_viewer/scan_single")(_scan_single_handler)
        routes.post("/scene_prompt_viewer/open_folder")(_open_folder_handler)
    except Exception as e:
        print(f"[ScenePromptViewer] WARNING: failed to register routes: {e}")
