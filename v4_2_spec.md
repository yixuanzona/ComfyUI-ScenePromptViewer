# Scene Prompt Viewer v4.2 — Spec for Claude Code

A tiny experimental change to fix the overlapping-dots problem near
`prompt_in_1`. One line removal. Verify, and roll back if it breaks
anything else.

Read all existing files in `scene_prompt_viewer/` before starting:
`__init__.py`, `nodes.py`, `utils.py`, `server_api.py`,
`js/scene_prompt_viewer.js`. No Python changes — JS only.

---

## Context

The hidden widget `_internal_state` (renamed from `scene_data_json` in
v4.1) stores per-scene state as JSON. In `js/scene_prompt_viewer.js` it's
hidden using three flags:

```js
dataWidget.type = "hidden";
dataWidget.computeSize = () => [0, -4];
dataWidget.hidden = true;
```

The first flag (`type = "hidden"`) causes the new ComfyUI Vue frontend to
render this widget's "convert to input" indicator as a **small dot at the
top of the node's input socket area** — overlapping with the real
`prompt_in_1` socket. The other two flags handle suppressing the visible
widget body.

Hypothesis: removing the `type = "hidden"` line will make the indicator
fall back to the in-row `◀` style (like `sort_by` and `slot_count`),
while `computeSize` + `hidden` still suppress the widget body.

---

## The change

### In `js/scene_prompt_viewer.js`

Find this block (appears once, inside `onNodeCreated`):

```js
const dataWidget = this.widgets?.find(w => w.name === "_internal_state");
if (dataWidget) {
    dataWidget.type = "hidden";
    dataWidget.computeSize = () => [0, -4];
    dataWidget.hidden = true;
    dataWidget.value = JSON.stringify(this.sceneState);
}
```

**Delete just the `dataWidget.type = "hidden";` line.** Final result:

```js
const dataWidget = this.widgets?.find(w => w.name === "_internal_state");
if (dataWidget) {
    dataWidget.computeSize = () => [0, -4];
    dataWidget.hidden = true;
    dataWidget.value = JSON.stringify(this.sceneState);
}
```

That's the entire change. No other edits.

---

## Verification (in order)

After saving + restarting ComfyUI + reloading the workflow page:

1. **Check the top of the node**
   - PASS: Only the green `prompt_in_1` socket dot remains. No extra grey
     dot above or beside it.
   - PARTIAL: Grey dot still there but in a different position (e.g.,
     moved beside an `image_folder` / `sort_by` widget row as `◀`).
   - FAIL: Same as before — grey dot still on top of `prompt_in_1`.

2. **Check the body of the node**
   - PASS: Looks identical to before. No new giant JSON textarea visible.
   - FAIL: A new visible field (possibly tall) labelled `_internal_state`
     has appeared, containing a long JSON string.

3. **Functional check: Rescan**
   - Click ↻ Rescan. Cards should still populate normally.

4. **Functional check: persistence**
   - Save the workflow → close → reopen. The cards and any typed prompts
     should still be there.

5. **Functional check: connection**
   - Connect a `Scene Prompt Text` (or Primitive) to `prompt_in_1`. The
     card should still grey out with `← input override`.

---

## Outcomes and what to do next

### If verification 1 PASSES and 2-5 all PASS

Done. Ship it.

### If verification 1 is PARTIAL (dot moved, didn't disappear)

That's still progress — the dot is no longer overlapping `prompt_in_1`,
which solves the original click-targeting problem. Keep the change.

### If verification 2 FAILS (giant textarea appeared in the node body)

The `computeSize` + `hidden` flags were not enough on their own to
suppress the widget body on this user's ComfyUI version. **Roll back**
(see below) and we'll consider Option B (rewriting state into
`node.properties`) in a separate spec.

### If verification 1 FAILS (dot still in the same spot)

This means `type = "hidden"` wasn't the cause. **Roll back** and we'll
have to investigate differently. Report exactly what was observed.

### If verification 3, 4, or 5 FAILS

Something else broke. **Roll back** immediately.

---

## Rollback

Put the deleted line back. Open `js/scene_prompt_viewer.js`, find the
block, and restore `dataWidget.type = "hidden";` to its original position
as the first line of the `if (dataWidget)` body:

```js
const dataWidget = this.widgets?.find(w => w.name === "_internal_state");
if (dataWidget) {
    dataWidget.type = "hidden";          // ← restored
    dataWidget.computeSize = () => [0, -4];
    dataWidget.hidden = true;
    dataWidget.value = JSON.stringify(this.sceneState);
}
```

Save + restart ComfyUI + reload page. You're back to v4.1.

If you're using git, even simpler:

```bash
git diff js/scene_prompt_viewer.js   # see what changed
git checkout -- js/scene_prompt_viewer.js   # discard the change
```

---

## What NOT to do

- Don't add more flags to "compensate" if the change partially works.
  Stop and report. We'll plan the next step deliberately.
- Don't touch `nodes.py`, `__init__.py`, `utils.py`, or `server_api.py`.
- Don't modify `_internal_state`'s declaration in `INPUT_TYPES`.

---

End of spec.
