# File-Reference Prompt Support in the Editor

## Current Behaviour (confirmed by code)

### Schema (`schemas/prompt-schema.json`, line 199)
The `prompt` field accepts two forms:
1. **Inline text** — final-form prompt with context vars and slash commands
2. **File path** — a path to a `.prompt.md`, `.md`, or `.txt` file (absolute, workspace-relative, or `.flightpath/`-relative)

### Backend — `PromptFileParser.ts`
Already fully implemented. Key methods:
- `looksLikeFilePath(value)` — heuristic: must start with `./`, `../`, `/`, or `C:\` AND be the *only* thing in the string (no surrounding text), AND end with a known extension or any extension.
- `resolvePromptContent(value, promptFilePath)` — attempts to resolve and read the file; falls back to literal text with a warning if not found.
- Resolution order: absolute → relative to prompt file's dir → relative to workspace root → relative to `.flightpath/` dir.

### Frontend — `PromptEditor` + `CodeMirrorEditor`
No awareness of the file-path feature. The editor treats the `prompt` field as opaque text. A user can already type a path like `./prompts/analyze.prompt.md` into the editor and it *will* be sent as a file reference, but there is zero visual feedback that this is happening.

---

## UX Design Goals

1. **WYSIWYG parity** — the editor always shows the exact string stored in the `prompt` field. No hidden mode-switching or separate file-picker.
2. **Passive detection** — if the current text *happens* to be a lone file path (matching the same `looksLikeFilePath` heuristic), the editor visually signals it without requiring any user action.
3. **Progressive disclosure** — eventually an "Edit as file" button extracts inline text into a managed `.prompt.md` and replaces the editor content with the path.

---

## Proposed Implementation Plan

### Phase 1 — Passive Visual Indicator (minimal, high-value)

**Goal:** When the editor contains *only* a path string (no other text), show it as a styled link and display a badge/pill beneath the editor.

#### 1a. Shared path-detection utility
The webview already imports from the extension's source tree via the `@root/utils/*` alias (mapped to `src/utils/` in both `vite.config.ts` and `tsconfig.json`). This is already used for `FileReferenceParser`, `OutputHistoryTypes`, `DashboardConstants`, etc.

Extract `looksLikeFilePath` from `PromptFileParser.ts` (where it is a private method) into a new **shared** utility at:
```
src/utils/promptPathUtils.ts
```
The webview then imports it as `@root/utils/promptPathUtils`, and `PromptFileParser` imports it from the same location. **No duplication needed.** The utility must be pure (no `fs`, no `vscode` API calls) so it can run in both environments without side effects.

#### 1b. CodeMirror decoration for path-only content
In `CodeMirrorEditor.tsx`, add a CodeMirror `StateField` + `ViewPlugin` that:
- Watches the full document text on every document change
- Calls `looksLikeFilePath(doc.toString().trim())`
- If true: applies a `Decoration.mark` spanning the entire content with CSS class `cm-prompt-file-ref`

CSS in the webview Tailwind layer or a CodeMirror theme extension:
```css
.cm-prompt-file-ref {
  color: var(--vscode-textLink-foreground);
  text-decoration: underline;
  font-family: var(--vscode-editor-font-family);
}
```

#### 1c. File-ref badge below the editor
In `PromptEditor.tsx`, derive a boolean `isFileRef` from `promptText` using the shared util. Render a small badge between the editor and `EditorFooter`:

```tsx
{isFileRef && (
  <div className="file-ref-badge">
    <FileIcon size={12} />
    <span>File reference — prompt will be read from this path at execution</span>
  </div>
)}
```

This badge lives *outside* the CodeMirror viewport so it never interferes with typing.

#### 1d. Extension-side validation feedback (optional, later)
Send a `CHECK_FILE_REF` message to the extension host to confirm whether the referenced path actually exists, and return a `FILE_REF_STATUS` message with `{ exists: boolean, resolvedPath: string }`. The badge then shows ✓ or ✗. This is a nice-to-have and can be Phase 2.

---

### Phase 2 — "Edit as File" Button

**Goal:** One-click conversion of inline prompt text to a managed file reference.

When the editor content is *not* already a file path, show an "Edit as File" button in the `EditorFooter` (or as an icon button near the top-right of the editor).

#### Flow
1. User clicks **Edit as File**
2. Extension host receives `SAVE_PROMPT_TO_FILE` message with `{ text, suggestedName }`
3. Extension generates a filename from the prompt name or a timestamp:
   `.flightpath/prompts/<workflow-name>-<index>.prompt.md`
4. Writes the file, returns `PROMPT_SAVED_TO_FILE` with `{ relativePath: string }`
5. Editor replaces the full text with the relative path (e.g. `.flightpath/prompts/analyze-1.prompt.md`)
6. `isFileRef` becomes true → badge and link styling appear immediately

The inverse ("Inline this file") can be added symmetrically later: when `isFileRef` is true and the file can be found, read the file content and replace the path with the inline text.

---

### Phase 3 — Clickable Link / Open File

When `isFileRef` is true and the extension confirms the file exists, make the path in the CodeMirror editor a real clickable link:
- On click (or Ctrl+click), send `OPEN_FILE` message to extension → `vscode.workspace.openTextDocument(resolvedPath)`
- On hover, show a VS Code-style hover card with the first N lines of the file

---

## Files to Touch

| File | Change |
|---|---|
| `src/utils/promptPathUtils.ts` | New — shared `looksLikeFilePath` pure function (imported by both backend and webview via `@root/utils/promptPathUtils`) |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` | Add decoration plugin for path-only content |
| `src/ui/webview-react/components/editor/PromptEditor.tsx` | Derive `isFileRef`, render badge |
| `src/ui/webview-react/components/editor/EditorFooter.tsx` | Add "Edit as File" button (Phase 2) |
| `src/ui/FlightPathWebviewProvider.ts` | Handle `CHECK_FILE_REF` and `SAVE_PROMPT_TO_FILE` messages (Phase 2) |
| `src/types/WebviewMessageTypes.ts` | New message types for above (Phase 2) |
| `src/types/DashboardConstants.ts` | New `MESSAGE_TYPES` entries (Phase 2) |

No changes to `PromptFileParser.ts` or the schema — the backend already handles everything correctly.

---

## Design Decisions & Trade-offs

| Decision | Rationale |
|---|---|
| Always WYSIWYG — editor text == `prompt` field | Most intuitive; no hidden state or mode buttons |
| Detection heuristic extracted to `src/utils/promptPathUtils.ts` (single source) | The webview already imports from `src/utils/` via the `@root/utils/*` alias in `vite.config.ts`. No duplication needed — one file, two consumers. |
| Badge outside CodeMirror viewport | Avoids editor layout complexity; badge is informational, not interactive in Phase 1 |
| "Edit as File" writes to `.flightpath/prompts/` | Consistent with the existing prompts directory convention |
| No "file picker" mode | Picker introduces a second mental model; typing a path directly is already discoverable once the styling appears |

---

## Open Questions

1. **Path display**: Should the editor show the *resolved* (absolute) path or the *stored* (relative) path? Keep stored path — it's portable and matches what's in the file.
2. **Filename generation for "Edit as File"**: Use prompt `name` field → sanitized slug, fallback to `prompt-<timestamp>`. Avoid collisions with incrementing suffix.
3. **Sync concern**: If the referenced `.prompt.md` is edited externally, should FlightPath watch it and update token counts live? Out of scope for now.
4. ~~**`looksLikeFilePath` divergence**~~ — Not applicable. The utility lives in `src/utils/` which is a single source imported by both consumers; there is no copy to diverge.
