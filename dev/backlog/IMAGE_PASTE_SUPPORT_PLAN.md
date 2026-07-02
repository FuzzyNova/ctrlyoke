# Image Paste Support Plan

## Overview

Let users paste a clipboard image directly into the prompt editor
(`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`). The pasted image is
written to `.ctrlyoke/temp/` by the extension host, and a normal `@relativePath` file
reference to that image is inserted into the editor at the cursor — no new prompt syntax,
no new expansion path. The image is **not** rendered inline inside the CodeMirror editor
itself (explicitly out of scope per user preference); instead, once the prompt is submitted
and echoed back as a `CliHeaderRow` in
`src/ui/webview-react/components/layout/output-section/OutputPane.tsx`, the echoed prompt
text renders an inline thumbnail for any `@path` reference that resolves to an image file.

## Current State: How Images Already Reach a Harness

ctrlyoke already has a working path for handing a harness an image, and understanding it is
the key design constraint for this feature: **ctrlyoke never reads the image's bytes.**

- `ContextExpander.expandContextSplit()` (used on the real execution path, called from
  `HarnessIntegration.buildPromptSections()`) splits a plain `@path` reference with no line
  range into `directFileRefs: string[]` — just the resolved absolute path, existence-checked
  via `fs.access`, never read as content.
- CLI harnesses (`CliIntegration.formatDirectFileRef`) turn each `directFileRef` into a
  provider-formatted reference string (`@relativePath` for Copilot/Claude/Qwen/Gemini, a bare
  path with no `@` for Codex) and splice it into the prompt text the CLI process receives as
  an argument. **The CLI subprocess itself reads the file off disk** — whatever it does with
  image bytes (vision encoding, etc.) is entirely its own responsibility.
- The chat harness (`CopilotChatIntegration.attachFileToChat`) doesn't even pass a text
  reference — it calls `vscode.commands.executeCommand("workbench.action.chat.attachFile", uri)`,
  the same native "attach file" action a user would trigger by hand.

This is why file-reference-based image passing already works today, and it's the path this
feature reuses. The other expansion path, `ContextExpander.expandContext()` /
`buildAttachmentXml()` (used only by the token-count preview in
`WebviewMessageRouter.handleAttachmentTokenCountRequest`), reads file content with
`fs.readFile(path, "utf8")` — that would corrupt binary image bytes. **Nothing in this
feature should route a pasted image through that path.**

There is no harness capability registry anywhere in the codebase (`ICliProvider` has no
vision/image flag, grepping `src/core/harness/**` and `src/types/**` for
`vision`/`image`/capability flags returns nothing). This feature does not attempt to add one
— see [Harness Compatibility](#harness-compatibility).

## 1. Capturing Paste — `CodeMirrorEditor.tsx`

There is currently no paste or drop handling anywhere in `CodeMirrorEditor.tsx` or the rest
of `src/ui/webview-react` — this is greenfield. Add a new extension,
`createImagePasteExtension(vscode, mode)`, included only when `mode === "prompt"`, using
`EditorView.domEventHandlers({ paste: (event, view) => { ... } })`:

1. Inspect `event.clipboardData.items` for entries whose `type` starts with `image/`. If none
   exist, return `false` and let CodeMirror's default paste behavior run unchanged.
2. If image items are found, `event.preventDefault()`. For each image item (supports pasting
   more than one image at once, e.g. a multi-file clipboard), read it via `item.getAsFile()`
   and `FileReader.readAsDataURL()`, then strip the `data:<mime>;base64,` prefix.
3. Map MIME type → extension (`image/png` → `png`, `image/jpeg` → `jpg`, `image/gif` → `gif`,
   `image/webp` → `webp`; reject anything else with a visible error, no silent fallback).
4. Enforce a size cap (e.g. 15 MB) on the decoded buffer before sending — reject oversized
   pastes with a clear inline error rather than shipping a huge base64 payload through
   `postMessage`.
5. Insert a placeholder token at the paste position immediately (e.g. `[Pasting image…]`),
   and track its `{ from, to }` range in a ref. Because saving the file is an async round trip
   to the extension host, the user may keep typing before the response arrives — update the
   tracked range through every subsequent transaction via
   `update.changes.mapPos(from)` / `mapPos(to, 1)` in the existing `EditorView.updateListener`,
   the same way `lastOverflowRef`-style refs are kept current elsewhere in this file.
6. Send `MESSAGE_TYPES.SAVE_PASTED_IMAGE` with a `seq` (reusing the existing
   `completionSeqRef`-style sequencing pattern from `customCompletions`), await the response on
   the existing `window.addEventListener("message", ...)` handler, and on success replace the
   tracked placeholder range with the returned `@relativePath` reference (existing
   `cm-link`/`cm-prompt-file-ref` decoration and click-to-open behavior apply automatically —
   see [Reusing Existing Decoration](#reusing-existing-decoration)). On failure, replace the
   placeholder with nothing and surface the error via `WebviewLog.error` plus whatever
   user-visible notification channel the editor already uses for other failures.

### Reusing Existing Decoration

Because the inserted text is just a normal `@relativePath.png` reference, it's picked up for
free by the file-reference regexes already in this file (`findContextReferenceMatches`'s
`fullFile` pattern) and decorated by the existing `createLinkDecorationExtension` /
`createFileRefDecorationExtension` machinery — no new CodeMirror decoration code is needed.
Clicking it already opens the image in VS Code via the existing click handler
(`createClickHandlerExtension`). Context-reference *linting* (`createContextReferenceLintExtension`)
also applies unchanged — an image ref that gets deleted from disk (e.g. after the 24h cleanup
sweep) will surface the same "context not found" warning as any other stale `@path`.

## 2. Saving the Image — Extension Host

### `src/utils/TempFileManager.ts`

Every existing write method (`createPromptFile`, `createCategoryFile`, etc.) writes text via
`fs.promises.writeFile(path, content, "utf-8")`. Add a dedicated binary-write method:

```typescript
async createPastedImageFile(data: Buffer, extension: string): Promise<string> {
  await this.ensureTempDir();
  const timestamp = Date.now();
  const filename = `${timestamp}-pasted-image-${randomSuffix()}.${extension}`;
  const filePath = path.join(this.tempDir, filename);
  await fs.promises.writeFile(filePath, data); // no encoding — raw bytes
  return filePath;
}
```

The `-pasted-image-` marker in the filename (not just the extension) is deliberate — see
[Cleanup](#3-cleanup--tempfilemanagerts) below.

### `src/ui/WebviewMessageRouter.ts`

Register `SAVE_PASTED_IMAGE` in the message dispatch table (same shape as the
`REQUEST_COMPLETIONS` / `VALIDATE_CONTEXT_REFS` entries): decode the incoming base64 payload
to a `Buffer`, call `tempFileManager.createPastedImageFile()`, resolve the workspace-relative
path via `tempFileManager.getRelativePath()`, and `emitMessage({ type: PASTED_IMAGE_SAVED, relativePath, seq })`.
On any failure (write error, oversized payload slipping through, disallowed MIME), respond
with `{ type: PASTED_IMAGE_SAVED, seq, error: string }` instead of introducing a second
message type — mirrors how other seq-correlated responses in this codebase carry an optional
error rather than branching into a separate failure message type.

Add a no-op registration for `PASTED_IMAGE_SAVED` in `useMessageHandler.ts`, matching the
existing comment there explaining that `CodeMirrorEditor` listens for `COMPLETIONS_RESPONSE`
directly rather than through the central dispatcher.

## 3. Cleanup — `TempFileManager.ts`

`cleanupOrphanedFiles()` currently only sweeps files ending in `.md`, files starting with
`mcp-config`, and `.json` files inside `*-notifications/` subdirectories — a pasted `.png`
would never be swept. Widen the predicate to also match the `-pasted-image-` filename marker
regardless of extension, rather than broadly allow-listing image extensions (which could
sweep up unrelated binary files a user happens to have dropped in `.ctrlyoke/temp/`).

Note that pasted-image refs become `directFileRefs`, which — per
`HarnessIntegration.deleteTempFiles()` — are **never** deleted per-turn; that method only
unlinks files it created for that turn (agent/skills/context/excerpts/prompt categories).
This is consistent with how any other `@path` reference to a pre-existing file is treated
(ctrlyoke doesn't own or delete files it didn't create for that step), so pasted images
correctly fall back to the 24h orphan sweep rather than needing new per-turn lifecycle code.

## 4. Displaying Inline Thumbnails — `OutputPane.tsx` / `MarkdownText.tsx`

`OutputPane` renders a step's echoed prompt via `CliHeaderRowView` in
`src/ui/webview-react/components/output/OutputRow.tsx`, which delegates text rendering to
`MarkdownText` (`src/ui/webview-react/components/output/MarkdownText.tsx`). `MarkdownText`
already has a house pattern for exactly this problem: `remarkFileLinks()` rewrites recognized
file paths into a custom `<file-ref path="...">` HTML node instead of a real `<a>`/`<img>`,
specifically to **bypass** `rehype-sanitize` and `rehype-harden` — real `<img>` tags are
intentionally stripped/hardened by that pipeline because this renderer displays untrusted
AI-generated text, and an AI could otherwise embed an external image URL as a tracking pixel
or data-exfiltration vector.

Follow the same pattern rather than re-enabling `<img>`:

- Add a sibling plugin (or extend `remarkFileLinks`) that checks whether a matched path's
  extension is in an image allow-list (`png`, `jpg`, `jpeg`, `gif`, `webp`) and, if so, emits
  `<image-ref path="...">` instead of `<file-ref path="...">`.
- Add `"image-ref": ["path"]` to `FILE_REF_ALLOWED_TAGS` so `rehype-sanitize` keeps it.
- Add an `"image-ref"` entry to the `components` map (next to the existing `"file-ref"` →
  `FileRefButton` entry) rendering a new `ImageRefThumbnail` component.

### `ImageRefThumbnail`

The webview cannot resolve a workspace-relative path to a displayable URI on its own — it
needs `webview.asWebviewUri()`, which only the extension host can call. On mount,
`ImageRefThumbnail` sends a new seq-correlated request (`REQUEST_FILE_PREVIEW_URI` /
`FILE_PREVIEW_URI_RESPONSE`, same pattern as `customCompletions`) and caches the resolved URI
by path (module-level `Map` or a small slice of the Zustand output store, so re-renders during
scroll/virtualization don't re-request). The extension-side handler must validate the
requested path resolves inside the workspace (reuse `ContextExpander`'s workspace-path
resolution helper) before returning a URI — this endpoint must not become a way to leak
arbitrary filesystem paths as "images" into the webview.

If the extension host reports the file no longer exists (temp file already swept, or output
history reloaded after the file expired), fall back to rendering the same `FileRefButton` used
for `<file-ref>` rather than a broken-image icon.

### `localResourceRoots` — required, security-relevant

`CtrlYokeWebviewProvider.ts` currently scopes `webviewView.webview.options.localResourceRoots`
tightly to the built webview bundle directory and the extension's `images/` directory
(flagged as a deliberate hardening decision in `dev/implemented/UI_SECURITY_REVIEW.md`).
Rendering a real `<img src>` pointing at a workspace file requires adding the workspace's
`.ctrlyoke/temp/` directory to that list. **Scope this addition to `.ctrlyoke/temp/` only —
not the workspace root** — to avoid regressing the existing narrow posture.

### Hosted-browser dashboard

`src/ui/webview-react` is shared between the VS Code webview and the hosted browser dashboard
(`src/server/CtrlYokeHostedServer.ts`), which has no `asWebviewUri` equivalent. The hosted
server needs its own static route for `.ctrlyoke/temp/` images, scoped and validated the same
way as the webview handler. Audit `CtrlYokeHostedServer.ts` at implementation time to wire
this up in parallel — thumbnails should degrade to the `<file-ref>` fallback in hosted mode
until that route exists, not silently break.

## Message Protocol (Summary)

| Message                    | Direction           | Payload                                          |
| --------------------------- | -------------------- | ------------------------------------------------- |
| `SAVE_PASTED_IMAGE`         | Webview → Extension  | `{ seq, dataBase64, mimeType }`                    |
| `PASTED_IMAGE_SAVED`        | Extension → Webview  | `{ seq, relativePath }` or `{ seq, error }`        |
| `REQUEST_FILE_PREVIEW_URI`  | Webview → Extension  | `{ seq, relativePath }`                            |
| `FILE_PREVIEW_URI_RESPONSE` | Extension → Webview  | `{ seq, uri }` or `{ seq, error }`                 |

Both follow the existing seq-correlated request/response pattern (`REQUEST_COMPLETIONS` /
`COMPLETIONS_RESPONSE`, `VALIDATE_CONTEXT_REFS` / `CONTEXT_REFS_VALIDATION`), including no-op
registration in `useMessageHandler.ts` since the requesting components listen directly.

## Harness Compatibility

There is no per-harness capability registry today, and this feature does not add one. The
pasted-image `@path` reference flows through the exact same `directFileRefs` pipeline as any
other file reference — whether the underlying AI model actually "sees" the image depends
entirely on that harness's own handling of file references (e.g. Claude Code CLI's `Read`
tool can load images; whether Codex, Copilot CLI, Qwen, or Gemini CLIs do the same is outside
ctrlyoke's control and not validated here). A brief in-editor hint ("image support depends on
the active harness") is a reasonable nice-to-have but not required for v1.

## Files Changed (Summary)

| File                                                                        | Change                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`               | New `createImagePasteExtension`, placeholder + `mapPos` tracking, seq-correlated save request |
| `src/utils/TempFileManager.ts`                                              | New `createPastedImageFile()`; widen `cleanupOrphanedFiles()` marker match |
| `src/ui/WebviewMessageRouter.ts`                                            | Handle `SAVE_PASTED_IMAGE`, `REQUEST_FILE_PREVIEW_URI`                    |
| `src/types/DashboardConstants.ts`                                           | New `MESSAGE_TYPES` entries                                               |
| `src/ui/webview-react/hooks/useMessageHandler.ts`                           | No-op registration for the two new response types                        |
| `src/ui/webview-react/components/output/MarkdownText.tsx`                   | New `remarkImageRefs`/extended `remarkFileLinks`, `image-ref` allowed tag, `ImageRefThumbnail` component |
| `src/ui/CtrlYokeWebviewProvider.ts`                                          | Add `.ctrlyoke/temp/` to `localResourceRoots`                             |
| `src/server/CtrlYokeHostedServer.ts`                                        | Static route for `.ctrlyoke/temp/` images (hosted-mode parity)            |

## Non-Goals

- Drag-and-drop of image files — clipboard paste only.
- Rendering the pasted image inline inside the CodeMirror prompt editor itself.
- A per-harness vision-capability registry or detection.
- Eagerly deleting a pasted image's temp file when its `@path` reference is edited/removed
  from the prompt — rely on the existing 24h orphan sweep.
- Paste support in `endCondition`-mode editors (`mode !== "prompt"`).
- Non-image clipboard file types (PDFs, other binary attachments).

## Testing

- Unit: MIME → extension mapping and rejection of unsupported types; `-pasted-image-` filename
  uniqueness under rapid successive pastes.
- Unit: `cleanupOrphanedFiles()` sweeps `-pasted-image-*` files regardless of extension but
  leaves unrelated files in `.ctrlyoke/temp/` alone.
- Unit: `remarkImageRefs` routes image-extension paths to `<image-ref>` and everything else to
  `<file-ref>`.
- Manual: paste a screenshot into the prompt editor — confirm the placeholder is replaced with
  an `@relativePath` reference, the file exists under `.ctrlyoke/temp/`, and clicking the
  decorated reference opens the image in VS Code.
- Manual: run a step with a vision-capable harness (e.g. Claude CLI) referencing the pasted
  image and confirm the harness engages with it.
- Manual: after running, confirm the echoed prompt in the output pane renders an inline
  thumbnail; confirm it still renders correctly for scrollback/virtualized rows.
- Manual: paste an oversized image — confirm a visible error and no hung placeholder.
- Manual: let a pasted image age past the 24h sweep, then reload the output history — confirm
  the thumbnail falls back to a plain `file-ref` instead of a broken image icon.
