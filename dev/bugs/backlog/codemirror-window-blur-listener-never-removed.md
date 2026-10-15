# Window 'blur' listener is never removed: cleanup removes 'blur-sm' (Tailwind codemod artifact)

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`
- **Severity:** low

## Symptom

Each time a `CodeMirrorEditor` unmounts, it leaves a `blur` listener attached to `window`. These listeners build up for the life of the webview, and every one of them runs (as a no-op) whenever the window loses focus. Each one also keeps its closure and the component's `viewRef` object from being garbage-collected.

## Steps to Reproduce

1. Open the dashboard and select a step so a prompt editor mounts.
2. Switch between steps or workflows, or toggle bulk mode, several times so the `CodeMirrorEditor` mounts and unmounts repeatedly.
3. In the webview devtools, run `getEventListeners(window).blur`. The count goes up by one with each unmount and never goes down.

## Root Cause

The orphaned-MouseSelection teardown effect adds the listener with one event name and removes it with another:

```ts
window.addEventListener("blur", teardown);        // :563
// ...
window.removeEventListener("blur-sm", teardown);  // :566
```

`"blur-sm"` never matches `"blur"`, so `removeEventListener` does nothing. This looks like a Tailwind v4 class-rename codemod (`blur` -> `blur-sm`) that also rewrote an event-name string. The comments at :554 and :1194 show the same rewrite.

The impact is small. The view effect's cleanup sets `viewRef.current = null` (:1107), so a leaked `teardown` does nothing when it fires and never touches a destroyed view.

## Suggested Fix

- On line 566, change `"blur-sm"` to `"blur"`, and change `` `blur-sm` `` back to `` `blur` `` in the comments at :554 and :1194.
- Optionally, keep the event names in one place (a constant, or a loop over `[["keydown", true], ["blur", false]]`) so the add and remove calls can't drift apart.
- Add a Vitest test that mounts and unmounts the editor and checks that `window.removeEventListener` was called with `"blur"`.
- Search the webview for other event-name strings that picked up a Tailwind suffix (`-sm`, `-xs`).
