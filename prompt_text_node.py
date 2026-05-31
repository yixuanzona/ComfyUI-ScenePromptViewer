"""
ScenePromptText — a tiny multiline STRING source node.

Designed to feed into ScenePromptViewer's prompt_in_N input sockets when
you want a per-slot prompt that's typed externally. More ergonomic than
Primitive for multi-line prompts.
"""

from __future__ import annotations


class ScenePromptText:
    """Multiline text → STRING output. Nothing fancy."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "Type prompt here…",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("STRING",)
    FUNCTION = "execute"
    CATEGORY = "image/utils"

    def execute(self, text: str):
        return (text,)
