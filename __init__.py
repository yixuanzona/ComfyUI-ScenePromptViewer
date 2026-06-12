"""
Scene Prompt Viewer — ComfyUI custom node (v3).

Per-image editable prompt cards, folder rescan via API, up to 8 individual
output sockets plus a batch output.
"""

from .nodes import ScenePromptViewer
from .prompt_text_node import ScenePromptText
from .scene_output_saver import SceneOutputSaver
from . import server_api  # noqa: F401  (registers HTTP route on import)

NODE_CLASS_MAPPINGS = {
    "ScenePromptViewer": ScenePromptViewer,
    "ScenePromptText":   ScenePromptText,
    "SceneOutputSaver":  SceneOutputSaver,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScenePromptViewer": "Scene Prompt Viewer",
    "ScenePromptText":   "Scene Prompt Text",
    "SceneOutputSaver":  "Scene Output Saver",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
