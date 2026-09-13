# UX Snapshot Capture Plan

## Overview

Add a **dev-only** "UX Snapshot" capture that serializes the live webview UI — the rendered
HTML of `src/ui/webview-react/App.tsx`, the **computed** styles of every visible element, and
the **author CSS rules** that match each element (the closest in-page approximation of "where
does this style come from") — into a single text file the extension host writes to disk under
`.ctrlyoke/`. The trigger is a floating "capture" button pinned to the right-center of the
viewport, toggled on/off from
`src/ui/webview-react/components/settings/DeveloperSection.tsx`.

**Motivating use case:** Nathan often drives ctrlyoke from a phone (PWA / hosted dashboard)
where there are no browser dev tools to inspect and copy the rendered DOM. Raw HTML alone
doesn't tell the full story — the utility-class soup (Tailwind) means the interesting
information is _which CSS actually applied to each element and why_. The snapshot must capture
both, on-device, with one tap, and land somewhere an agent (or Nathan on desktop later) can
read it.

## Key Research Finding: What Is and Isn't Achievable In-Page

Before choosing a library, one hard constraint drives the whole design:

**True style provenance ("this `color` came from rule `.text-error-fg` in `index.css` line
N, overriding `.foo`") is only available via the Chrome DevTools Protocol**
(`CSS.getMatchedStylesForNode`), which is exactly what is unavailable inside the webview / PWA
— that's the whole reason this feature exists. The legacy `getMatchedCSSRules()` DOM API was
removed years ago. So no in-page library can produce full DevTools-grade provenance.

What **is** achievable purely in-page, and is genuinely useful here:

1. **Computed values** — `getComputedStyle(el)` gives the final resolved value of every CSS
   property for every element. This is the ground truth of "what the browser actually painted."
2. **Matching author rules** — iterate `document.styleSheets[].cssRules`, and for each style
   rule test `el.matches(rule.selectorText)`. This yields the list of author CSS rules that
   apply to an element, in source order, each with its `cssText` and originating stylesheet
   `href`/index. **For a Tailwind app this is close to full provenance**: every utility class
   (`flex-1`, `bg-editor-bg`, `text-error-fg`) is a real CSS rule, so the matched-rules list
   directly names the classes doing the work and their declarations. Cross-origin stylesheets
   throw on `.cssRules` access — wrap each sheet in try/catch and note skips.

So the plan captures **all three layers** (HTML + computed + matched author rules) and is
explicit in the output about the provenance approximation, rather than pretending to be
DevTools.

### Existing libraries — evaluated, mostly not a fit for the _text_ goal

The user asked not to reinvent the wheel. The wheel that exists is for **visual/image**
snapshots, not text-with-provenance:

| Library                                                   | Output                                         | Fit                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@zumer/snapdom`                                          | SVG/PNG (inlines computed styles into a clone) | Possible follow-up PNG companion; not text/provenance, and can't capture the WebGL terminal — **deferred, see below** |
| `html-to-image`, `modern-screenshot`, `dom-to-image-more` | PNG/SVG via inlined computed styles            | Same — image only                                                                                                     |
| `html2canvas`                                             | Canvas raster                                  | Image only, lossy for text                                                                                            |
| `juice`                                                   | HTML with CSS inlined                          | Node/email-oriented; needs raw CSS source, no per-element provenance                                                  |

**Recommendation:** build a small custom serializer for the text snapshot (no runtime
dependency — it's ~150 lines of DOM walking over standard `getComputedStyle` /
`document.styleSheets` APIs). The text dump is the whole point and needs no library.

**PNG companion — deferred to a follow-up, not v1.** We are **not** currently using
`@zumer/snapdom` (or any DOM/image-capture library) anywhere — verified: no
`snapdom`/`html-to-image`/`html2canvas`/`dom-to-image`/`modern-screenshot` dependency exists.
So the image layer would be a **net-new dependency** added purely for a "what it looked like"
nicety. The call itself is genuinely easy (`snapdom.toPng(rootEl)`), but it isn't free:

- **Large payloads over the phone round-trip.** A full-page PNG is a multi-MB base64 string
  sent over the same WebSocket as the (already large) text dump — it compounds the size
  concern below rather than sidestepping it.
- **It can't capture the terminal.** The xterm terminals render to a WebGL/canvas surface;
  snapdom / html-to-image inline computed styles into an SVG `foreignObject` and cannot
  reliably rasterize live canvas/WebGL content, so a big, visually central part of the UI
  would come out blank or stale in the image.
- **The text dump already solves the stated problem** — "no dev tools on my phone to see the
  HTML and which CSS applied." Provenance lives in the text, not the picture.

So: ship text-only for v1; add the PNG behind a follow-up flag if a visual reference proves
worth the dependency and the payload cost.

## What the Snapshot Contains

A single self-describing text file (`.md`-flavored so it renders in the editor and reads well
on a phone), with these sections:

1. **Header / context** — timestamp, `isStandalone` vs webview, `isMobile`, viewport size
   (`window.innerWidth/Height` + `visualViewport` height/offset, which matters for the iOS
   keyboard work in `App.tsx`), `devicePixelRatio`, `navigator.userAgent`, active theme
   (`document.body` class list + `--cy-color-theme-kind`), and which top-level layout branch
   rendered (mobile vs desktop, collapsed panel state from `useUiStore`).
2. **Serialized DOM** — `document.getElementById("root")?.outerHTML` (or the App root
   container), pretty-printed/indented. Optionally strip known-noisy attributes.
3. **Per-element style table** — a depth-first walk of the rendered tree. For each element,
   emit: a stable path/selector (tag + id + class list + `nth-child`), its **non-default
   computed styles** (diff against a fresh element of the same tag to keep the file small —
   dumping all ~350 computed properties per node is unusable), and its **matched author
   rules** (selector + declarations + source stylesheet) in cascade order.
4. **Stylesheet inventory** — list of `document.styleSheets` with href/inline, rule counts,
   and any that were unreadable (cross-origin).
5. **(Follow-up) visual snapshot** — deferred; if snapdom is added later, a base64 PNG
   data-URI appended at the end (or written as a sibling `.png`). Not in v1 (see rationale
   above).

**Scope: whole page only in v1.** The walk always starts at the App root and serializes the
entire rendered tree — no focused/hovered-subtree mode. File size is kept in check by the
computed-style diffing (against a per-tag default) described above, not by narrowing scope. A
subtree-scoped mode can be a later iteration if full-page files prove unwieldy on a phone.

## Architecture

### Webview side

- **`src/ui/webview-react/utils/uxSnapshot.ts`** (new) — pure capture logic:
  `captureUxSnapshot(): { markdown: string; png?: string }`. Contains the DOM walk,
  computed-style diffing (cache one detached probe element per tag name), the
  `document.styleSheets` matched-rule resolver (with per-sheet try/catch), and the header
  context assembly. No React, no side effects — unit-testable in Vitest with jsdom.
- **Floating capture button** — a small fixed-position component (e.g.
  `src/ui/webview-react/components/dev/UxSnapshotButton.tsx`) pinned right-center
  (`position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-*` above all overlays),
  rendered near the end of both the mobile and desktop layout trees in `App.tsx` (alongside
  `StartupOverlay` / `WorkspaceViewerModal`). It only mounts when **(a)** the build is a dev
  build (`useSettingsStore(s => s.dev?.enabled)`) **and (b)** the user toggle is on. On press it
  calls `captureUxSnapshot()` and `vscode.postMessage({ type: UX_SNAPSHOT_CAPTURE, markdown,
png })`, then shows a toast (`useUiStore(s => s.showToast)`) echoing the saved path once the
  extension replies.
- **Toggle in `DeveloperSection.tsx`** — a new `SettingToggleRow` "Show UX snapshot button"
  under a "Debug Capture" subsection (same pattern as the existing Performance Profiling
  block). Persist the flag in **`uiStore`** (it's a local/dev UI preference, matching
  `resetLayoutState` and the other persisted panel prefs there — not a synced workflow
  setting). Add `uxSnapshotButtonVisible: boolean` + `setUxSnapshotButtonVisible` to
  `src/ui/webview-react/store/uiStore.ts`.

### Message contract

- Add `UX_SNAPSHOT_CAPTURE: "dev:uxSnapshotCapture"` (webview→ext, carries `markdown` and
  optional `png`) and `UX_SNAPSHOT_SAVED: "dev:uxSnapshotSaved"` (ext→webview, carries the
  written `path` or an error) to **`src/types/DashboardConstants.ts`** `MESSAGE_TYPES`, and the
  corresponding payload types to **`src/types/WebviewMessageTypes.ts`**. Keep both layers in
  sync per the cross-layer rule in `.github/copilot-instructions.md`.
- Unlike the existing `routeDevAction` handlers (which take no payload), this handler consumes
  `message.markdown` / `message.png`. Register it in
  **`src/ui/WebviewMessageRouter.ts`** next to the other `DEV_*` entries, gated the same way
  (emit `DEV_COMMAND_UNAVAILABLE` / no-op when `handleDevAction` is absent so production builds
  can't write files).

### Extension / host side (write handler)

- Extend **`src/dev/DevCommands.ts`**: add a `writeUxSnapshot(markdown, png?, workspaceRoot)`
  handler. It builds the target dir under the given root, `mkdir -p`, writes the `.md` (and
  optional `.png`), and returns/posts `UX_SNAPSHOT_SAVED` with the workspace-relative path.
  This keeps it dead-code-eliminated from production builds like the rest of
  `DevCommands.ts`. (Note: `DevDashboardAction` is a fixed union used by `routeDevAction`; the
  snapshot doesn't need to join that union since it's a distinct payload-carrying message —
  wire it as its own callback, e.g. `handleUxSnapshot`, on the same callbacks object.)
- **Workspace-root resolution is host-specific and must be injected, not hard-coded to
  VS Code.** In the VS Code webview the root comes from `getVsCodeWorkspaceRoot()`; in the
  hosted server it's `CtrlYokeHostedServer.workspaceRoot`. The write handler takes the root as
  a parameter (or reads it from the callbacks context) so both hosts reuse the same file-write
  logic — do **not** call `getVsCodeWorkspaceRoot()` inside the shared handler, since it
  returns nothing in the standalone hosted process.

### Standalone (phone / hosted dashboard) round-trip — the primary path

The phone PWA is `isStandalone`, and the decision is: **the server saves the file so a desktop
agent can read it — never a client-side download.** The good news from the code is that this
requires _no new transport_:

- The hosted server already forwards every inbound client WebSocket message through the
  **same** router the webview uses:
  `CtrlYokeHostedServer.setupWebSocket()` → `webviewProvider.routeExternalMessage(msg, send,
clientTag)` (`src/server/CtrlYokeHostedServer.ts` ~line 1330 →
  `src/ui/CtrlYokeWebviewProvider.ts:964`). So the single `UX_SNAPSHOT_CAPTURE` handler
  registered in `WebviewMessageRouter.ts` serves **both** the webview and the phone.
- On the phone path, the handler must write using the **server's** `workspaceRoot`
  (`src/server/CtrlYokeHostedServer.ts:102`) — passed through the webviewProvider callbacks —
  not a VS Code root. The `send` callback given to `routeExternalMessage` delivers
  `UX_SNAPSHOT_SAVED` back to that specific phone socket for the confirmation toast.
- **Dev-gating in the hosted context:** confirm the hosted server wires the
  `handleUxSnapshot`/`handleDevAction` callback (it may not today, since dev build actions are
  a VS Code concern). If it's unset, the existing `DEV_COMMAND_UNAVAILABLE` guard fires and
  nothing is written — so enabling snapshot saving in standalone mode may require explicitly
  registering the write callback when constructing the hosted server. This is the one concrete
  wiring task the round-trip adds beyond the webview path.

## Output Location & Format

Reuse the already-trusted, already-gitignored `.ctrlyoke/` tree. Two options:

- **Recommended:** a new `.ctrlyoke/snapshots/` directory (add `SNAPSHOTS_DIR: "snapshots"` to
  `PATH_CONSTANTS` in `src/utils/ConfigurationUtils.ts`), file
  `ux-snapshot-<timestamp>.md` (+ optional `.png`). Keeping it separate from `logs/` avoids the
  log-retention cleanup (`Log.cleanupOldLogs`) deleting snapshots, and reads clearly.
- Alternative: drop into the existing `.ctrlyoke/logs/` (`PATH_CONSTANTS.LOGS_DIR`) — zero new
  constant, but snapshots would be subject to log rotation and mixed in with session logs.

Filename uses `Date.now()` to match the existing `ctrlyoke-<timestamp>.log` convention. The
`UX_SNAPSHOT_SAVED` reply carries the workspace-relative path so the toast can show it and an
agent can open it directly.

## File Change Checklist

| File                                                            | Change                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/ui/webview-react/utils/uxSnapshot.ts`                      | **New** — `captureUxSnapshot()` DOM/style/rule serializer                                                |
| `src/ui/webview-react/components/dev/UxSnapshotButton.tsx`      | **New** — floating fixed button, dev+toggle gated                                                        |
| `src/ui/webview-react/App.tsx`                                  | Mount `<UxSnapshotButton />` in both mobile & desktop trees                                              |
| `src/ui/webview-react/components/settings/DeveloperSection.tsx` | New "Debug Capture" toggle row                                                                           |
| `src/ui/webview-react/store/uiStore.ts`                         | Persisted `uxSnapshotButtonVisible` + setter                                                             |
| `src/types/DashboardConstants.ts`                               | `UX_SNAPSHOT_CAPTURE`, `UX_SNAPSHOT_SAVED` message types                                                 |
| `src/types/WebviewMessageTypes.ts`                              | Payload types for both messages                                                                          |
| `src/ui/WebviewMessageRouter.ts`                                | Route `UX_SNAPSHOT_CAPTURE` → dev handler (gated)                                                        |
| `src/dev/DevCommands.ts`                                        | `writeUxSnapshot(md, png?, workspaceRoot)` — host-agnostic file write + reply                            |
| `src/server/CtrlYokeHostedServer.ts`                            | Register the snapshot write callback with `this.workspaceRoot` so the phone round-trip saves server-side |
| `src/ui/CtrlYokeWebviewProvider.ts`                             | Thread the `handleUxSnapshot` callback through to the router (both hosts)                                |
| `src/utils/ConfigurationUtils.ts`                               | `SNAPSHOTS_DIR` path constant (if using new dir)                                                         |
| ~~`package.json`~~                                              | _(follow-up only)_ `@zumer/snapdom` devDependency for the deferred visual PNG layer — **not v1**         |
| `src/ui/webview-react/test/**`                                  | Vitest for `captureUxSnapshot()` (jsdom)                                                                 |

## Edge Cases & Risks

- **Payload size.** A full computed-style dump per node is huge. The computed-style _diff
  against a per-tag default_ is the primary mitigation; also cap depth/element count and note
  truncation. `postMessage` in the hosted (WebSocket) path has practical size limits — consider
  chunking or gzip (`CompressionStream`) if snapshots exceed a few MB; start simple and measure.
- **Cross-origin stylesheets** throw on `.cssRules` — try/catch per sheet and record which were
  skipped so the output is honest about gaps.
- **Production safety.** Every entry point is dev-gated (`dev.enabled` in the webview,
  `DevCommands` dead-code elimination + `handleDevAction`-absent guard on the extension). No
  file-write path exists in production builds.
- **iOS/visual-viewport context** is worth capturing explicitly given the existing
  `useIosVisualViewportRootStyle` logic in `App.tsx` — snapshots taken with the keyboard open
  are a prime debugging target, so record `visualViewport` metrics in the header.
- **Standalone vs webview — decided: server saves, no download.** In standalone (phone) mode
  the file is written by the hosted server so a desktop agent can read it — never a
  client-side download. As detailed above, the hosted server reuses the same
  `WebviewMessageRouter` via `routeExternalMessage`, so the only added work is (a) passing the
  server's `workspaceRoot` into the write handler and (b) registering the dev write callback in
  the hosted-server construction so the `DEV_COMMAND_UNAVAILABLE` guard doesn't block it.

## Resolved Decisions

- **Name:** "UX Snapshot" for the feature and the `ux-snapshot-<timestamp>.md` file;
  "Debug Capture" as the `DeveloperSection` subsection label.
- **Save location:** new `.ctrlyoke/snapshots/` directory (`SNAPSHOTS_DIR` constant), separate
  from `logs/` so log rotation never deletes snapshots.
- **Standalone save target:** the hosted server writes the file server-side so a desktop agent
  can read it — no client-side download. Reuses the existing `routeExternalMessage` path.
- **Scope:** whole App root only in v1; no subtree/focused-element mode.
- **Visual PNG:** deferred to a follow-up. We aren't already using snapdom (or any capture
  lib), and it can't capture the WebGL terminal or dodge the payload-size cost — text-only for
  v1.

## Remaining Follow-ups (post-v1)

- Optional `@zumer/snapdom` PNG companion, if a visual reference proves worth the dependency.
- Optional subtree/focused-element capture scope, if full-page files get unwieldy on a phone.
