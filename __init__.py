"""
Scene Prompt Viewer — ComfyUI custom node (v3).

Per-image editable prompt cards, folder rescan via API, up to 8 individual
output sockets plus a batch output.
"""

from .nodes import ScenePromptViewer
from . import server_api  # noqa: F401  (registers HTTP route on import)

NODE_CLASS_MAPPINGS = {
    "ScenePromptViewer": ScenePromptViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScenePromptViewer": "Scene Prompt Viewer",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
