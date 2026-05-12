// Scene Prompt Viewer — frontend extension (v3).
//
// Card-per-scene layout: each image scanned from the folder becomes a card
// with thumbnail + editable prompt textarea. State is serialised into the
// hidden `scene_data_json` widget so it persists with the workflow.
//
// Talks to the server-side scan endpoint at /scene_prompt_viewer/scan
// when the user clicks ↻ Rescan.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MAX_SLOTS = 8;
const SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

// ----------------------------------------------------------------------- //
// Style constants (kept inline to avoid bundling a CSS file)
// ----------------------------------------------------------------------- //
const COLORS = {
    bgList:        "#111",
    bgCard:        "#181818",
    bgCardActive:  "#1a1f28",
    borderCard:    "#2a2a2a",
    borderActive:  "#4a7ab0",
    bgInput:       "#0e0e0e",
    borderInput:   "#333",
    text:          "#ddd",
    muted:         "#888",
    dim:           "#555",
    success:       "#5DCAA5",
    error:         "#d05656",
    accent:        "#4a7ab0",
    accentBg:      "#2d4a6b",
    accentBorder:  "#4a7ab0",
    accentText:    "#cde3f5",
    btnBg:         "#2a2a2a",
    btnBorder:     "#555",
    btnText:       "#bbb",
};

// ----------------------------------------------------------------------- //
// Helpers
// ----------------------------------------------------------------------- //
function looksLikeImageFilename(s) {
    const lower = (s || "").trim().toLowerCase();
    return SUPPORTED_EXTS.some(ext => lower.endsWith(ext));
}

/**
 * Parse a pasted prompt block into a {filename: prompt} map, respecting
 * the same Format A / Format B logic as the v2 Python parser. Used by the
 * Import button.
 */
function parsePromptText(text, scenes) {
    const lines = text.split("\n").map(l => l.replace(/｜/g, "|"));
    const nonEmpty = lines.filter(l => l.trim());

    const isFormatA = nonEmpty.some(l => {
        if (!l.includes("|")) return false;
        return looksLikeImageFilename(l.split("|", 1)[0]);
    });

    const prompts = {};

    if (isFormatA) {
        // build lookup of canonical filename (preserve original casing)
        const byLower = new Map();
        for (const s of scenes) {
            byLower.set(s.filename.toLowerCase(), s.filename);
        }
        for (const line of nonEmpty) {
            if (!line.includes("|")) continue;
            const idx = line.indexOf("|");
            const left  = line.slice(0, idx).trim().toLowerCase();
            const right = line.slice(idx + 1).trim();
            if (!looksLikeImageFilename(left)) continue;
            const canonical = byLower.get(left);
            if (canonical) prompts[canonical] = right;
        }
    } else {
        // Format B: line N → scene N (after sort order)
        for (let i = 0; i < Math.min(nonEmpty.length, scenes.length); i++) {
            prompts[scenes[i].filename] = nonEmpty[i].trim();
        }
    }
    return prompts;
}

function applyStyle(el, css) {
    el.style.cssText = css;
    return el;
}

function makeButton(label, variant = "default") {
    const btn = document.createElement("button");
    btn.textContent = label;
    const isAccent = variant === "accent";
    btn.style.cssText = `
        background: ${isAccent ? COLORS.accentBg : COLORS.btnBg};
        border: 1px solid ${isAccent ? COLORS.accentBorder : COLORS.btnBorder};
        color: ${isAccent ? COLORS.accentText : COLORS.btnText};
        font-size: 11px;
        padding: 5px 10px;
        border-radius: 3px;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
    `;
    return btn;
}

// ----------------------------------------------------------------------- //
// Card builder
// ----------------------------------------------------------------------- //
function buildCard(scene, index, prompt, isBatchOnly, onPromptChange) {
    const card = document.createElement("div");
    applyStyle(card, `
        background: ${COLORS.bgCard};
        border: 1px solid ${COLORS.borderCard};
        border-radius: 4px;
        padding: 8px;
        display: flex;
        gap: 10px;
        align-items: stretch;
        min-height: 90px;
    `);

    // index column (number + socket hint)
    const indexCol = document.createElement("div");
    applyStyle(indexCol, `
        flex: 0 0 36px;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: 2px;
        gap: 2px;
    `);
    const indexNum = document.createElement("div");
    applyStyle(indexNum, `
        color: ${COLORS.muted};
        font-size: 13px;
        font-weight: 500;
    `);
    indexNum.textContent = String(index).padStart(2, "0");
    indexCol.appendChild(indexNum);

    const socketHint = document.createElement("div");
    if (isBatchOnly) {
        applyStyle(socketHint, `font-size: 10px; color: ${COLORS.dim}; margin-top: 4px; text-align: center;`);
        socketHint.textContent = "batch";
        socketHint.title = "This scene is only available via the IMAGE batch output (beyond individual socket limit)";
    } else {
        applyStyle(socketHint, `font-size: 10px; color: ${COLORS.accent}; margin-top: 4px;`);
        socketHint.textContent = `→ #${index}`;
        socketHint.title = `Available at image_${index} and prompt_${index} output sockets`;
    }
    indexCol.appendChild(socketHint);
    card.appendChild(indexCol);

    // thumbnail
    const thumb = document.createElement("img");
    thumb.src = `data:image/jpeg;base64,${scene.thumbnail}`;
    thumb.alt = scene.filename;
    applyStyle(thumb, `
        flex: 0 0 96px;
        width: 96px;
        height: 72px;
        object-fit: cover;
        border-radius: 3px;
        background: #000;
        display: block;
        align-self: flex-start;
    `);
    card.appendChild(thumb);

    // right column: filename + textarea
    const rightCol = document.createElement("div");
    applyStyle(rightCol, `
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    `);

    const fname = document.createElement("div");
    applyStyle(fname, `
        font-size: 11px;
        color: ${COLORS.muted};
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    `);
    fname.textContent = scene.filename;
    rightCol.appendChild(fname);

    const textarea = document.createElement("textarea");
    textarea.value = prompt || "";
    textarea.placeholder = "(type prompt here…)";
    textarea.spellcheck = false;
    applyStyle(textarea, `
        flex: 1 1 auto;
        min-height: 60px;
        background: ${COLORS.bgInput};
        border: 1px solid ${COLORS.borderInput};
        border-radius: 3px;
        padding: 5px 6px;
        color: ${COLORS.text};
        font-family: monospace;
        font-size: 11px;
        line-height: 1.45;
        resize: vertical;
        outline: none;
        box-sizing: border-box;
        white-space: pre-wrap;
        word-break: break-word;
    `);

    textarea.addEventListener("focus", () => {
        card.style.borderColor = COLORS.borderActive;
        card.style.background = COLORS.bgCardActive;
        textarea.style.borderColor = COLORS.borderActive;
    });
    textarea.addEventListener("blur", () => {
        card.style.borderColor = COLORS.borderCard;
        card.style.background = COLORS.bgCard;
        textarea.style.borderColor = COLORS.borderInput;
    });
    textarea.addEventListener("input", () => {
        onPromptChange(scene.filename, textarea.value);
    });

    rightCol.appendChild(textarea);
    card.appendChild(rightCol);
    return card;
}

// ----------------------------------------------------------------------- //
// Main extension
// ----------------------------------------------------------------------- //
app.registerExtension({
    name: "ScenePromptViewer",

    async beforeRegisterNodeDef(nodeType, nodeData /*, app */) {
        if (nodeData?.name !== "ScenePromptViewer") return;

        // ---- onNodeCreated --------------------------------------------- //
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            // Initial state: empty scenes list, empty prompts map.
            this.sceneState = { scenes: [], prompts: {} };

            // Find the auto-created scene_data_json widget and hide it.
            const dataWidget = this.widgets?.find(w => w.name === "scene_data_json");
            if (dataWidget) {
                // hide visually but keep in widget list for serialisation
                dataWidget.type = "hidden";
                dataWidget.computeSize = () => [0, -4];
                dataWidget.hidden = true;
                dataWidget.value = JSON.stringify(this.sceneState);
            }
            this._dataWidget = dataWidget;

            // ----- DOM widget container ----- //
            const wrapper = document.createElement("div");
            applyStyle(wrapper, `
                display: flex;
                flex-direction: column;
                gap: 8px;
                width: 100%;
                font-family: monospace;
            `);

            // toolbar row
            const toolbar = document.createElement("div");
            applyStyle(toolbar, "display: flex; gap: 6px; align-items: center;");

            const rescanBtn = makeButton("↻ Rescan", "accent");
            const importBtn = makeButton("Import");
            const exportBtn = makeButton("Export");

            const statusEl = document.createElement("div");
            applyStyle(statusEl, `
                flex: 1;
                color: ${COLORS.muted};
                font-size: 11px;
                text-align: right;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                padding-left: 8px;
            `);
            statusEl.textContent = "(no scan yet)";

            toolbar.appendChild(rescanBtn);
            toolbar.appendChild(importBtn);
            toolbar.appendChild(exportBtn);
            toolbar.appendChild(statusEl);
            wrapper.appendChild(toolbar);

            // card list
            const cardList = document.createElement("div");
            applyStyle(cardList, `
                display: flex;
                flex-direction: column;
                gap: 6px;
                max-height: 880px;
                overflow-y: auto;
                background: ${COLORS.bgList};
                border: 1px solid #333;
                border-radius: 4px;
                padding: 6px;
                min-height: 140px;
                box-sizing: border-box;
            `);
            wrapper.appendChild(cardList);

            this._spvWrapper   = wrapper;
            this._spvCardList  = cardList;
            this._spvStatus    = statusEl;
            this._spvRescanBtn = rescanBtn;

            // ----- helpers bound to this node ----- //
            const persistState = () => {
                if (this._dataWidget) {
                    this._dataWidget.value = JSON.stringify(this.sceneState);
                }
            };

            const refreshStatus = (extra) => {
                const total = this.sceneState.scenes.length;
                if (total === 0) {
                    statusEl.textContent = extra || "(no scan yet)";
                    statusEl.style.color = extra ? COLORS.error : COLORS.muted;
                    return;
                }
                let filled = 0;
                for (const s of this.sceneState.scenes) {
                    const p = this.sceneState.prompts[s.filename] || "";
                    if (p.trim()) filled++;
                }
                let text = `${filled} / ${total} filled`;
                if (total > MAX_SLOTS) {
                    text += ` · slots ${MAX_SLOTS + 1}-${total} batch-only`;
                }
                if (extra) text = `${extra} · ${text}`;
                statusEl.textContent = text;
                statusEl.style.color =
                    (filled === total) ? COLORS.success : COLORS.muted;
            };

            const renderCards = () => {
                cardList.innerHTML = "";
                const scenes = this.sceneState.scenes;

                if (!scenes || scenes.length === 0) {
                    const empty = document.createElement("div");
                    applyStyle(empty, `
                        padding: 28px 12px;
                        color: ${COLORS.dim};
                        font-size: 11px;
                        text-align: center;
                    `);
                    empty.textContent =
                        "Fill image_folder above, then click ↻ Rescan to load scenes.";
                    cardList.appendChild(empty);
                    refreshStatus();
                    return;
                }

                scenes.forEach((scene, idx) => {
                    const i = idx + 1;
                    const currentPrompt = this.sceneState.prompts[scene.filename] || "";
                    const card = buildCard(
                        scene,
                        i,
                        currentPrompt,
                        i > MAX_SLOTS,
                        (fname, val) => {
                            this.sceneState.prompts[fname] = val;
                            persistState();
                            refreshStatus();
                        }
                    );
                    cardList.appendChild(card);
                });

                refreshStatus();
            };
            this._renderCards = renderCards;

            // ----- Rescan button ----- //
            rescanBtn.addEventListener("click", async () => {
                const folderWidget = this.widgets?.find(w => w.name === "image_folder");
                const sortWidget   = this.widgets?.find(w => w.name === "sort_by");
                const folder = (folderWidget?.value || "").trim();
                const sortBy = sortWidget?.value || "filename_asc";

                if (!folder) {
                    refreshStatus("image_folder is empty");
                    return;
                }

                rescanBtn.disabled = true;
                rescanBtn.textContent = "Scanning…";
                statusEl.style.color = COLORS.muted;
                statusEl.textContent = "Scanning…";

                try {
                    const resp = await api.fetchApi("/scene_prompt_viewer/scan", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ folder, sort_by: sortBy }),
                    });
                    if (!resp.ok) {
                        let msg = `HTTP ${resp.status}`;
                        try {
                            const err = await resp.json();
                            msg = err.error || msg;
                        } catch {}
                        refreshStatus(`error: ${msg}`);
                        return;
                    }
                    const data = await resp.json();
                    const newScenes = Array.isArray(data.scenes) ? data.scenes : [];

                    // Replace scenes; keep prompts (keyed by filename) so prompts
                    // for files that still exist are preserved across rescans.
                    this.sceneState.scenes = newScenes;
                    persistState();
                    renderCards();
                } catch (e) {
                    console.error("[ScenePromptViewer] rescan failed", e);
                    refreshStatus(`error: ${e.message || e}`);
                } finally {
                    rescanBtn.disabled = false;
                    rescanBtn.textContent = "↻ Rescan";
                }
            });

            // ----- Import button ----- //
            importBtn.addEventListener("click", () => {
                if (this.sceneState.scenes.length === 0) {
                    refreshStatus("rescan first to populate scene list");
                    return;
                }
                const text = window.prompt(
                    "Paste a prompt block.\n\n" +
                    "Format A — filename mapping:\n" +
                    "  001.png | a quiet forest at dawn\n" +
                    "  002.png | a cyberpunk alley with neon\n\n" +
                    "Format B — one prompt per line (matches scan order):\n" +
                    "  a quiet forest at dawn\n" +
                    "  a cyberpunk alley with neon\n\n" +
                    "Half-width | and full-width ｜ both work.",
                    ""
                );
                if (text === null || text === "") return;
                const parsed = parsePromptText(text, this.sceneState.scenes);
                if (Object.keys(parsed).length === 0) {
                    refreshStatus("import: no matches found");
                    return;
                }
                Object.assign(this.sceneState.prompts, parsed);
                persistState();
                renderCards();
            });

            // ----- Export button ----- //
            exportBtn.addEventListener("click", async () => {
                if (this.sceneState.scenes.length === 0) {
                    refreshStatus("nothing to export");
                    return;
                }
                const lines = this.sceneState.scenes.map(s => {
                    const p = this.sceneState.prompts[s.filename] || "";
                    return `${s.filename} | ${p}`;
                });
                const text = lines.join("\n");

                try {
                    await navigator.clipboard.writeText(text);
                    const original = exportBtn.textContent;
                    exportBtn.textContent = "✓ Copied";
                    setTimeout(() => { exportBtn.textContent = original; }, 1500);
                } catch (e) {
                    // Fallback for non-secure contexts.
                    window.prompt(
                        "Clipboard unavailable — copy the text below manually:",
                        text
                    );
                }
            });

            // Add the DOM widget to the node.
            this.addDOMWidget("scene_cards", "div", wrapper, {
                serialize: false,
                hideOnZoom: false,
            });

            // Default node width.
            const DEFAULT_W = 620;
            const current = this.size || [200, 100];
            if (current[0] < DEFAULT_W) {
                this.size = [DEFAULT_W, current[1]];
            }

            // initial paint
            renderCards();

            return r;
        };

        // ---- onConfigure: restore from saved workflow ------------------ //
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);

            // ComfyUI has restored widget values by now. Pull the saved JSON
            // and rebuild the card list from it.
            const dataWidget = this.widgets?.find(w => w.name === "scene_data_json");
            if (dataWidget?.value) {
                try {
                    const state = JSON.parse(dataWidget.value);
                    this.sceneState = {
                        scenes:  Array.isArray(state.scenes) ? state.scenes : [],
                        prompts: (state.prompts && typeof state.prompts === "object")
                                    ? state.prompts : {},
                    };
                } catch {
                    this.sceneState = { scenes: [], prompts: {} };
                }
            }
            this._renderCards?.();
            return r;
        };

        // ---- onExecuted: refresh status from python's response --------- //
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (!message) return;

            // Mirror python's status text into the UI status line.
            const statusArr = message.status;
            const statusText = Array.isArray(statusArr) ? statusArr[0] : statusArr;
            if (this._spvStatus && statusText) {
                this._spvStatus.textContent = statusText;
                this._spvStatus.style.color = COLORS.success;
            }
        };
    },
});
