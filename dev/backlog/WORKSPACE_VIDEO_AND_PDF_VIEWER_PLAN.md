# Workspace Viewer Media Support (Video, Audio, PDF, and Images via a Raw Route)

**Status:** Ready to implement. Written 2026-10-19; revised 2026-10-31 to add audio,
move images onto the same raw-bytes pipeline, and settle the pdf.js questions.
**Priority:** P3

Last reviewed against code: 2026-10-31 (pdf.js decisions checked against
`pdfjs-dist@6.4.299`, the current `latest`).

## Problem

The workspace viewer shows images inline. The explorer's file editor renders an
`<img>` (`WorkspaceFileEditor`'s `imageDataUri` prop), and every diff surface
(single working-tree file, commit/ref, file history) renders a side-by-side
Before/After `ImageDiffView` (see
[`WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md`](../implemented/WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md)).
Video, audio and PDF files get neither: opening one is rejected as a binary file,
and a diff shows "binary diff preview unavailable".

Images themselves pay for the way they are delivered. `readFile()` and the diff
builders base64 the bytes into a `data:` URI inside the JSON response, so:

- images over 2 MB (`MAX_FILE_SIZE`) cannot be viewed or diffed at all;
- every image costs ~33% extra on the wire and is held whole in client memory;
- a commit diff with many changed images (`buildGitRefDiffEntry`, the
  `isImageRefPath(file.path)` branch in `HostedWorkspaceViewerService.ts`) reads
  every blob and ships every image's bytes in one response, even for cards the
  user never expands;
- nothing is cacheable: reopening the same image or commit re-sends the bytes.

Browsers play video and audio natively, so those need no bundled package. PDF
does: Android Chrome has no inline PDF viewer and iOS Safari's is minimal, and
phones are a primary target of the hosted dashboard. PDFs therefore render
through a lazily loaded `pdfjs-dist` (§4).

## Decisions

- **Audio is in scope.** It uses the same route and classification, and an
  `<audio controls>` element in the editor and in each diff side.
- **Images move to the raw route in this work, not as a follow-up.** The payload
  types, the editor's media prop and the diff view are all being rewritten here
  anyway. Moving images now means one side shape (`{ path, ref?, repo?, version? }`)
  and one render path for every kind, rather than a two-variant union that has to
  be unwound later. It also removes the 2 MB image limit and base64 inflation, and
  it makes image diff cards lazy and cacheable. After this work no media kind
  travels as bytes inside JSON. `data:` URIs stay only where a URL cannot work
  (output-pane thumbnails; see Non-goals).
- **`isEvalSupported` is gone from pdf.js 6.** No option is needed to keep
  `'unsafe-eval'` out of `script-src`; the worker no longer compiles PostScript
  functions with `new Function`.
- **No `'wasm-unsafe-eval'` is needed.** pdf.js 6 ships WASM decoders for
  JPEG 2000 (`openjpeg.wasm`) and JBIG2 (`jbig2.wasm`) together with pure-JS
  fallbacks (`openjpeg_nowasm_fallback.js`, `jbig2_nowasm_fallback.js`). The
  worker tries `WebAssembly.instantiate` first and, if that fails, `import()`s the
  fallback from `wasmUrl`. The hosted CSP is a `<meta>` tag in the HTML
  (`CtrlYokeHostedServer.ts`, the `csp` array), which does not apply to a
  dedicated worker loaded from its own URL, and `express.static` sends no CSP
  header. So WASM runs in the worker today, and the JS fallback still covers both
  decoders if a header CSP is ever added. Only ICC color management (`qcms_bg.wasm`)
  lacks a fallback, and losing it costs only color accuracy.

## Constraints that shape the design

- **The viewer runs only in the hosted browser dashboard.** `WorkspaceViewerModal`
  and its Header button are gated on `isStandalone`, and `hostedApi.ts` uses plain
  same-origin `fetch`. VS Code webview limits (Chromium's PDF plugin disabled, a
  reduced codec set, `vscode-webview://` resource URIs) do not apply. In the VS Code
  panel, clicking a media reference in the output pane already opens it in a
  VS Code editor, so the panel needs nothing here. Should PDFs ever render inside
  the panel itself, the same pdf.js component would work there, but the webview
  CSP (`CtrlYokeWebviewProvider.ts`) would need `worker-src blob:` with the worker
  fetched into a blob URL, since a `vscode-webview://` resource cannot start a
  worker directly.
- **`data:` URIs do not work for these files.** Besides the costs in Problem, the
  hosted CSP allows `data:` only in `img-src`, so `<video src="data:…">` and
  `<iframe src="data:application/pdf…">` are blocked, and Safari will not play
  `<video>`/`<audio>` unless the server honors HTTP `Range` (no browser can seek
  without it).
- **`<img>`/`<video>`/`<audio>` cannot send the `x-ctrlyoke-token` header.**
  `requestHasValidToken` already accepts `?token=` as a fallback, and the page URL
  already carries the token, so a query-string token is acceptable.
- **`IMAGE_REF_EXTENSIONS`/`isImageRefPath` must not change.** They also drive
  output-pane thumbnails (`MarkdownText`), `ContextExpander`, and
  `CompatibilityAnalyzer`. The viewer switches to its own classification (§1);
  those callers keep using theirs.
- **`MAX_FILE_SIZE` (2 MB) stays for text.** It still bounds the text editor,
  search, and the JSON body limit for saves (`WORKSPACE_FILE_JSON_BODY_LIMIT_BYTES`).
  Only media kinds leave it.

### Native browser support

|                                   | Desktop Chrome/Edge/Firefox/Safari   | iOS Safari                  | Android Chrome                    |
| --------------------------------- | ------------------------------------ | --------------------------- | --------------------------------- |
| `<video>` mp4 (H.264/AAC), webm   | yes                                  | mp4 yes; webm on recent iOS | yes                               |
| `<video>` mov                     | Safari yes; Chromium if H.264 inside | yes                         | usually                           |
| `<audio>` mp3, m4a/aac, wav, flac | yes                                  | yes                         | yes                               |
| `<audio>` ogg/oga (Vorbis), opus  | yes; Safari only on recent versions  | recent iOS only             | yes                               |
| mkv / avi / wma / aiff            | no                                   | no                          | no                                |
| PDF in `<iframe>`                 | yes (built-in viewer)                | renders, limited controls   | **no** (blank or download prompt) |

The PDF row is why PDFs use pdf.js rather than an `<iframe>` everywhere: one code
path that works on every device, and it also works in diff cards, where two native
viewers side by side would be heavy and awkward to size.

A container the browser accepts can still hold a codec it cannot decode (HEVC in
mov on Chromium, Vorbis on older Safari). Those files hit the playback-error
fallback in §3 instead of a silent broken player.

## Design

### 1. Single-source media classification

Add to `src/types/DashboardConstants.ts`, next to `IMAGE_REF_EXTENSIONS`:

- `WORKSPACE_MEDIA_KINDS` (`image`, `video`, `audio`, `pdf`) and its union type;
- one extension → `{ mediaKind, mimeType }` table:
  - image: the existing `IMAGE_REF_EXTENSIONS`, with MIME types from
    `imageExtensionToMimeType` (build the image rows from those two, don't
    re-list them);
  - video: `mp4`, `m4v` (`video/mp4`), `webm` (`video/webm`), `ogv`
    (`video/ogg`), `mov` (`video/quicktime`);
  - audio: `mp3` (`audio/mpeg`), `m4a` (`audio/mp4`), `aac` (`audio/aac`),
    `wav` (`audio/wav`), `flac` (`audio/flac`), `ogg`/`oga` (`audio/ogg`),
    `opus` (`audio/ogg`);
  - pdf: `pdf` (`application/pdf`);
- `workspaceMediaInfoForPath(path)`, returning that entry or `undefined`.

List only formats some target browser decodes; mkv/avi/wma/aiff stay binary. SVG
stays out (it is not an image kind today, and adding it is a separate decision;
the route's headers below would make it safe to add later).

### 2. Raw-bytes route

`GET /api/workspace-viewer/raw?path=…[&repo=…][&ref=…][&v=…]&token=…`

- Thin handler in `CtrlYokeHostedServer.ts` behind `requireToken`. A new service
  method validates path and scope the same way `readFile()` and `getDiff()` do
  (`safeResolveForSettingsEdit` for working-tree reads, `requireRepoRootForPath`
  plus ref validation for git reads) and returns either a resolved file path or a
  blob buffer.
- **Working tree** (`ref` absent): `res.sendFile` with the resolved path. Express's
  `send` handles `Range`, `206`, `416`, `ETag` and `Last-Modified`. Send
  `Cache-Control: no-cache` so the browser revalidates (a cheap `304`) instead of
  showing stale bytes after the file changes.
- **Cache busting:** `v` is the working-tree side's `modifiedAt`. The server ignores
  it; it only changes the URL so a mounted `<img>`/`<video>` reloads when a
  file-change message refreshes the editor or diff.
- **Git blob** (`ref` = commit hash, or `:` for the index): read with the existing
  `getBlobBytes()` (`GitUtils.ts`, size checked with `cat-file -s` first) under
  `MAX_MEDIA_BLOB_SIZE`, then answer `Range` ourselves (single range only; `416` on
  an unsatisfiable range; multi-range requests get the full `200`). The route accepts
  only `:` or a full 40/64-hex commit id as `ref` (anything else is `400`), so a
  symbolic ref can never be cached as immutable. A commit's blob is immutable, so send
  `Cache-Control: private, max-age=31536000, immutable` and the blob id
  (`git rev-parse <ref>:<path>`) as `ETag`. The index (`:`) is **not** immutable:
  send the blob id as `ETag` with `Cache-Control: no-cache`, and answer
  `If-None-Match` with `304`. Writing to a temp file and using `sendFile` is an acceptable
  alternative if the hand-rolled range handling proves fragile; put the range
  parsing in a small pure helper either way so it can be unit-tested.
- **Allowlist:** serve **only** paths where `workspaceMediaInfoForPath` is defined,
  with that table's `Content-Type`, plus `X-Content-Type-Options: nosniff` and
  `Content-Disposition: inline`. Anything else is `415`. Without the allowlist this
  route would serve workspace HTML as a same-origin page that could run scripts with
  the dashboard's token.
- **`Content-Security-Policy: sandbox`** on every kind except PDF. Browsers'
  built-in PDF viewers may refuse to render a sandboxed response, which would break
  "Open in new tab". PDF is not a same-origin script vector (Chromium's and
  Firefox's viewers run in their own origin), so the allowlist plus `nosniff` is
  the protection there. Verify this manually in Chrome, Firefox and Safari (see
  Testing). If a browser renders a sandboxed PDF fine, apply `sandbox` uniformly.
- **Size caps** (new constants in `HostedWorkspaceViewerService.ts`):
  `MAX_MEDIA_FILE_SIZE` = 512 MB for working-tree files (streamed, never buffered)
  and `MAX_MEDIA_BLOB_SIZE` = 50 MB for git blobs (buffered; matches
  `getBlobBytes`'s `maxBuffer`). Over the cap, the file falls back to the existing
  too-large treatment in the editor and the diff.

Add `workspaceRawUrl(side)` to `hostedApi.ts`. It takes the side shape from §5
(`{ path, ref?, repo?, version? }`) and builds the URL including `token`, so no
component assembles one itself.

CSP: same-origin URLs are already covered by `default-src 'self'` and
`img-src 'self'`. Add explicit `media-src 'self'` and `frame-src 'self'` entries
anyway so the intent is visible. `img-src` keeps `data:` for output-pane
thumbnails.

### 3. File viewer

- `readFile()` checks `workspaceMediaInfoForPath` before the size and binary
  checks. For any media kind it stats the file and returns a descriptor instead of
  bytes: `{ media: { kind, mimeType }, size, modifiedAt, readOnly: true, content: "" }`.
  It applies `MAX_MEDIA_FILE_SIZE` instead of `MAX_FILE_SIZE`. `imageDataUri` is
  removed from `WorkspaceFileResponse`. This is a hosted-API payload consumed only
  by the bundle the same server serves, so it needs no compatibility shim.
- Replace `WorkspaceFileEditor`'s `imageDataUri` prop with a `media` prop
  (`kind` + raw URL), and replace the store's `fileImageDataUri`/`setLoadedImage`
  with a media equivalent. Render, filling the editor area:
  - image: `<img>`;
  - video: `<video controls preload="metadata" playsInline>`;
  - audio: `<audio controls preload="metadata">`, centered;
  - pdf: `WorkspacePdfViewer` (§4).
- **Playback errors:** on a `<video>`/`<audio>` `error` event, replace the player
  with "This browser can't play this file" and an "Open in new tab" link (the raw
  URL) plus a "Download" link (`download` attribute). The image `error` event shows
  the same message.
- PDF toolbar: always include an "Open in new tab" link to the raw URL, so desktop
  users can still reach the browser's native viewer (search, print, forms).

### 4. PDF rendering with pdf.js

- **Package:** `pdfjs-dist` (pin to the 6.x line; 6.4.299 at time of writing),
  loaded with a dynamic `import()` the way `loadWorkflowFileSupport` is, so the
  chunk (`pdf.mjs` is a few hundred KB, the worker about 1 MB) downloads only when
  a PDF is first opened. Use the modern build, not `legacy/`. The hosted dashboard
  already targets evergreen browsers.
- **Loading:** `getDocument({ url: workspaceRawUrl(side), cMapUrl, cMapPacked: true,
standardFontDataUrl, wasmUrl, iccUrl, disableAutoFetch: true, disableStream: true,
enableXfa: false })`. pdf.js issues its own `Range` requests against the raw route,
  so with auto-fetch and streaming off it fetches only the byte ranges the visible
  pages need instead of pulling the whole file in the background. The token travels
  in the query string. Leave scripting off (the default; no `pdf.sandbox.mjs`).
- **`WorkspacePdfViewer` component** (in `components/workspace-viewer/`): pages
  rendered to `<canvas>` at `devicePixelRatio`. Only pages near the viewport render,
  using an `IntersectionObserver` with fixed-size placeholders sized from each
  page's viewport. It fits to width by default and has zoom in/out and a page
  indicator. It calls `destroy()` on the loading task/document when the file
  changes or the component unmounts, and cancels in-flight render tasks on scroll
  and zoom. Canvases far from the viewport are released, so a long PDF on a phone
  does not hold hundreds of bitmaps. A text layer (select/copy) is a follow-up.
- **Worker:** `worker-src 'self'` is already in the hosted CSP. Import the worker
  with Vite's `?url` suffix (`pdfjs-dist/build/pdf.worker.min.mjs?url`) and assign
  it to `GlobalWorkerOptions.workerSrc`, so Vite emits it as a hashed asset.
- **Static data:** copy pdf.js's `cmaps/`, `standard_fonts/`, `iccs/` and `wasm/`
  (excluding `quickjs-eval.*`, which is only for PDF scripting) through
  `src/ui/webview-react/build/staticCopyPlugin.ts`, under a single `pdfjs/` asset
  directory. Point `cMapUrl`, `standardFontDataUrl`, `iccUrl` and `wasmUrl` at it
  (each must end in `/`). Without them, CJK text and non-embedded standard fonts
  render as wrong glyphs, and JPEG 2000/JBIG2 images use the slower JS decoders.
  `StaticCopyTarget` has no exclude option today, so add an optional filter to it
  for the `quickjs-eval.*` exclusion (with a unit test). Also add `.wasm`,
  `.bcmap`, `.pfb` and `.icc` to the plugin's `DEV_SERVER_CONTENT_TYPES`; otherwise
  the dev server serves them as `application/octet-stream`.
  Check that `.wasm` is served with `application/wasm` by `express.static`
  (it is in `mime`'s table; `WebAssembly.instantiate` from a buffer doesn't need
  it, but a wrong type is a sign the copy went astray).
- **Errors:** password-protected or corrupt PDFs show a message with the
  "Open in new tab" link instead of a blank pane.
- **Diff sides** (§5) reuse the same component in a compact mode (bounded height,
  scrolled independently per side).

### 5. Diffs: one media payload for every kind

- Rename `DIFF_PAYLOAD_KINDS.IMAGE` → `MEDIA` and `WorkspaceImageDiffSides` →
  `WorkspaceMediaDiffSides`:
  `{ mediaKind: WorkspaceMediaKind; old?: WorkspaceMediaSide; new?: WorkspaceMediaSide }`
  with `WorkspaceMediaSide = { path: string; ref?: string; repo?: string; version?: number }`.
  `ref` absent means the working tree (with `version` = `modifiedAt` for cache
  busting), `:` means the index, and a commit hash means that commit. For a commit,
  the old side is the first parent, or the parent path for a rename. No
  compatibility shim is needed, for the same reason as `imageDataUri`.
- **Sides always carry a resolved commit id.** The diff builders receive symbolic
  refs today: `getDiff()` reads `"HEAD"`, and ref/compare diffs pass
  `NonTextDiffSources.baseRef`/`targetRef` (`HEAD`, branch names, merge bases,
  `<hash>^`). `buildMediaDiffSides` resolves each git side to its commit id with
  `git rev-parse --verify <ref>^{commit}` once per response, never per file, so
  the route's hash-only `ref` rule holds and a URL never points at a moving ref.
- There are **three** image branches to replace, not two: `getDiff()`,
  `buildGitRefDiffEntry()` (used by commit diffs and file-history detail), and
  `buildNonTextDiffEntries()` (ref/compare diffs; runs only for files git reports
  as binary, which covers every media kind).
- Sides never carry bytes, so `getDiff()`, `buildGitRefDiffEntry()` and the
  file-history detail stop reading media blobs into memory. `buildImageDiffSides`
  and the `isImageRefPath` branches in the diff builders are replaced by one
  `buildMediaDiffSides` that needs only the paths, refs, whether each side exists,
  and its size (a working-tree `stat` or `cat-file -s`) for the too-large check
  against the media caps. `diffSideMaxBytes` keeps applying to text sides only.
- `ImageDiffView` → `MediaDiffView`: the same Before/After labels, added/deleted
  placeholders and bounded frame. Each side renders `<img>`, `<video controls>`,
  `<audio controls>` or a compact `WorkspacePdfViewer`, with the §3 playback-error
  fallback. Media elements mount only while the card is expanded, so a collapsed
  card or an off-screen virtualized row never starts a download.
  `preload="metadata"` keeps an expanded but unplayed video or audio file cheap.
- Update `DiffFileCard`'s source union, `rdvAdapter.ts`'s `ParsedDiffFile`, and the
  `diffFileRows.ts` estimates. Estimates are fixed per media kind and never derived
  from bytes; audio is a short fixed row.

### 6. Docs and changelog

- `docs/guide/workspace-viewer.md`: list image, video, audio and PDF support. The
  "files larger than 2 MB" limit (line 117) becomes a text-file limit, with the media
  caps stated separately. Mention "Open in new tab" for PDFs and the
  can't-play fallback.
- `docs/guide/source-control.md`: Before/After now covers video, audio and PDF,
  and the 2 MB placeholder rule (line 97) applies to text diffs only.
- `CHANGELOG.md` under `## [Unreleased]`: **Added** video/audio/PDF viewing and
  diffs in the workspace viewer. **Changed** images over 2 MB now open and diff.

## Non-goals

- **Output-pane thumbnails** keep their `data:` URIs. In hosted mode they come over
  the WebSocket from `PromptEditorSupportService` (trusted-root check,
  `imageExtensionToMimeType`), not from the viewer service, and they are small
  previews. Moving them to the raw route would need the route to accept that
  trusted-root scope too. That is possible later, but nothing here depends on it.
- Transcoding (mkv, avi, HEVC on Chromium), PDF text layer, PDF forms and scripting,
  waveform display for audio.

## Testing plan

- **Classification:** every table entry maps to the expected kind and MIME type;
  image rows match `IMAGE_REF_EXTENSIONS`/`imageExtensionToMimeType`;
  `isImageRefPath` behavior is unchanged.
- **Service:** `readFile()` returns a descriptor (no bytes) for image, video, audio
  and PDF, including an image over 2 MB; over `MAX_MEDIA_FILE_SIZE` → too large;
  text files keep the 2 MB cap. `getDiff()`, ref diff entries and file-history detail
  return media sides for added/modified/deleted/renamed files of each kind, with the
  right `ref` per side (working tree, `:`, commit, first parent, rename parent path)
  and no blob reads beyond `cat-file -s`; a blob over `MAX_MEDIA_BLOB_SIZE` → too large.
- **Route:** token via query string accepted, missing token rejected; disallowed
  extension (`.html`, `.svg`, `.js`) → `415`; `Range` → `206` with the correct
  `Content-Range` for both working-tree and blob reads; `416` on an unsatisfiable
  range; blob responses carry the immutable cache headers and blob-id `ETag`; headers
  include `nosniff` and `inline`, and `sandbox` for every non-PDF kind; path
  traversal and out-of-root repo rejected. Unit-test the range parser on its own
  (open-ended, suffix, out-of-bounds, multi-range).
- **UI:** the file editor renders `<img>`/`<video>`/`<audio>` with the raw URL
  (including `v`) and `WorkspacePdfViewer` for PDFs; a media `error` event shows the
  fallback with open/download links. pdf.js mocked: `getDocument` called with the
  raw URL, `disableAutoFetch`/`disableStream` and the asset URLs; only visible pages
  render; `destroy()` on file change and unmount; the error state shows the
  open-in-new-tab link. `MediaDiffView` renders Before/After per kind with
  placeholders, and media elements are not mounted while a card is collapsed.
  `hostedApi.workspaceRawUrl` encodes path, repo and ref and appends the token.
- **Manual:** a multi-page PDF on Android Chrome and iOS Safari through the hosted
  dashboard; a PDF with CJK text and one with JPEG 2000 images (cMaps and WASM
  decoders); a long PDF on a phone, watching the network panel for range requests
  only; "Open in new tab" for a PDF in Chrome, Firefox and Safari (settles the
  `sandbox`-on-PDF question); an mp4 seek in Safari; an ogg/opus file on Safari
  (playback or the fallback message); a >2 MB PNG in the editor and in a commit diff.

## Implementation stages

Each stage is one commit; tick it in the commit that lands it.

- [x] **A. Classification and raw route** (§1, §2): `WORKSPACE_MEDIA_KINDS`, the
      extension table, `workspaceMediaInfoForPath`; the pure range parser; the
      service method and `GET /api/workspace-viewer/raw`; CSP `media-src`/`frame-src`.
      Additive only: no payload changes yet. No deviations from the plan.
- [x] **B. Payload switch, images on the raw route** (§3 descriptor, §5 types and
      builders, client wiring for images): `readFile()` descriptor, `MEDIA` payload
      and `WorkspaceMediaDiffSides`, `buildMediaDiffSides` in all three builders,
      `hostedApi.workspaceRawUrl`, store/editor `media` prop, `ImageDiffView` →
      `MediaDiffView` (image sides only render; other kinds show a placeholder with
      "Open in new tab"), `DiffFileCard`/`rdvAdapter`/`diffFileRows`. No implementation deviations.
- [x] **C. Video and audio rendering** (§3, §5): `<video>`/`<audio>` in the editor and
      diff sides, the playback-error fallback (also on `<img>`), mount-only-when-expanded.
- [x] **D. PDF via pdf.js** (§4): `pdfjs-dist`, static data copy, `WorkspacePdfViewer`,
      wired into the editor and the diff sides. No implementation deviations.
- [ ] **E. Docs and changelog** (§6).

## Acceptance criteria

- Opening an mp4/webm/mov, an mp3/m4a/wav/flac/ogg, or a PDF in the explorer shows a
  seekable video (Safari included), an audio player, or a pdf.js-rendered PDF that
  works on Android Chrome and iOS Safari as well as desktop, with an "Open in new
  tab" link for PDFs. An undecodable codec shows the can't-play fallback, not a dead
  player.
- Images of any size up to the media cap open and diff; the 2 MB limit applies only
  to text.
- pdf.js loads only when a PDF is opened, and the hosted CSP gains no
  `'unsafe-eval'` or `'wasm-unsafe-eval'`.
- Every diff surface shows changed images, videos, audio files and PDFs side by side
  under the same Before/After card.
- No media bytes travel inside JSON responses, and nothing downloads until a file is
  opened or a diff card is expanded.
- The raw route serves only allowlisted media types, with `nosniff` and `inline`
  headers (and `sandbox` as decided above).
- Output-pane thumbnails and other `isImageRefPath` callers are unchanged.
