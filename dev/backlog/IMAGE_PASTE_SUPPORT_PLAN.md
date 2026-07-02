# Image Paste Support Plan

## Overview

Let users paste a clipboard image directly into the prompt editor
(`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`). The pasted image is
written to disk by the extension host, and a normal `@relativePath` file reference to that
image is inserted into the editor at the cursor — no new prompt syntax, no new expansion
path. The image is **not** rendered inline inside the CodeMirror editor itself (explicitly
out of scope per user preference); instead, once the prompt is submitted and echoed back as
a `CliHeaderRow` in
`src/ui/webview-react/components/layout/output-section/OutputPane.tsx`, the echoed prompt
text renders an inline thumbnail for any `@path` reference that resolves to an image file.

Two tiers of destination are in scope:

- **Primary (v1): a committed, persistent asset folder.** Pasted images are written under
  `.ctrlyoke/assets/`, which is *not* gitignored (unlike `.ctrlyoke/temp/`), so committing the
  workflow file alongside its referenced images is enough to share both — no schema changes,
  no materialization step, the `@relativePath` reference is the real file forever. See
  [2. Choosing a Destination](#2-choosing-a-destination-committed-asset-folder-vs-temp).
- **Stretch: single-file portability via embedded base64.** For workflows that need to travel
  as one file with no companion asset folder (e.g. pasted into Slack), an opt-in action can
  embed the image as base64 directly in the workflow YAML/JSON and materialize it back into
  `.ctrlyoke/temp/` only at execution time. See
  [6. Stretch: Portable Embedded Images](#6-stretch-portable-embedded-images).

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
6. Send `MESSAGE_TYPES.SAVE_PASTED_IMAGE` with a `seq` and the current document's file path
   (if saved) so the extension host can resolve the destination — see
   [2. Choosing a Destination](#2-choosing-a-destination-committed-asset-folder-vs-temp) —
   reusing the existing `completionSeqRef`-style sequencing pattern from `customCompletions`.
   Await the response on the existing `window.addEventListener("message", ...)` handler, and on
   success replace the
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

## 2. Choosing a Destination: Committed Asset Folder vs. Temp

The extension host — not the editor — decides where a pasted image is written, based on
whether the prompt being edited belongs to a saved, on-disk workflow file:

- **Saved workflow file → `.ctrlyoke/assets/<workflow-basename>/`.** Grouped by workflow to
  avoid one giant flat folder and avoid filename collisions between unrelated workflows. This
  directory is a sibling of `.ctrlyoke/temp/` under the existing `.ctrlyoke/<subdir>/`
  convention (alongside `logs/`, `.queue/`, `.history/`), but — critically — it is **not**
  added to `.gitignore`. `.gitignore` currently excludes `.ctrlyoke/temp/`, `.ctrlyoke/.queue/`,
  `.ctrlyoke/logs/`, `.ctrlyoke/.history/`, `.ctrlyoke/.search-index/`, and
  `.ctrlyoke/capabilities.json` individually — `.ctrlyoke/assets/` is a new, deliberately
  un-ignored sibling. Sharing the workflow is then just "commit both files"; no separate asset
  bundling/zipping step, and no change to how the reference is resolved or delivered to a
  harness (still a plain `directFileRef`, still just a path the CLI reads itself).
- **Unsaved/new prompt (no on-disk workflow file yet) → `.ctrlyoke/temp/`.** There's no stable
  workspace-relative location to persist to until the file is saved somewhere, so this falls
  back to the existing ephemeral temp behavior. There is no automatic migration of a
  temp-pasted image into the asset folder when the workflow is later saved — see
  [Non-Goals](#non-goals).

Once written, both cases produce the same thing from the editor's point of view: a
workspace-relative path handed back in `PASTED_IMAGE_SAVED`, inserted as a normal
`@relativePath` reference. The asset-folder file is a permanent, user-owned workspace file
once written — ctrlyoke does not delete it (see [4. Cleanup](#4-cleanup--tempfilemanagerts)),
consistent with how ctrlyoke never deletes any other pre-existing file a `directFileRef`
points at.

## 3. Saving the Image — Extension Host

### `src/utils/TempFileManager.ts`

Every existing write method (`createPromptFile`, `createCategoryFile`, etc.) writes text via
`fs.promises.writeFile(path, content, "utf-8")`. Add a dedicated binary-write method:

```typescript
async createPastedImageFile(
  data: Buffer,
  extension: string,
  targetDir: string
): Promise<string> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const timestamp = Date.now();
  const filename = `${timestamp}-pasted-image-${randomSuffix()}.${extension}`;
  const filePath = path.join(targetDir, filename);
  await fs.promises.writeFile(filePath, data); // no encoding — raw bytes
  return filePath;
}
```

`targetDir` is resolved by the caller per
[2. Choosing a Destination](#2-choosing-a-destination-committed-asset-folder-vs-temp) — either
`.ctrlyoke/assets/<workflow-basename>/` or `.ctrlyoke/temp/`. The `-pasted-image-` marker in
the filename (not just the extension) is deliberate — see
[4. Cleanup](#4-cleanup--tempfilemanagerts) below.

### `src/ui/WebviewMessageRouter.ts`

Register `SAVE_PASTED_IMAGE` in the message dispatch table (same shape as the
`REQUEST_COMPLETIONS` / `VALIDATE_CONTEXT_REFS` entries): resolve the target directory per
[2. Choosing a Destination](#2-choosing-a-destination-committed-asset-folder-vs-temp) (an
asset folder derived from the incoming document path when saved, `.ctrlyoke/temp/`
otherwise), decode the incoming base64 payload to a `Buffer`, call
`tempFileManager.createPastedImageFile(buffer, extension, targetDir)`, resolve the
workspace-relative path via `tempFileManager.getRelativePath()`, and
`emitMessage({ type: PASTED_IMAGE_SAVED, relativePath, seq })`. On any failure (write error,
oversized payload slipping through, disallowed MIME), respond with
`{ type: PASTED_IMAGE_SAVED, seq, error: string }` instead of introducing a second message
type — mirrors how other seq-correlated responses in this codebase carry an optional error
rather than branching into a separate failure message type.

Add a no-op registration for `PASTED_IMAGE_SAVED` in `useMessageHandler.ts`, matching the
existing comment there explaining that `CodeMirrorEditor` listens for `COMPLETIONS_RESPONSE`
directly rather than through the central dispatcher.

## 4. Cleanup — `TempFileManager.ts`

Cleanup only ever applies to the `.ctrlyoke/temp/` fallback case — files written to
`.ctrlyoke/assets/` are permanent, user-owned workspace files (the same as any other file the
user creates), and `cleanupOrphanedFiles()` must never touch that directory.

For the `.ctrlyoke/temp/` fallback: `cleanupOrphanedFiles()` currently only sweeps files
ending in `.md`, files starting with `mcp-config`, and `.json` files inside
`*-notifications/` subdirectories — a pasted `.png` would never be swept. Widen the predicate
to also match the `-pasted-image-` filename marker regardless of extension, rather than
broadly allow-listing image extensions (which could sweep up unrelated binary files a user
happens to have dropped in `.ctrlyoke/temp/`).

Note that pasted-image refs become `directFileRefs`, which — per
`HarnessIntegration.deleteTempFiles()` — are **never** deleted per-turn; that method only
unlinks files it created for that turn (agent/skills/context/excerpts/prompt categories).
This is consistent with how any other `@path` reference to a pre-existing file is treated
(ctrlyoke doesn't own or delete files it didn't create for that step), so temp-fallback
pasted images correctly rely on the 24h orphan sweep rather than needing new per-turn
lifecycle code — and asset-folder images correctly get no automatic cleanup at all.

## 5. Displaying Inline Thumbnails — `OutputPane.tsx` / `MarkdownText.tsx`

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
Rendering a real `<img src>` pointing at a workspace file requires adding both
`.ctrlyoke/temp/` and `.ctrlyoke/assets/` to that list. **Scope this addition to those two
directories only — not the workspace root** — to avoid regressing the existing narrow
posture.

### Hosted-browser dashboard

`src/ui/webview-react` is shared between the VS Code webview and the hosted browser dashboard
(`src/server/CtrlYokeHostedServer.ts`), which has no `asWebviewUri` equivalent. The hosted
server needs its own static route for `.ctrlyoke/temp/` and `.ctrlyoke/assets/` images, scoped
and validated the same way as the webview handler. Audit `CtrlYokeHostedServer.ts` at
implementation time to wire this up in parallel — thumbnails should degrade to the
`<file-ref>` fallback in hosted mode until that route exists, not silently break.

## 6. Stretch: Portable Embedded Images

For workflows that must travel as a single file with no companion asset folder — e.g. pasted
into Slack or attached to an email — an opt-in action can embed a referenced image directly
in the workflow file as base64, and materialize it back into `.ctrlyoke/temp/` only at
execution time, matching the original idea of storing the bytes in the workflow and writing
them to a temp file on demand. This is **not** part of the v1 scope in this plan — the
asset-folder design in
[2. Choosing a Destination](#2-choosing-a-destination-committed-asset-folder-vs-temp) already
solves sharing for the common case with zero schema changes. Embedding is a follow-on for the
narrower "one file, no attachments" case.

### Keep the blob out of the prompt text

Do **not** inline a base64 string into the human-edited prompt string itself — a multi-MB
string sitting inside the CodeMirror workflow editor would be unreadable and would make the
document's undo history and any text-based diffing painful. Instead:

- Add an `embeddedAssets` field to the workflow file (`PromptFile` in
  `src/types/CtrlYokeTypes.ts`, mirrored in `schemas/prompt-schema.json`):
  `embeddedAssets?: Record<string, { mimeType: string; dataBase64: string }>`.
  Workflow-level (not per-step) so a single embedded image can in principle be referenced from
  more than one step.
- The prompt text carries only a short placeholder token, `@embedded:<id>`, in place of the
  `@relativePath` reference.

### Embed / extract as explicit user actions

Triggered from the existing click-affordance on a decorated `@relativePath` image reference
(the same `cm-link`/`data-type="file"` span used for open-in-VS-Code today) — add an "Embed
for sharing" action alongside "Open". It reads the referenced file, base64-encodes it, adds an
entry to `embeddedAssets`, and rewrites the prompt text token from `@relativePath` to
`@embedded:<id>`. A symmetrical "Extract to file" action does the reverse — decodes the
`embeddedAssets` entry back into a real file (asset folder if the workflow is saved, temp
otherwise, same destination logic as fresh pastes) and rewrites the token back to
`@relativePath` — useful for editing or simply previewing the embedded image again. Both are
manual, explicit actions — pasting an image never auto-embeds it.

### Materializing at execution time

`ContextExpander`/`CliPromptPreparer` need to recognize `@embedded:<id>` tokens (a new match
type alongside `fullFile`/`directory`/`lineRange`/`symbol`/`git` in
`findContextReferenceMatches`), look up the entry in the workflow's `embeddedAssets[id]`,
decode the base64 back into a `Buffer`, and write it via the same
`TempFileManager.createPastedImageFile()` used for fresh pastes — landing in `.ctrlyoke/temp/`
since this is a per-run, disposable materialization, not a persistent asset. The token is then
substituted with the resulting `@relativePath` before the harness ever sees it, so **the
harness delivery path is completely unchanged** — from `directFileRefs` onward, an embedded
image and a freshly pasted image are indistinguishable.

### Previewing an embedded reference in the output pane

`ImageRefThumbnail` (see
[5. Displaying Inline Thumbnails](#5-displaying-inline-thumbnails--outputpanetsx--markdowntexttsx))
needs an `embedded:<id>` variant. Since the bytes already live in the workflow file, this case
doesn't need `asWebviewUri`/`localResourceRoots` at all — the extension host can decode the
base64 in memory and return a `data:<mimeType>;base64,...` URI directly in the
`FILE_PREVIEW_URI_RESPONSE`, which is simpler than the on-disk cases.

### Why this is a stretch, not the default

- Base64 blobs bloat the workflow file and produce unreviewable, non-diffable git changes —
  the exact problem the asset-folder design avoids.
- Schema, parser, `ContextExpander`, and editor decoration all need new code paths for a
  second reference kind (`@embedded:<id>`) alongside the existing four.
- Any tooling that loads/validates/pretty-prints workflow files (schema validation, the
  workflow editor, `PromptFileParser`) needs to tolerate a very large string field without
  choking or becoming sluggish.

## Message Protocol (Summary)

| Message                    | Direction           | Payload                                                            |
| --------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `SAVE_PASTED_IMAGE`         | Webview → Extension  | `{ seq, dataBase64, mimeType, documentPath?: string }`                 |
| `PASTED_IMAGE_SAVED`        | Extension → Webview  | `{ seq, relativePath }` or `{ seq, error }`                            |
| `REQUEST_FILE_PREVIEW_URI`  | Webview → Extension  | `{ seq, relativePath }` or `{ seq, embeddedId: string }` *(stretch)*   |
| `FILE_PREVIEW_URI_RESPONSE` | Extension → Webview  | `{ seq, uri }` or `{ seq, error }`                                     |

`documentPath` is omitted when the editor is working with an unsaved/new prompt, which is how
the extension host knows to fall back to `.ctrlyoke/temp/`. Both request/response pairs follow
the existing seq-correlated pattern (`REQUEST_COMPLETIONS` / `COMPLETIONS_RESPONSE`,
`VALIDATE_CONTEXT_REFS` / `CONTEXT_REFS_VALIDATION`), including no-op registration in
`useMessageHandler.ts` since the requesting components listen directly.

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
| `src/utils/TempFileManager.ts`                                              | `createPastedImageFile()` accepts a `targetDir`; widen `cleanupOrphanedFiles()` marker match (temp only) |
| `src/ui/WebviewMessageRouter.ts`                                            | Handle `SAVE_PASTED_IMAGE` (resolve asset-folder vs. temp destination), `REQUEST_FILE_PREVIEW_URI` |
| `src/types/DashboardConstants.ts`                                           | New `MESSAGE_TYPES` entries                                               |
| `src/ui/webview-react/hooks/useMessageHandler.ts`                           | No-op registration for the two new response types                        |
| `src/ui/webview-react/components/output/MarkdownText.tsx`                   | New `remarkImageRefs`/extended `remarkFileLinks`, `image-ref` allowed tag, `ImageRefThumbnail` component |
| `src/ui/CtrlYokeWebviewProvider.ts`                                          | Add `.ctrlyoke/temp/` and `.ctrlyoke/assets/` to `localResourceRoots`     |
| `src/server/CtrlYokeHostedServer.ts`                                        | Static route for `.ctrlyoke/temp/` and `.ctrlyoke/assets/` images (hosted-mode parity) |
| `.gitignore`                                                                 | No change — confirm `.ctrlyoke/assets/` stays un-ignored                  |
| *(stretch)* `schemas/prompt-schema.json`, `src/types/CtrlYokeTypes.ts`      | Add `embeddedAssets` field                                                |
| *(stretch)* `src/utils/ContextExpander.ts`, `src/core/harness/shared/CliPromptPreparer.ts` | Recognize/materialize `@embedded:<id>` tokens                |
| *(stretch)* `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`   | "Embed for sharing" / "Extract to file" actions on image refs             |

## Non-Goals

- Drag-and-drop of image files — clipboard paste only.
- Rendering the pasted image inline inside the CodeMirror prompt editor itself.
- A per-harness vision-capability registry or detection.
- Eagerly deleting a pasted image's temp file when its `@path` reference is edited/removed
  from the prompt — rely on the existing 24h orphan sweep.
- Paste support in `endCondition`-mode editors (`mode !== "prompt"`).
- Non-image clipboard file types (PDFs, other binary attachments).
- Automatically migrating a temp-fallback pasted image into the asset folder when an unsaved
  workflow is later saved — the reference stays pointed at `.ctrlyoke/temp/` unless the user
  manually re-pastes or uses the stretch "Extract to file" action.
- The embedded-base64 (stretch) feature itself — v1 ships the asset-folder design only.

## Testing

- Unit: MIME → extension mapping and rejection of unsupported types; `-pasted-image-` filename
  uniqueness under rapid successive pastes.
- Unit: destination resolution — saved workflow path → `.ctrlyoke/assets/<basename>/`;
  unsaved/new prompt → `.ctrlyoke/temp/`.
- Unit: `cleanupOrphanedFiles()` sweeps `-pasted-image-*` files regardless of extension inside
  `.ctrlyoke/temp/`, leaves unrelated files there alone, and never touches
  `.ctrlyoke/assets/` at all.
- Unit: `remarkImageRefs` routes image-extension paths to `<image-ref>` and everything else to
  `<file-ref>`.
- Manual: paste a screenshot into a prompt belonging to a saved workflow — confirm the
  placeholder is replaced with an `@relativePath` reference, the file lands in
  `.ctrlyoke/assets/<workflow-basename>/`, and clicking the decorated reference opens the image
  in VS Code. Commit both files and confirm a fresh checkout (or a co-worker's clone) resolves
  the reference and renders the thumbnail with no extra setup.
- Manual: paste into a brand-new, unsaved prompt — confirm it falls back to `.ctrlyoke/temp/`.
- Manual: run a step with a vision-capable harness (e.g. Claude CLI) referencing the pasted
  image and confirm the harness engages with it.
- Manual: after running, confirm the echoed prompt in the output pane renders an inline
  thumbnail; confirm it still renders correctly for scrollback/virtualized rows.
- Manual: paste an oversized image — confirm a visible error and no hung placeholder.
- Manual: let a temp-fallback pasted image age past the 24h sweep, then reload the output
  history — confirm the thumbnail falls back to a plain `file-ref` instead of a broken image
  icon.
- *(stretch)* Manual: "Embed for sharing" on an asset-folder image — confirm the token becomes
  `@embedded:<id>`, the workflow file is now self-contained, and running the step still reaches
  the harness (materializes to `.ctrlyoke/temp/` first). Confirm "Extract to file" round-trips
  back to an identical image.
