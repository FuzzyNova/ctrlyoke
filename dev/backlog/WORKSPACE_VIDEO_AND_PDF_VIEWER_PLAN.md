# Workspace Viewer Video and PDF Support

**Status:** Not started. Written 2026-10-19 against current code.
**Priority:** P3

## Problem

The workspace viewer shows images inline: the explorer's file editor renders
an `<img>` (`WorkspaceFileEditor`'s `imageDataUri` prop), and every diff surface
(single working-tree file, commit/ref, file history) renders a side-by-side
Before/After `ImageDiffView` (see
[`WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md`](../implemented/WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md)).
Video files and PDFs get neither: opening one is rejected as a binary file, and
a diff shows "binary diff preview unavailable".

Browsers can display both natively, so this should not need a bundled package
for video, and needs one for PDF only if Android matters (see below).

## Constraints that shape the design

- **The viewer runs only in the hosted browser dashboard.** `WorkspaceViewerModal`
  and its Header button are gated on `isStandalone`, and `hostedApi.ts` uses plain
  same-origin `fetch`. VS Code webview limits (Chromium's PDF plugin disabled,
  reduced codec set, `vscode-webview://` resource URIs) do not apply. If the viewer
  ever moves into the VS Code panel, PDF will need pdf.js there.
- **The `data:` URI approach used for images does not scale to these files.**
  - `readFile()` rejects anything over `MAX_FILE_SIZE` (2 MB,
    `HostedWorkspaceViewerService.ts`), and diff sides use the same cap
    (`diffSideMaxBytes`). Videos and many PDFs exceed it, base64 inside JSON
    adds ~33%, and the client holds the whole payload in memory.
  - The hosted page CSP (`CtrlYokeHostedServer.ts`, the `csp` array) is
    `default-src 'self'` with `data:` allowed only in `img-src`, so
    `<video src="data:…">` and `<iframe src="data:application/pdf…">` are
    blocked. Chrome also refuses `data:` PDFs in some contexts.
  - Safari will not play `<video>` unless the server honors HTTP `Range`
    requests, and no browser can seek without them.
- **`<video>`/`<iframe>` cannot send the `x-ctrlyoke-token` header.**
  `requestHasValidToken` already accepts `?token=` as a fallback, and the page URL
  already carries the token, so a query-string token is acceptable.
- **`IMAGE_REF_EXTENSIONS`/`isImageRefPath` must not be widened.** They also drive
  output-pane thumbnails (`MarkdownText`), `ContextExpander`, and
  `CompatibilityAnalyzer`. Video and PDF need their own classification.

### Native browser support

|                                 | Desktop Chrome/Edge/Firefox/Safari   | iOS Safari                  | Android Chrome                    |
| ------------------------------- | ------------------------------------ | --------------------------- | --------------------------------- |
| `<video>` mp4 (H.264/AAC), webm | yes                                  | mp4 yes; webm on recent iOS | yes                               |
| `<video>` mov                   | Safari yes; Chromium if H.264 inside | yes                         | usually                           |
| mkv / avi                       | no                                   | no                          | no                                |
| PDF in `<iframe>`               | yes (built-in viewer)                | renders, limited controls   | **no** (blank or download prompt) |

## Design

### 1. Single-source media classification

Add to `src/types/DashboardConstants.ts`, next to `IMAGE_REF_EXTENSIONS`:

- a `WORKSPACE_MEDIA_KINDS` constant (`image`, `video`, `pdf`) and its union type;
- one extension → `{ mediaKind, mimeType }` table covering the existing image
  extensions plus `mp4`, `m4v`, `webm`, `ogv`, `mov` and `pdf`;
- a `workspaceMediaInfoForPath(path)` helper returning that entry or `undefined`.

Only list formats browsers actually decode. mkv/avi stay binary rather than
appearing as a broken player. Image entries reuse `imageExtensionToMimeType` rather
than duplicating its table.

### 2. Raw-bytes route

`GET /api/workspace-viewer/raw?path=…[&repo=…][&ref=…]`

- Thin handler in `CtrlYokeHostedServer.ts` behind `requireToken`; the service
  validates path and scope the same way `readFile()` and `getDiff()` do
  (`safeResolveForSettingsEdit` for working-tree reads, `requireRepoRootForPath`
  plus ref validation for git reads).
- **Working tree** (`ref` absent): `res.sendFile` with the resolved path. Express's
  `send` handles `Range`, `206`, `ETag` and `Last-Modified`.
- **Git blob** (`ref` = commit hash, or `:` for the index): read with the existing
  `getBlobBytes()` (`GitUtils.ts`, 50 MB `maxBuffer`, size checked with
  `cat-file -s` first) under a media-specific cap, then answer `Range` ourselves
  (single range only; `416` on an unsatisfiable range). Blobs are immutable per
  hash, so the response can be cached with a long `max-age` and the blob id as
  `ETag`. Writing to a temp file and using `sendFile` is an acceptable alternative
  if hand-rolled range handling proves fragile.
- Serve **only** paths whose `workspaceMediaInfoForPath` is defined, with that
  table's `Content-Type`, plus `X-Content-Type-Options: nosniff`,
  `Content-Disposition: inline` and `Content-Security-Policy: sandbox`. Without the
  allowlist this route would serve workspace HTML/SVG as same-origin pages that can
  run scripts with the dashboard's token.
- Size cap: a new `MAX_MEDIA_FILE_SIZE` constant (e.g. 512 MB working tree; a
  lower cap for git blobs, which are buffered in memory). Over the cap, the file
  falls back to the binary/too-large treatment.

Add a `workspaceRawUrl(path, { repo?, ref? })` helper to `hostedApi.ts` that builds
the URL including `token`, so components never assemble it themselves.

CSP: same-origin URLs are already covered by `default-src 'self'`; add explicit
`media-src 'self'` and `frame-src 'self'` entries anyway so the intent is visible.

### 3. File viewer

- `readFile()` returns a media descriptor for video/PDF instead of rejecting as
  binary: `{ media: { kind, mimeType } }`, no bytes, so the size check is skipped
  for these kinds (the raw route enforces its own cap).
- Generalize `WorkspaceFileEditor`'s `imageDataUri` prop into a `media` source
  (`kind` + `src`) and the store's `fileImageDataUri`/`setLoadedImage` likewise.
  Render `<img>`, `<video controls preload="metadata">`, or a PDF
  `<iframe title=…>` filling the editor area.
- PDF fallback: always render an "Open in new tab" link (to the raw URL) beside
  the PDF, and make it the primary content when the iframe cannot render. Detecting
  Android Chrome by user agent is acceptable here; there is no reliable feature test
  for the built-in PDF viewer.
- Optional follow-up: move images to the raw route too, removing base64 inflation
  and the 2 MB image limit. Keep `data:` URIs for anything that must work without
  a URL (none known today).

### 4. Diffs: generalize the image payload to media

- Rename `DIFF_PAYLOAD_KINDS.IMAGE` → `MEDIA` (pre-release; no compatibility
  shim) and `WorkspaceImageDiffSides` → `WorkspaceMediaDiffSides`:
  `{ mediaKind; old?: WorkspaceMediaSide; new?: WorkspaceMediaSide }`, where a side
  is either `{ dataUri }` (images, until the optional follow-up above) or
  `{ path; ref; repo? }`, a reference the client turns into a raw URL. Video/PDF
  sides never carry bytes, so `getDiff()`, `buildGitRefDiffEntry()` and the
  file-history detail stop reading those blobs into memory at all; they only need
  the paths, refs and the side's existence (and, for the too-large check, `cat-file -s`).
- Working-tree new side uses `ref` absent; index side uses `:`; commit sides use
  the commit hash (old side = first parent, or the parent path for a rename).
- `ImageDiffView` → `MediaDiffView`: same Before/After labels, added/deleted
  placeholders and bounded frame; each side renders `<img>`, `<video controls>`
  or a PDF `<iframe>`. Media elements mount only while the card is expanded, so a
  collapsed card or an off-screen virtualized row never starts a download.
  `preload="metadata"` keeps an expanded-but-unplayed video cheap.
- Update `DiffFileCard`'s source union, `rdvAdapter.ts`'s `ParsedDiffFile`, and
  `diffFileRows.ts` estimates (fixed per media kind; never derived from bytes).

### 5. Docs

- `docs/guide/workspace-viewer.md` — list video formats and PDF next to images,
  including the Android PDF limitation.
- `docs/guide/source-control.md` — Before/After now covers video and PDF.

## Testing plan

- Service: media classification table; `readFile()` returns a descriptor (no
  bytes) for video/PDF; `getDiff()`, ref diff entries and file-history detail return
  media references for added/modified/deleted/renamed video and PDF files; size cap
  falls back to too-large.
- Route: token via query string accepted; disallowed extension (`.html`, `.svg`
  served as raw) rejected; `Range` → `206` with correct `Content-Range` for both
  working-tree and blob reads; `416` on bad range; response headers include
  `nosniff`, `sandbox`, `inline`; path traversal and out-of-root repo rejected.
- UI: file editor renders `<video>`/`<iframe>` with the raw URL; PDF fallback link
  present; `MediaDiffView` renders Before/After per kind with placeholders; media
  elements not mounted while collapsed.

## Acceptance criteria

- Opening an mp4/webm/mov or PDF in the explorer shows a playable video (seekable,
  including in Safari) or the browser's PDF viewer, with an "Open in new tab" link
  for PDFs.
- Every diff surface shows changed videos and PDFs side by side under the same
  Before/After card used for images.
- No video or PDF bytes travel inside JSON responses, and nothing downloads until a
  file is opened or a diff card is expanded.
- The raw route serves only allowlisted media types, with sandbox/nosniff headers.
- Output-pane thumbnails and other `isImageRefPath` callers are unchanged.

## Open questions

- Is native PDF with a fallback link enough on Android, or is lazily loaded
  `pdfjs-dist` (~1–2 MB with worker, loaded only for PDFs) worth adding?
- Should audio files (`mp3`, `ogg`, `wav`, `m4a`) ride along? They fit the same
  route and an `<audio>` side with almost no extra work.
