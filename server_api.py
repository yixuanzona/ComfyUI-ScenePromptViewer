"""
Server-side HTTP route for the Rescan button.

Registers `POST /scene_prompt_viewer/scan` on ComfyUI's aiohttp server.
The JS extension calls this when the user clicks "↻ Rescan" to fetch
the current folder contents + thumbnails without running the workflow.
"""

from __future__ import annotations

from pathlib import Path

from aiohttp import web
from PIL import Image

from .utils import clean_path, make_thumb_b64, scan_folder

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
                "thumbnail": make_thumb_b64(img),
            })
        except Exception as e:
            # Skip unreadable image, log a warning, continue with the rest.
            print(f"[ScenePromptViewer] WARNING: failed to thumb "
                  f"{fpath.name}: {e}")
            continue

    return web.json_response({"scenes": scenes})


# Register the route if the server is available. Import-time registration
# is the standard ComfyUI custom-node pattern.
if server is not None and getattr(server, "PromptServer", None) is not None:
    try:
        server.PromptServer.instance.routes.post(
            "/scene_prompt_viewer/scan"
        )(_scan_handler)
    except Exception as e:
        print(f"[ScenePromptViewer] WARNING: failed to register scan route: {e}")
