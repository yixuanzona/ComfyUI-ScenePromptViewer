// Scene Prompt Viewer — frontend extension (v3).
//
// Card-per-scene layout: each image scanned from the folder becomes a card
// with thumbnail + editable prompt textarea. State is serialised into the
// hidden `_internal_state` widget so it persists with the workflow.
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

// ----------------------------------------------------------------------- //
// Dynamic socket visibility (slot_count widget)
// ----------------------------------------------------------------------- //
function ensureOutputVisible(node, name, type, shouldExist) {
    const idx = node.outputs
        ? node.outputs.findIndex(o => o.name === name)
        : -1;
    if (shouldExist && idx === -1) {
        node.addOutput(name, type);
    } else if (!shouldExist && idx !== -1) {
        node.removeOutput(idx);
    }
}

function ensureInputVisible(node, name, type, shouldExist) {
    const idx = node.inputs
        ? node.inputs.findIndex(inp => inp.name === name)
        : -1;
    if (shouldExist && idx === -1) {
        node.addInput(name, type);
    } else if (!shouldExist && idx !== -1) {
        node.removeInput(idx);
    }
}

function applySlotCount(node, n) {
    n = Math.max(0, Math.min(MAX_SLOTS, n | 0));
    for (let i = 1; i <= MAX_SLOTS; i++) {
        ensureOutputVisible(node, `image_${i}`,    "IMAGE",  i <= n);
        ensureOutputVisible(node, `prompt_${i}`,   "STRING", i <= n);
        ensureInputVisible(node,  `prompt_in_${i}`, "STRING", i <= n);
    }
    // Newly-added sockets need correct (hide) labels applied.
    if (node._hiddenScenes && node.sceneState?.scenes) {
        syncHiddenSocketLabels(node, node._hiddenScenes, node.sceneState.scenes);
    }
    node.setDirtyCanvas(true, true);
}

// ----------------------------------------------------------------------- //
// Hidden-socket label sync — mark sockets of hidden scenes with "(hide)"
// ----------------------------------------------------------------------- //
function syncHiddenSocketLabels(node, hiddenScenes, scenes) {
    // For each scene that occupies a slot, mark or unmark its sockets.
    // Slots beyond what scenes occupy: leave their labels alone
    // (those are "unused", not "hidden" — different state).
    const sceneByIndex = new Map();   // 1-based slot → scene
    scenes.forEach((s, idx) => sceneByIndex.set(idx + 1, s));

    for (let i = 1; i <= MAX_SLOTS; i++) {
        const scene = sceneByIndex.get(i);
        const isHidden = scene && hiddenScenes.has(scene.filename);

        const setLabel = (slot, baseName) => {
            if (!slot) return;
            slot.label = isHidden ? `${baseName} (hide)` : undefined;
        };

        setLabel(
            node.outputs?.find(o => o.name === `image_${i}`),
            `image_${i}`
        );
        setLabel(
            node.outputs?.find(o => o.name === `prompt_${i}`),
            `prompt_${i}`
        );
        setLabel(
            node.inputs?.find(inp => inp.name === `prompt_in_${i}`),
            `prompt_in_${i}`
        );
    }
    node.setDirtyCanvas(true, true);
}

// ----------------------------------------------------------------------- //
// Custom modal for "Import all prompts"
// ----------------------------------------------------------------------- //
function showImportModal(initialText, onSubmit) {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.65);
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: monospace;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
        width: 600px;
        max-width: 92vw;
        max-height: 92vh;
        background: #232323;
        border: 1px solid #444;
        border-radius: 6px;
        padding: 18px;
        color: ${COLORS.text};
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    `;
    overlay.appendChild(dialog);

    const title = document.createElement("div");
    title.textContent = "Import all prompts";
    title.style.cssText = "font-size: 14px; font-weight: 500; color: #fff;";
    dialog.appendChild(title);

    const help = document.createElement("div");
    help.style.cssText =
        "font-size: 11px; color: #999; line-height: 1.6; white-space: pre-line;";
    help.textContent =
        "Format A — filename mapping:\n" +
        "  001.png | a quiet forest at dawn\n" +
        "  002.png | a cyberpunk alley with neon\n\n" +
        "Format B — one prompt per line (matches scan order):\n" +
        "  a quiet forest at dawn\n" +
        "  a cyberpunk alley with neon\n\n" +
        "Half-width | and full-width ｜ both work. Case-insensitive.";
    dialog.appendChild(help);

    const textarea = document.createElement("textarea");
    textarea.value = initialText || "";
    textarea.spellcheck = false;
    textarea.style.cssText = `
        flex: 1 1 auto;
        min-height: 320px;
        background: ${COLORS.bgInput};
        border: 1px solid #444;
        border-radius: 3px;
        padding: 8px 10px;
        color: ${COLORS.text};
        font-family: monospace;
        font-size: 12px;
        line-height: 1.55;
        resize: vertical;
        outline: none;
        box-sizing: border-box;
        white-space: pre-wrap;
        word-break: break-word;
    `;
    dialog.appendChild(textarea);

    const footer = document.createElement("div");
    footer.style.cssText =
        "display: flex; gap: 8px; justify-content: flex-end;";
    const cancelBtn = makeButton("Cancel");
    const submitBtn = makeButton("Import", "accent");
    footer.appendChild(cancelBtn);
    footer.appendChild(submitBtn);
    dialog.appendChild(footer);

    const hint = document.createElement("div");
    hint.style.cssText =
        "font-size: 10px; color: #666; text-align: right;";
    hint.textContent = "ESC to cancel · Ctrl+Enter to import";
    dialog.appendChild(hint);

    const close = () => {
        document.removeEventListener("keydown", keyHandler);
        overlay.remove();
    };
    const submit = () => {
        const val = textarea.value;
        close();
        onSubmit(val);
    };
    const keyHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
        }
    };

    cancelBtn.addEventListener("click", close);
    submitBtn.addEventListener("click", submit);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener("keydown", keyHandler);

    document.body.appendChild(overlay);
    setTimeout(() => textarea.focus(), 0);
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

function makeCardIconButton(label, tooltip) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = tooltip;
    btn.style.cssText = `
        width: 22px;
        height: 22px;
        background: rgba(80, 80, 80, 0.6);
        border: 1px solid #555;
        color: #ccc;
        font-size: 12px;
        border-radius: 3px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        font-family: inherit;
    `;
    return btn;
}

// ----------------------------------------------------------------------- //
// Card builder
// ----------------------------------------------------------------------- //
function buildCard(scene, index, prompt, isBatchOnly, isOverridden,
                   onPromptChange, onReload, onHide) {
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
    card.style.position = "relative";  // for absolute-positioned actions

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

    const fnameRow = document.createElement("div");
    applyStyle(fnameRow, `
        display: flex;
        align-items: baseline;
        gap: 6px;
        line-height: 1.5;
        min-height: 18px;
        padding-right: 56px;   /* reserve space for action buttons in corner */
    `);

    const fname = document.createElement("span");
    applyStyle(fname, `
        font-size: 11px;
        color: ${COLORS.muted};
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1 1 auto;
        min-width: 0;
    `);
    fname.textContent = scene.filename;
    fnameRow.appendChild(fname);

    // Dimensions tag (present only after a v4.3+ scan)
    if (scene.width && scene.height) {
        const dims = document.createElement("span");
        applyStyle(dims, `
            font-size: 10px;
            color: ${COLORS.dim};
            flex: 0 0 auto;
            white-space: nowrap;
        `);
        dims.textContent = `${scene.width}×${scene.height}`;
        fnameRow.appendChild(dims);
    }

    rightCol.appendChild(fnameRow);

    // Override badge on its own row below the filename row
    if (isOverridden) {
        const overrideRow = document.createElement("div");
        applyStyle(overrideRow, `
            font-size: 10px;
            color: ${COLORS.accent};
            font-style: italic;
            line-height: 1.4;
            margin-top: -2px;
        `);
        overrideRow.textContent = "← input override";
        rightCol.appendChild(overrideRow);
    }

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

    if (isOverridden) {
        textarea.disabled = true;
        textarea.style.opacity = "0.4";
        textarea.style.cursor = "not-allowed";
        textarea.title =
            "Overridden by connected input — typed text is ignored";
    }

    rightCol.appendChild(textarea);
    card.appendChild(rightCol);

    // ----- per-card action bar (top-right) ----- //
    const actions = document.createElement("div");
    applyStyle(actions, `
        position: absolute;
        top: 4px;
        right: 4px;
        display: flex;
        gap: 4px;
        z-index: 1;
    `);

    const reloadBtn = makeCardIconButton("↻", "Reload this image's thumbnail");
    reloadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onReload(scene.filename);
    });
    actions.appendChild(reloadBtn);

    const hideBtn = makeCardIconButton("✕", "Hide this scene for this session");
    hideBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onHide(scene.filename);
    });
    hideBtn.addEventListener("mouseenter", () => {
        hideBtn.style.background = "rgba(180, 60, 60, 0.7)";
        hideBtn.style.borderColor = "#a04040";
    });
    hideBtn.addEventListener("mouseleave", () => {
        hideBtn.style.background = "rgba(80, 80, 80, 0.6)";
        hideBtn.style.borderColor = "#555";
    });
    actions.appendChild(hideBtn);

    card.appendChild(actions);
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

            // Session-only hidden set (filenames). Cleared on rescan/reload.
            this._hiddenScenes = new Set();

            // Find the auto-created _internal_state widget and hide it.
            const dataWidget = this.widgets?.find(w => w.name === "_internal_state");
            if (dataWidget) {
                // hide visually but keep in widget list for serialisation
                dataWidget.computeSize = () => [0, -4];
                dataWidget.hidden = true;
                dataWidget.value = JSON.stringify(this.sceneState);
            }
            this._dataWidget = dataWidget;

            // Cache the slot_count widget so renderCards / refreshStatus can
            // read it; hook its callback to dynamically toggle socket visibility.
            const slotCountWidget = this.widgets?.find(
                w => w.name === "slot_count"
            );
            this._spvSlotCountWidget = slotCountWidget;
            if (slotCountWidget) {
                const origCallback = slotCountWidget.callback;
                slotCountWidget.callback = (v, ...rest) => {
                    origCallback?.call(slotCountWidget, v, ...rest);
                    applySlotCount(this, parseInt(v) || 0);
                    this._renderCards?.();
                };
            }

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
            const openFolderBtn = makeButton("📂 Open");
            openFolderBtn.title = "Open the image folder in your OS file explorer";
            const importBtn = makeButton("Import all prompts");
            const exportBtn = makeButton("Export all prompts");

            const statusEl = document.createElement("div");
            applyStyle(statusEl, `
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
            toolbar.appendChild(openFolderBtn);   // ← between Rescan and Import
            toolbar.appendChild(importBtn);
            toolbar.appendChild(exportBtn);
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
            wrapper.appendChild(statusEl);

            this._spvWrapper   = wrapper;
            this._spvCardList  = cardList;
            this._spvStatus    = statusEl;
            this._spvRescanBtn = rescanBtn;

            // ----- helpers bound to this node ----- //
            const persistState = () => {
                if (!this._dataWidget) return;
                const payload = {
                    scenes:  this.sceneState.scenes,
                    prompts: this.sceneState.prompts,
                    hidden:  Array.from(this._hiddenScenes),  // session-only
                };
                this._dataWidget.value = JSON.stringify(payload);
            };

            // Reload one scene's thumbnail without rescanning the folder.
            this._reloadScene = async (filename) => {
                const folderWidget = this.widgets?.find(w => w.name === "image_folder");
                const folder = (folderWidget?.value || "").trim();
                if (!folder) return;
                try {
                    const resp = await api.fetchApi("/scene_prompt_viewer/scan_single", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ folder, filename }),
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({}));
                        refreshStatus(`reload failed: ${err.error || resp.statusText}`);
                        return;
                    }
                    const data = await resp.json();
                    // Replace just this scene in the state; keep order.
                    const idx = this.sceneState.scenes.findIndex(s => s.filename === filename);
                    if (idx >= 0) {
                        this.sceneState.scenes[idx] = data;
                        persistState();
                        renderCards();
                    }
                } catch (e) {
                    refreshStatus(`reload error: ${e.message || e}`);
                }
            };

            // Hide one scene for this session (gap preserved in numbering).
            this._hideScene = (filename) => {
                this._hiddenScenes.add(filename);
                persistState();
                renderCards();
            };

            const getSlotCount = () => {
                const w = this._spvSlotCountWidget;
                const raw = w ? w.value : MAX_SLOTS;
                const n = parseInt(raw);
                if (Number.isNaN(n)) return MAX_SLOTS;
                return Math.max(0, Math.min(MAX_SLOTS, n));
            };

            const refreshStatus = (extra) => {
                const total = this.sceneState.scenes.length;
                if (total === 0) {
                    statusEl.textContent = extra || "(no scan yet)";
                    statusEl.style.color = extra ? COLORS.error : COLORS.muted;
                    return;
                }
                const hidden = this._hiddenScenes.size;
                let filled = 0;
                for (const s of this.sceneState.scenes) {
                    if (this._hiddenScenes.has(s.filename)) continue;
                    const p = this.sceneState.prompts[s.filename] || "";
                    if (p.trim()) filled++;
                }
                const visible = total - hidden;
                const slotCount = getSlotCount();
                let text = `${filled} / ${visible} filled`;
                if (hidden > 0) text += ` · ${hidden} hidden (rescan to restore)`;
                if (total > slotCount) {
                    text += ` · slots ${slotCount + 1}-${total} batch-only`;
                }
                if (extra) text = `${extra} · ${text}`;
                statusEl.textContent = text;
                statusEl.style.color =
                    (filled === visible && visible > 0) ? COLORS.success : COLORS.muted;
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

                const slotCount = getSlotCount();
                scenes.forEach((scene, idx) => {
                    // Hidden scenes are skipped, but their index slot is kept
                    // (original 1-based numbering — gaps remain after hides).
                    if (this._hiddenScenes.has(scene.filename)) return;
                    const i = idx + 1;
                    const currentPrompt =
                        this.sceneState.prompts[scene.filename] || "";
                    const inputSlot = this.inputs?.find(
                        inp => inp.name === `prompt_in_${i}`
                    );
                    const isOverridden = inputSlot?.link != null;
                    const card = buildCard(
                        scene,
                        i,
                        currentPrompt,
                        i > slotCount,
                        isOverridden,
                        (fname, val) => {
                            this.sceneState.prompts[fname] = val;
                            persistState();
                            refreshStatus();
                        },
                        (fname) => this._reloadScene(fname),   // ↻
                        (fname) => this._hideScene(fname),     // ✕
                    );
                    cardList.appendChild(card);
                });

                refreshStatus();
                syncHiddenSocketLabels(this, this._hiddenScenes, this.sceneState.scenes);
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
                    this._hiddenScenes.clear();   // rescan restores hidden cards
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

            // ----- Open folder button ----- //
            openFolderBtn.addEventListener("click", async () => {
                const folderWidget = this.widgets?.find(w => w.name === "image_folder");
                const folder = (folderWidget?.value || "").trim();
                if (!folder) {
                    refreshStatus("image_folder is empty");
                    return;
                }
                try {
                    const resp = await api.fetchApi("/scene_prompt_viewer/open_folder", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ folder }),
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({}));
                        refreshStatus(`open failed: ${err.error || resp.statusText}`);
                    }
                } catch (e) {
                    refreshStatus(`open error: ${e.message || e}`);
                }
            });

            // ----- Import button ----- //
            importBtn.addEventListener("click", () => {
                if (this.sceneState.scenes.length === 0) {
                    refreshStatus("rescan first to populate scene list");
                    return;
                }
                showImportModal("", (text) => {
                    if (!text || !text.trim()) return;
                    const parsed = parsePromptText(text, this.sceneState.scenes);
                    if (Object.keys(parsed).length === 0) {
                        refreshStatus("import: no matches found");
                        return;
                    }
                    Object.assign(this.sceneState.prompts, parsed);
                    persistState();
                    renderCards();
                });
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

            // Defer to next tick so widgets are fully wired before we mutate
            // the node's input/output lists.
            setTimeout(() => {
                applySlotCount(this, getSlotCount());
                this._renderCards?.();
            }, 0);

            return r;
        };

        // ---- onConnectionsChange: refresh card override state ---------- //
        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (
            type, slotIndex, connected, linkInfo, ioSlot
        ) {
            onConnectionsChange?.apply(this, arguments);
            if (ioSlot?.name?.startsWith("prompt_in_")) {
                this._renderCards?.();
            }
        };

        // ---- onConfigure: restore from saved workflow ------------------ //
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);

            // ComfyUI has restored widget values by now. Pull the saved JSON
            // and rebuild the card list from it.
            const dataWidget = this.widgets?.find(w => w.name === "_internal_state");
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

            // Hidden state is session-only: always start fresh, and re-persist
            // immediately to strip any saved hidden list from the widget value.
            this._hiddenScenes = new Set();
            if (this._dataWidget) {
                this._dataWidget.value = JSON.stringify({
                    scenes:  this.sceneState.scenes,
                    prompts: this.sceneState.prompts,
                    hidden:  [],
                });
            }

            // Re-apply socket visibility from the restored slot_count value.
            const slotCountWidget = this.widgets?.find(
                w => w.name === "slot_count"
            );
            this._spvSlotCountWidget = slotCountWidget;
            if (slotCountWidget) {
                applySlotCount(this, parseInt(slotCountWidget.value) || 0);
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
