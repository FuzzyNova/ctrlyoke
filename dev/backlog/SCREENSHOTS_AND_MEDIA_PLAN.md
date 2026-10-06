# Marketing & Docs Media Plan — Screenshots and GIFs

**Status:** Proposed

## Goal

Build a real asset library of screenshots and GIFs of the ctrlyoke dashboard, and use it to revamp
`landing/` (currently all text/icon/code-snippet, zero product imagery) and `docs/` (currently zero
screenshots) with actual pictures of the product. Capture what's stable now, ahead of release, so
this doesn't become a last-minute scramble once [`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md)
reaches Phase 8 ("Screenshots + demo GIF... promoted to a release blocker").

## Why

The landing page (`landing/src/pages/index.astro`) sells the product entirely on prose, emoji-icons,
and one hand-authored YAML code block. Nobody sees the dashboard until they install it. Meanwhile
`docs/` walks through settings and panels in text only. The main interface is not expected to change
materially before release — see `RELEASE_CHECKLIST.md` Phase 8's own framing: capture screenshots
"after Phase 6 UI (license status surface, upsell prompts) is final," which is the _only_ part of the
UI still in flux. Everything else is capture-ready today.

## Non-goals (this pass)

- **Licensing/Pro UI** (license status surface, activation dialogs, upsell prompts) — `LicenseService`
  (Phase 6 of the release checklist) isn't built yet. Skip these entirely; they get their own pass once
  that ships. The Pro marketing section on the landing page keeps its current text-only treatment for
  now.
- **Actually rewriting `landing/src/pages/index.astro` or `docs/**` content\*\* — this doc is the shot
  list and slotting plan only. Executing the swap is separate follow-up work once assets exist.
- **Video/animated hero** — GIFs only, no produced video.
- **Writing the Android + iOS PWA install instructions themselves** — a separate, release-blocking
  content task (currently not tracked in `RELEASE_CHECKLIST.md`; worth adding there). This doc only
  covers the supporting visual asset (#7's QR-scan/install/take-control recording, #10's mobile
  screenshots) — not the written step-by-step text.

## Capture setup (do once, applies to every shot below)

- **VS Code theme for the "primary" set — decided: `dark 2026 (Default Dark)`**, VS Code's own built-in
  dark theme. Use it for every non-theme-comparison shot, so the library reads as one consistent
  product rather than a grab-bag. Later re-captures (e.g. after a UI tweak) should match this theme.
- **Window size — there is no single correct width; it depends on where the feature actually lives.**
  ctrlyoke has four real usage contexts, and each shot below should be captured in whichever one(s)
  actually host that feature, not forced into one narrow default:
  - **VS Code side panel** (~420–480px portrait webview width) — the default install surface, and
    correct for anything that only exists there: settings pages (#4, #5, #12) and dialogs (#11).
  - **VS Code bottom panel** (short-and-wide, next to the terminal) — ctrlyoke was originally designed
    to live here and still reads well in this layout. It's a first-class placement, not an edge case,
    so it's worth at least one shot showing the dashboard next to a running terminal this way.
  - **Hosted/browser dashboard, wide desktop view** — localhost hosting is available even in the free
    tier specifically so users can run different workflows across browser tabs, so this is core usage,
    not a Pro-only extra. It's also the _only_ place some features render at all: `WorkspaceViewerModal`
    and its panes (including `WorkspaceDiffPane`) are a browser-only "little baby IDE" — VS Code itself
    is the workspace viewer in the panel case, so there's no VS-Code-sidebar version of #10. Wide desktop
    capture is also correct for the hero GIF (#6, already noted below) and the desktop half of the
    desktop/mobile composite (#3).
  - **Mobile browser / installed PWA** (real iPhone, ~375–430px portrait) — its own first-class context,
    not just a squeezed-down wide-browser view. `WorkspaceViewerModal` (#10) _does_ have a narrow
    capture — it's just a mobile-browser-width one, not a VS Code one. Also the context for #7 and the
    PWA-install walkthrough (see #7 below).

  Compose multi-theme shots (#2) as canvas compositions from same-context single captures, not as one
  giant native screenshot spanning contexts.

- **Demo data required before capturing:** several targets below are empty by default in a fresh
  workspace and need seeded/representative content first (noted per item). Don't screenshot the
  empty state unless the empty state itself is the point (e.g. onboarding docs).
- **Redact real paths/usernames:** use a demo project with a clean folder name (e.g. `demo-app`), not
  `C:\dev\ctrlyoke` or a personal username, in any shot destined for public docs/marketing.
- **File format:** PNG for stills, GIF (or MP4 transcoded to GIF) for motion, target <2MB per GIF for
  page load — trim/loop tightly rather than capturing a whole multi-minute run.
- **Asset location:** `images/screenshots/` (repo root) is the single canonical copy — see the
  "Screenshot assets" entry in `.github/copilot-instructions.md` for how `landing/` imports from it
  directly and why `docs/` needs a generated copy instead. The VS Code walkthrough (#13) also
  references `images/screenshots/` directly, since it ships inside the extension package.

### Target dimensions

Grounded in the actual containers these assets land in: `landing/src/pages/index.astro` has zero
images today (plain `<img>` tags, no `astro:assets` pipeline) and its sections sit in Tailwind
`max-w-2xl` (672px), `max-w-4xl` (896px — hero, YAML snippet, harness grid, Pro callout), and
`max-w-6xl` (1152px — features grid, ~360px per card in the 3-col layout). `docs/` is stock
VitePress (`docs/.vitepress/config.mts`, no custom theme) with a default ~688px prose column, and
VitePress's own `.vp-doc img { max-width:100%; height:auto }` already scales oversized images down
for free. The dashboard's own native capture width is the ~420–480px webview from "Capture setup"
above.

**Bigger is safe, smaller isn't — for stills.** Once landing images exist they should be built with
`max-width:100%; height:auto` in their container (same free behavior docs already gets), so a still
captured _larger_ than its slot just scales down cleanly — capturing at 2x DPI and shipping that PNG
is correct, not wasteful. The failure mode is the opposite: a still captured smaller than its slot
has to scale up and goes soft. Treat the px floors below as floors, not ceilings, for PNG categories
(A, B, C, F, G, H) — shoot at 2x whenever it's free to do so.

**GIFs are the exception.** Motion pays a real byte cost per pixel against the plan's <2MB budget, so
there's no free lunch in over-capturing — for GIF categories (D, E), capture close to actual display
size (~1–1.5x, not 2x+) and spend the byte budget on trimming/frame rate instead of resolution.

**Ratio matters more than absolute px for the designed compositions** (B, C, D) — these are
flattened canvases built to fill a landscape slot, so an off-ratio composite either letterboxes or
gets an ugly crop once dropped in. Raw single-panel stills (A), raw wide/browser stills (G), raw
mobile/PWA stills (H), and the code-snippet image (F) don't need a forced ratio — their shape is
dictated by the sidebar's natural portrait shape, the hosted dashboard's natural desktop layout, an
iPhone's natural portrait shape, or the snippet's line count, and the surrounding container just sizes
to whatever they are.

| Category                       | Applies to        | Ratio target                                      | Px floor                               | Notes                                                                                                                                                   |
| ------------------------------ | ----------------- | ------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Raw panel screenshot        | #4, #5, #11, #12  | none — natural portrait, crop to content          | 880–960px wide                         | 2x of the real 420–480 webview width                                                                                                                    |
| B. Flattened composite         | #1, #2            | ~3:2 to 16:10 landscape                           | 1152px wide (2304px+ at 2x)            | targets the `max-w-6xl` features-grid slot                                                                                                              |
| C. Desktop/mobile side-by-side | #3, pairs with #7 | ~3:2 landscape                                    | 896px wide (1800px+ at 2x)             | targets `max-w-4xl` Pro callout                                                                                                                         |
| D. Hero GIF                    | #6                | ~4:3 to 16:10 landscape                           | 896–1152px wide, captured near 1x–1.5x | record from the hosted/browser dashboard, not the narrow sidebar — a stretched 480px capture won't fill the hero                                        |
| G. Raw wide/browser screenshot | #10               | none — natural desktop landscape, crop to content | 1200px+ wide (2400px+ at 2x)           | `WorkspaceViewerModal` is hosted-dashboard-only — VS Code itself is the workspace viewer in the panel case. Narrow version is category H, not this one. |
| E. In-body docs GIF            | #9                | none forced                                       | ~688–900px wide, captured near 1x      | keep under the existing 2MB budget                                                                                                                      |
| F. Styled code snippet         | #8                | none — content-driven height                      | 896px wide                             | matches the existing hero `<pre>` block treatment                                                                                                       |
| H. Raw mobile/PWA screenshot   | #7, #10           | none — natural mobile portrait, crop to content   | 750–860px wide                         | 2x of a real iPhone's ~375–430px CSS width; capture on an actual device, not an emulator, for anything touching the PWA-install/cert flow               |
| I. Walkthrough step media      | #13               | ~16:10 to 4:3 landscape                           | 1200px wide, stills 2x / GIF near 1x   | fills the right-hand media pane of VS Code's walkthrough page, which scales it to the pane width; ships inside the VSIX, so bytes count double          |

One practical gotcha for A/B/C: on a non-retina Windows display at 100%/125% scaling, an ordinary
screenshot captures logical pixels 1:1 — soft once placed at native size in a 2x-built container.
Bump Windows display scaling to 200% temporarily before capturing, or if the capture goes through
Playwright (per the hosted-dashboard debugging flow), set `deviceScaleFactor: 2` on the browser
context; then ship the 2x PNG with `width`/`height` HTML attributes set to the 1x display size.

## Shot checklist

Each item: what to capture, what prep it needs, where it's used.

### 1. Composite: one dashboard, six harnesses

- **What:** A single graphic (Photoshop/Figma-style layered composite, not a live screenshot) stacking
  ~4–6 dashboard screenshots at a slight offset/rotation, each showing the same workflow running under
  a different harness (`HarnessDropdown` set to each of the 6 in `HARNESS_IDS`). Conveys "one dashboard
  drives all six."
- **Prep:** capture 6 individual full-dashboard screenshots first (same workflow, same window size,
  harness switched each time via `WorkflowPropertiesPanel`'s Harness tab), then composite.
- **Use:** landing hero or the "One interface, six harnesses" feature card
  (`landing/src/pages/index.astro` `features` array, `⚡` entry) — replace/augment the icon-only card.
- **Dimensions:** category B — see "Target dimensions" above.

### 2. Composite: one dashboard, multiple VS Code themes

- **What:** Same compositing technique as #1, but each layer is the _same_ dashboard state under a
  different VS Code theme (e.g. dark 2026, Light+, Dracula, One Dark Pro, Solarized). Demonstrates
  `createThemeExtension` / CSS variable theming actually tracks the host theme.
- **Prep:** capture the same dashboard view (same workflow, same panel) under ~4–5 themes.
- **Use:** landing "Harness grid" section or a new "Looks like your editor, not a plugin" section; also
  useful in `docs/guide/index.md` or `docs/guide/installation.md` to reassure users it isn't a
  separately-styled webview.
- **Dimensions:** category B — see "Target dimensions" above.

### 3. Side-by-side: desktop vs. mobile

- **What:** Desktop VS Code webview panel next to the hosted dashboard open in a phone browser
  (`WorkspaceViewerModal` / main dashboard responsive layout), same workflow on both.
- **Prep:** requires the hosted dev server running (`.ctrlyoke/dev/server-url.txt` per
  `.github/copilot-instructions.md` debugging section) and a real or simulated mobile viewport.
- **Use:** landing "Pro callout" section (`Code from anywhere`) — currently text/checklist only, no
  imagery at all; also `docs/pro/index.md`.
- **Dimensions:** category C — see "Target dimensions" above.
- **Status:** the motion version exists — `images/screenshots/ctrlyoke-take-control-1080p.mp4` (see
  #7), already on the landing page. A still composite is only needed for docs or other places a video
  doesn't fit; a frame from that clip may do.

### 4. `StatsUsageSection.tsx` — usage/stats page

- **What:** full render of `src/ui/webview-react/components/settings/stats/StatsUsageSection.tsx`:
  usage-collection toggles, quota tiles (`StatTileGrid`), harness-share bar (`HarnessShareBar`), and
  the per-harness `UsageCard` list.
- **Prep:** needs seeded usage history across several/all 6 harnesses so the harness-share bar, tiles,
  and per-harness cards aren't blank — either run real workflows across harnesses in the demo project
  beforehand, or seed `WorkspaceStatsSnapshot`/`snapshotsByHarness` test-fixture-style data into a demo
  workspace's persisted usage history.
- **Use:** new landing feature card/section (stats aren't mentioned on the landing page at all today);
  `docs/reference/settings.md` or a new docs page on usage tracking.

### 5. `StatusLineSection.tsx` — statusline tracking page

- **What:** full render of `src/ui/webview-react/components/settings/StatusLineSection.tsx`: the
  shared/per-harness format toggle, `StatusLineFormatEditor`, and the per-harness
  `StatusLineTrackingControls` rows for Claude, Antigravity, Copilot, and Qwen.
- **Prep:** set a non-default, interesting status line format in the editor before capturing so the
  preview isn't the bland default string.
- **Use:** same landing section as #4, or its own callout; `docs/reference/settings.md`.

### 6. GIF: multi-step, multi-harness workflow run with output minimap

- **What:** A workflow with several steps, at least two different harnesses across steps, running live
  — output pane streaming, minimap visible and being used to jump around output.
- **Prep:** author a demo workflow (`.ctrlyoke.yaml`) with ~4–6 steps mixing harnesses, long enough
  output per step that the minimap is visually meaningful. This is the plan's single most
  production-heavy asset — script the exact steps/prompts in advance so the capture is a clean single
  take.
- **Use:** landing hero (replace/accompany the static YAML snippet) or a new "watch it work" section;
  `docs/workflows/index.md` and `docs/guide/your-first-workflow.md`.
- **Dimensions:** category D — see "Target dimensions" above.

### 7. Built-in mobile editor section, plus the QR-scan/PWA-install walkthrough (iOS & Android)

- **What:** three related pieces, all captured on a real device, never an emulator (see Prep):
  - **The editor GIF:** the _prompt_ editor (`CodeMirrorEditor.tsx`), not the workspace viewer's file
    editor — that one is #10's edit-and-commit clip, captured in the same phone session. Editing a
    prompt on a phone-width viewport — on-screen keyboard, touch-friendly
    completions, the visual-viewport-aware tooltip repositioning (`CodeMirrorEditor.tsx`'s
    `keyboardTooltipSpace`/`repositionTooltips` handling exists specifically for this). iPhone is fine
    for this one; it's not platform-specific.
  - **The iOS install walkthrough — annotated stills plus two short clips, not one long recording.**
    The flow is: scan the QR code from `ServerSection.tsx` with the phone camera → the ctrlyoke URL
    opens in mobile Safari → install and trust the certificate → "Add to Home Screen" install the PWA
    → open the installed app and see/take control of the workflow that's actually running on the PC.
    Most of that is clicking through Apple's certificate and trust menus, which works better as numbered
    steps with one still per screen than as a video the reader has to pause and scrub:
    - **Stills** for each certificate/trust/install screen. iOS splits trust across two places —
      Settings → General → VPN & Device Management (install the profile), then Settings → General →
      About → Certificate Trust Settings (enable full trust). The second is the step people miss, so it
      gets its own still. Mark up every still with a box or arrow on the exact item to tap, and write
      the menu path as text in the step too (searchable, screen-reader friendly, survives iOS moving
      things).
    - **Short clips (a few seconds each)** only where motion is the point: the QR scan → camera →
      Safari hand-off, and the take-control payoff (also the landing-page candidate).
    - Check every still and clip for personal details before publishing: device name, phone
      identifiers on Settings → General → About (serial, IMEI, EID, ICCID, Wi-Fi/Bluetooth addresses),
      account rows, and notifications. The private LAN IP is fine, and a URL/QR token is fine once the
      token has been regenerated after recording.
    - **Status — certificate/trust/install stills: done.** Edited in Resolve with a transparent iPhone
      frame overlay (screen recording masked to rounded corners in Fusion), exported as a PNG sequence
      with alpha, then:
      - `images/screenshots/ios-pwa-setup-01-…-17-*-750x1532.png` — 17 numbered stills from "Download
        certificate" in ctrlyoke through the home-screen icon. Transparent outside the phone, so they
        sit on light and dark docs themes. Shown at ~375 CSS px wide (set `width="375"` when slotting;
        VitePress doesn't resize). Annotation (box/arrow on the item to tap) is still to do.
      - `images/screenshots/ios-pwa-setup-390x796.webp` — the whole 59s walkthrough as an animated WebP
        with alpha (15 fps, 3.2 MB; over the 2 MB budget, acceptable as an optional overview beside the
        stills, or split per phase if it needs to shrink).
      - The full-resolution PNG sequence stays outside the repo as the source master.
    - **Status — QR scan + take-control clip: done**, as
      `images/screenshots/ctrlyoke-take-control-1080p.mp4` (1920x1016, 36s, already used on the
      landing page): desktop VS Code and the phone side by side, scanning the QR code with the camera,
      then driving the running workflow from the phone. As a desktop-plus-phone composite it also
      covers much of #3 in motion form.
  - **The Android install recording:** the same flow's Chrome equivalent — scan the QR code → the URL
    opens in Chrome → proceed past the certificate warning → Settings → Download certificate (saved
    to Downloads as `ctrlyoke.crt`) → install it from Android Settings → Security & privacy → More
    security settings → (Samsung) Credential storage → Install from device storage → CA certificate,
    or (Pixel/stock) Encryption & credentials → Install a certificate → CA certificate → Install
    anyway → pick the file (since Android 11, tapping the downloaded file does not install a CA
    cert) → optionally show it under User certificates → **fully quit Chrome** (swipe every window
    away in Recent apps; on a real Samsung tablet, reopening a tab wasn't enough and the warning
    persisted) → reopen Chrome, warning gone → ⋮ → "Install and create shortcut" → **Install**
    (not "Create shortcut", which only opens a Chrome tab and was the only option that worked
    before the cert was trusted; older Chrome says "Install app" / "Add to home screen") → open the
    installed app from the home screen/app drawer and see/take control of the same running
    workflow. Unlike iOS, this one may stay mostly video: the settings path and install menu vary
    by device and Chrome version, so a short clip plus "it may look like X or Y" text can beat
    stills of a single variant.

  The iOS and Android install walkthroughs together are the release-blocking PWA-setup tutorial's
  centerpiece asset — the hard requirement is documented Android + iOS install instructions in
  `docs/pro/`, and these recordings are the visual walkthrough that instructions alone don't convey
  well. **Status — instructions: drafted** as `docs/pro/mobile-setup.md` (text only; slot the iOS
  stills and the Android recording in once annotated/recorded).

- **Prep:** real devices, not emulators — install-prompt UI, camera-to-browser hand-off, and app-drawer/
  home-screen placement after install are all real-device/real-browser-version behavior that doesn't
  emulate meaningfully.
  - **iPhone:** the QR scan, camera hand-off into Safari, "Add to Home Screen" dialog, and (if HTTPS is
    on) the cert-trust prompt.
  - **Android phone with Chrome:** whichever install-prompt variant that device/Chrome version actually
    shows — don't stage a different one than what a real user would see.
  - Use the same demo workflow/server session for the iOS and Android recordings so the two cut
    together cleanly as one "works everywhere" clip if that's useful later.
  - Capture the editor GIF with the on-screen keyboard actually open, since that's the scenario the
    code specifically handles.
- **Use:** the editor GIF pairs with #3 (the desktop/mobile composite) as a new landing "mobile"
  section. The iOS and Android install recordings are primarily documentation —
  `docs/pro/mobile-setup.md`'s iOS and Android sections respectively — and a trimmed clip of either is
  a strong Pro-callout candidate on landing too.
- **Editing pipeline (as used for the iOS set):** iPhone recordings are HEVC and variable frame rate;
  free Resolve on Windows can't decode HEVC (audio-only on the timeline), so first convert to H.264
  constant 30 fps with ffmpeg. Edit in DaVinci Resolve (free) with a custom timeline resolution fitted
  to the phone frame. MP4 can't carry transparency and Resolve has no GIF/WebP export, so render a PNG
  sequence with Export Alpha, then use ffmpeg for animated WebP (alpha, all current browsers) and for
  the stills. Avoid GIF for anything with rounded transparent corners (1-bit alpha, jagged edges).

### 8. YAML snippets for template marketing

- **What:** One or two more code-block screenshots (styled like the existing hero snippet in
  `index.astro`) specifically showing `_templateMeta` — variable declarations with `type`, `default`,
  `description`, `select`/`file` types — pulled from real examples in `docs/workflows/templates.md`
  (the Full Feature example at lines 24–45, or the `select`/`directory` example at lines 61–71).
- **Prep:** none beyond picking/trimming the example; this is a styled code block, not a screenshot of
  the running app (template variable _editing_ isn't a polished dashboard experience yet — see #9).
- **Use:** new landing "Templates" section; `docs/workflows/templates.md` itself currently has no
  visual treatment of its own code blocks beyond plain markdown.
- **Dimensions:** category F — see "Target dimensions" above.

### 9. GIF: prompt editor context-expansion, all trigger types

- **What:** One GIF (or a short series) typing each `CodeMirrorEditorMode`/`CompletionTrigger` in turn
  inside `CodeMirrorEditor.tsx` — `@` file/symbol refs, `#` symbol refs, `~` git-change refs, `$`
  prior-step/condition-output refs, `!` secret refs, and `/` slash commands — showing the completion
  dropdown, then the resulting atomic reference chip if `atomicContextReferences` is on.
- **Prep:** enable `atomicContextReferences` in settings so chips render (more visually distinctive
  than plain text refs); prepare a demo project with real files/symbols/git changes/secrets so every
  trigger has real completions to show, not an empty dropdown.
- **Use:** landing "Point at the context you mean" feature card (`📎`, currently icon-only); a new
  `docs/workflows/context-files.md` visual walkthrough.

### 10. Built-in code editor (`WorkspaceViewerModal`)

- **What:** the three panes — `WorkspaceExplorerPane`, `WorkspaceSourceControlPane`,
  `WorkspaceSearchPane` — via `WorkspaceViewerModal.tsx`'s tab switcher. Within Source Control, include
  a shot with a changed file actually selected so `WorkspaceDiffPane` is showing a real diff, not just
  the unselected file list.
- **Prep:** demo project with uncommitted changes staged/unstaged, with one file selected to populate
  the diff pane; a search query with real results (for the Search pane).
- **Use:** landing needs a section entirely — the built-in editor isn't mentioned on the landing page
  at all today; `docs/guide/concepts.md` or a new page. The iPhone set doubles as evidence in the
  PWA-setup docs (`docs/pro/`, see #7) that the mobile experience is a real IDE, not just a viewer.
- **Dimensions:** two sets, both needed — category G (wide desktop browser) for the landing/general-docs
  use, and category H (real iPhone, mobile Safari or the installed PWA) for the PWA-setup docs and the
  mobile section. Neither is a VS Code sidebar capture — see "Window size" in Capture setup.
- **Status:** wide desktop stills done — `workspace-viewer-explorer-1600x1000.png` and
  `workspace-viewer-search-1600x1000.png`. Still to capture: the Source Control + diff still and the
  iPhone set.
- **Plus a phone clip: edit a file and commit it** (~10–15s, category H motion, animated WebP with
  alpha like #7's). The motion version of the iPhone set, and a stronger "real IDE on your phone"
  demo than any still: Explorer → open a file and change a line (`WorkspaceFileEditor`) → save →
  Source Control → tap the file (on mobile the diff opens full-screen with a Back button) → Back →
  **+** to stage → type a commit message → commit → the new commit appears in the history graph.
  - Commit in the `demo-app` project, never the ctrlyoke repo — the commit is real. Keep the message
    clean; it's on screen.
  - Make the edit small and legible at phone size (a typo in a string, a changed constant).
  - Skip pushing: it would expose the remote, and the commit already makes the point.
  - Optional touch: if the file contains an `@file` reference, tapping it jumps to that file.
  - Record it in the same phone session as #7's prompt-editor GIF and cut both clips from that one
    recording.

### 11. Undo changes dialog

- **What:** `src/ui/webview-react/components/output/UndoChangesDialog.tsx` (surfaced via
  `useOutputUndoActions.ts` / `OutputUndoDialogs.tsx`), mid-confirmation on a real multi-file diff.
- **Prep:** a completed step that actually touched multiple files, so the dialog shows a non-trivial
  file list rather than one line.
- **Use:** landing "One reversible view of every result" feature card (`⬛`, icon-only today);
  `docs/workflows/index.md` or wherever undo/history is documented.

### 12. `WorkflowPropertiesPanel` — all six drawer tabs, plus key settings pages

- **What:** one screenshot per `DRAWER_TABS` entry in `WorkflowPropertiesPanel.tsx`: **Harness**,
  **Context**, **Validation**, **MCP**, **Hooks**, **Permissions** (`drawerPages.ts`). Plus the
  settings-modal pages already covered by #4/#5 count toward "key settings pages," so this item is the
  remaining ones worth a docs shot — General/harness defaults, and whichever others read well once
  populated with non-default values.
- **Prep:** populate each tab with realistic non-empty values before capturing (e.g. Permissions with
  actual allow/deny tool lists, MCP with a real server entry, Hooks with a configured hook) — an empty
  tab teaches nothing.
- **Use:** primarily `docs/` — one screenshot per relevant doc page (workflow properties, permissions,
  MCP servers, hooks) rather than landing, though the Harness tab (harness/model picker) is a
  reasonable landing candidate paired with #1.
- **Crop — decided: panel only.** No surrounding dashboard; at docs width a half-dashboard crop
  shrinks the form text to unreadable. Where the panel lives is shown once by #13a, which leads the
  docs page.
- **Status:** captured (`images/screenshots/*-tab-*-400x800.png`) and slotted into
  `docs/workflows/properties-panel.md`. Open follow-ups: re-capture `mcp-tab` with no personal
  path visible (the cclsp entry shows a `C:/Users/<name>/...` command); re-shoot the set at 2x when
  convenient (current captures are 1x, below category A's 880px floor); add #13a to the top of the page
  once captured.

### 13. VS Code "Getting Started with ctrlyoke" walkthrough — one media asset per step

The walkthrough (`package.json` → `contributes.walkthroughs`, id `ctrlyoke.gettingStarted`) currently
uses `markdown` media for all five steps, which is text plus a command link, so the large right-hand
media pane is mostly empty. Each step needs one picture that matches what its copy
(`walkthroughs/getting-started/*.md`) describes.

**Where the logo shows, and why it's missing from the walkthrough page.** The walkthrough `icon`
(`images/ctrlyoke-icon-color.png`) _is_ wired up correctly, but VS Code only renders it on the
**Welcome page's walkthrough list card** (`gettingStarted.ts` `iconWidgetFor(category)` inside the
`button.getting-started-category` list entry). The walkthrough _detail_ page, which is the page users
land on from "Open Walkthrough...", renders the header as a bare `h2.category-title` with no icon slot
at all. So a missing logo there is VS Code behavior, not a ctrlyoke bug, and no manifest property
changes it. (The title goes through `renderLabelWithIcons`, so a `$(codicon)` in `title` would render,
but a custom logo would need a `contributes.icons` icon-font glyph, and it would be monochrome.
Untested; probably not worth it.) The practical way to get branding onto the detail page is the
step 1 media below: a shot of the panel where the ctrlyoke logo is visible.

**Media type decision (for when the assets are slotted in).** Switch each step from `markdown` to
`image` media with `light`/`dark` variants (VS Code picks the variant from the active theme; `hc`/
`hcLight` fall back sensibly if omitted), and move each step's command link into the step
`description`. A link on its own line there renders as a button, so the call to action stays. Each
`image` needs `altText`. Markdown media _can_ embed an image, but it has no per-theme variant, so a
dark screenshot would sit inside a light-themed pane.

**Capture two themes per still:** `dark 2026 (Default Dark)` (the primary set's theme) and
`Light 2026 (Default Light)`. Same window, same demo project, same state. The GIF (13d) may ship
dark-only if the byte cost of two variants is too high.

**Packaging:** `.vscodeignore` is an allowlist and does not include `images/screenshots/**`. Add an
explicit `!images/screenshots/walkthrough-*` line or the published VSIX shows broken images even
though the dev host works. Keep the walkthrough's total media well under ~3MB. It's downloaded with
every install, unlike landing/docs assets.

**Naming:** follow the existing `<name>-<w>x<h>.<ext>` convention, e.g.
`walkthrough-open-panel-dark-2400x1500.png` / `walkthrough-open-panel-light-2400x1500.png`.

| Step (`id`)          | Shot                                                                                                                                                                                                                                                                                                                                                                                                                                   | Prep                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13a `openPanel`      | The ctrlyoke panel open in VS Code with a workflow loaded: step list, output pane with real output, and the properties drawer open. This must match the step copy ("steps on the left, live output and the prompt editor in the middle, harness/context/validation settings on the right"), so capture the wide layout, not the narrow sidebar. Crop to include the activity-bar ctrlyoke icon so the logo appears on the detail page. | The #6 demo workflow after one completed step, so output isn't empty.                                                                                                                              |
| 13b `verifyHarness`  | Two-up still: left half, the dashboard's "no supported CLI detected" state showing per-harness install commands; right half, the Harness tab / footer quick picker with detected harnesses listed.                                                                                                                                                                                                                                     | Left half: a machine or dev-host profile where no harness CLI is on `PATH` (`npm run dev:host:start:onboarding` + a stripped `PATH`). Right half: normal machine with several harnesses installed. |
| 13c `createWorkflow` | The New Workflow from Template flow: template picker with the built-in templates listed, and (second frame or inset) the variable form filled in with realistic values.                                                                                                                                                                                                                                                                | Onboarding-mode dev host (clean workspace) so the template list isn't cluttered with personal workflows.                                                                                           |
| 13d `runWorkflow`    | Short looping GIF (≤ ~8s, target < 1MB): Run clicked → output streams → step completes, end condition passes, and the queue advances to step 2.                                                                                                                                                                                                                                                                                        | A trimmed-down 2-step variant of the #6 demo workflow with a fast model so the whole loop fits in a few seconds. This is a _separate_ capture from #6 (walkthrough pane size, VSIX byte budget).   |
| 13e `getHelp`        | The Agent picker open with `ctrlyoke-tech-support` highlighted, plus the start of an answer to a real question (e.g. "why did my end condition fail?") in the output pane.                                                                                                                                                                                                                                                             | Ask the question once beforehand so the answer is real; crop to picker + first few lines of the answer.                                                                                            |

**Not a screenshot, but in the same pass:** `verifyHarness` and `getHelp` have no
`completionEvents`, so they never get checked off. Add `onLink:https://ctrlyoke.dev/docs` (or
`stepSelected`) to `getHelp`, and an `onContext:` key that the extension sets when at least one
harness is detected to `verifyHarness`. Also consider `featuredFor: ["**/*.ctrlyoke.{yaml,yml,json}",
"**/*.prompt.md"]` so the walkthrough is promoted on the Welcome page in workspaces that already use
ctrlyoke.

## Slotting summary

| Landing section (existing or new)                        | Asset(s)                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| Hero                                                     | #6 (workflow-run GIF) replacing/joining the static YAML block |
| "Harness grid" / new "looks like your editor" section    | #2                                                            |
| Features grid — `⚡` One interface, six harnesses        | #1                                                            |
| Features grid — `📎` Point at the context you mean       | #9                                                            |
| Features grid — `⬛` One reversible view of every result | #11                                                           |
| New: Statistics/telemetry section                        | #4, #5                                                        |
| New: Built-in editor section                             | #10                                                           |
| New: Templates section                                   | #8                                                            |
| New: Mobile section                                      | #3, #7                                                        |
| Pro callout (`Code from anywhere`)                       | #3, #7 (non-Pro-UI parts only — see Non-goals)                |

| Docs page (existing or new)                                       | Asset(s) |
| ----------------------------------------------------------------- | -------- |
| `docs/workflows/context-files.md`                                 | #9       |
| `docs/workflows/templates.md`                                     | #8       |
| `docs/workflows/index.md` / `your-first-workflow.md`              | #6, #11  |
| `docs/reference/settings.md`                                      | #4, #5   |
| `docs/pro/index.md`                                               | #3, #7   |
| `docs/pro/mobile-setup.md` (new — Android + iOS PWA install)      | #7, #10  |
| `docs/guide/concepts.md` or new editor page                       | #10      |
| New/expanded workflow-properties + permissions + MCP + hooks docs | #12      |

| VS Code surface                                  | Asset(s)  |
| ------------------------------------------------ | --------- |
| `ctrlyoke.gettingStarted` walkthrough, steps 1–5 | #13a–#13e |

## Execution order (suggested)

1. Pick and record the primary capture theme + demo project setup (one-time).
2. Seed demo data: usage history (#4), status line format (#5), git changes + search hits (#10),
   multi-file diff (#11), populated drawer tabs (#12).
3. Author the demo multi-step, multi-harness workflow used by #6 (and reused as the "same workflow"
   across #1/#2's per-layer captures, so those composites show one coherent example, not six unrelated
   screenshots).
4. Capture stills: #4, #5, #10, #11, #12, #13a–c and #13e (dark + light each), then the 6+ raw layers
   for #1 and the 4–5 raw layers for #2.
5. Composite #1 and #2.
6. Capture GIFs: #6, #13d, #9, then #3/#7 (mobile, likely last since it needs the hosted server + a real or
   emulated device).
7. Produce the styled YAML snippet images (#8) — no app capture needed, can happen anytime.
8. Only then: touch `landing/` and `docs/` content to slot everything in (separate follow-up, not part
   of this checklist).
