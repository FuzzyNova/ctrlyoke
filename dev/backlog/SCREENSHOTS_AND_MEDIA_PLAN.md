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
"after Phase 6 UI (license status surface, upsell prompts) is final," which is the *only* part of the
UI still in flux. Everything else is capture-ready today.

## Non-goals (this pass)

- **Licensing/Pro UI** (license status surface, activation dialogs, upsell prompts) — `LicenseService`
  (Phase 6 of the release checklist) isn't built yet. Skip these entirely; they get their own pass once
  that ships. The Pro marketing section on the landing page keeps its current text-only treatment for
  now.
- **Actually rewriting `landing/src/pages/index.astro` or `docs/**` content** — this doc is the shot
  list and slotting plan only. Executing the swap is separate follow-up work once assets exist.
- **Video/animated hero** — GIFs only, no produced video.

## Capture setup (do once, applies to every shot below)

- **VS Code theme for the "primary" set:** pick one theme (recommend Dark+ or a high-contrast dark
  theme close to ctrlyoke's own brand navy) and use it for every non-theme-comparison shot, so the
  library reads as one consistent product rather than a grab-bag. Record which theme was chosen here
  once decided, so later re-captures (e.g. after a UI tweak) match.
- **Window size:** capture the dashboard at a realistic panel width (~420–480px, the actual sidebar
  webview width), not a maximized editor — screenshots that show the dashboard artificially stretched
  wide misrepresent the product. Compose desktop-vs-mobile and multi-theme shots as canvas
  compositions afterward (see below), not as one giant native screenshot.
- **Demo data required before capturing:** several targets below are empty by default in a fresh
  workspace and need seeded/representative content first (noted per item). Don't screenshot the
  empty state unless the empty state itself is the point (e.g. onboarding docs).
- **Redact real paths/usernames:** use a demo project with a clean folder name (e.g. `demo-app`), not
  `C:\dev\ctrlyoke` or a personal username, in any shot destined for public docs/marketing.
- **File format:** PNG for stills, GIF (or MP4 transcoded to GIF) for motion, target <2MB per GIF for
  page load — trim/loop tightly rather than capturing a whole multi-minute run.
- **Asset location:** create `landing/public/screenshots/` and `docs/public/screenshots/` (new
  directories — neither exists yet; today `landing/public/` and `docs/public/` hold only the harness
  icons and the ctrlyoke icon). Landing and docs can share one canonical set and each reference it, or
  duplicate — decide when executing based on Astro/VitePress asset pipeline constraints.

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

### 2. Composite: one dashboard, multiple VS Code themes

- **What:** Same compositing technique as #1, but each layer is the *same* dashboard state under a
  different VS Code theme (e.g. Dark+, Light+, Dracula, One Dark Pro, Solarized). Demonstrates
  `createThemeExtension` / CSS variable theming actually tracks the host theme.
- **Prep:** capture the same dashboard view (same workflow, same panel) under ~4–5 themes.
- **Use:** landing "Harness grid" section or a new "Looks like your editor, not a plugin" section; also
  useful in `docs/guide/index.md` or `docs/guide/installation.md` to reassure users it isn't a
  separately-styled webview.

### 3. Side-by-side: desktop vs. mobile

- **What:** Desktop VS Code webview panel next to the hosted dashboard open in a phone browser
  (`WorkspaceViewerModal` / main dashboard responsive layout), same workflow on both.
- **Prep:** requires the hosted dev server running (`.ctrlyoke/dev/server-url.txt` per
  `.github/copilot-instructions.md` debugging section) and a real or simulated mobile viewport.
- **Use:** landing "Pro callout" section (`Code from anywhere`) — currently text/checklist only, no
  imagery at all; also `docs/pro/index.md`.

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

### 7. Built-in mobile editor section

- **What:** screenshots/GIF of editing a prompt on a phone-width viewport — on-screen keyboard,
  touch-friendly completions, the visual-viewport-aware tooltip repositioning
  (`CodeMirrorEditor.tsx`'s `keyboardTooltipSpace`/`repositionTooltips` handling exists specifically for
  this).
- **Prep:** real mobile device or accurate emulation against the hosted dev server; capture with the
  on-screen keyboard actually open, since that's the scenario the code specifically handles.
- **Use:** pairs with #3 as a new landing "mobile" section; `docs/pro/index.md` (remote/mobile access).

### 8. YAML snippets for template marketing

- **What:** One or two more code-block screenshots (styled like the existing hero snippet in
  `index.astro`) specifically showing `_templateMeta` — variable declarations with `type`, `default`,
  `description`, `select`/`file` types — pulled from real examples in `docs/workflows/templates.md`
  (the Full Feature example at lines 24–45, or the `select`/`directory` example at lines 61–71).
- **Prep:** none beyond picking/trimming the example; this is a styled code block, not a screenshot of
  the running app (template variable *editing* isn't a polished dashboard experience yet — see #9).
- **Use:** new landing "Templates" section; `docs/workflows/templates.md` itself currently has no
  visual treatment of its own code blocks beyond plain markdown.

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
  `WorkspaceSearchPane` — via `WorkspaceViewerModal.tsx`'s tab switcher.
- **Prep:** demo project with uncommitted changes staged/unstaged (for the Source Control pane to show
  something) and a search query with real results (for the Search pane).
- **Use:** landing needs a section entirely — the built-in editor isn't mentioned on the landing page
  at all today; `docs/guide/concepts.md` or a new page.

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

## Slotting summary

| Landing section (existing or new) | Asset(s) |
| --- | --- |
| Hero | #6 (workflow-run GIF) replacing/joining the static YAML block |
| "Harness grid" / new "looks like your editor" section | #2 |
| Features grid — `⚡` One interface, six harnesses | #1 |
| Features grid — `📎` Point at the context you mean | #9 |
| Features grid — `⬛` One reversible view of every result | #11 |
| New: Statistics/telemetry section | #4, #5 |
| New: Built-in editor section | #10 |
| New: Templates section | #8 |
| New: Mobile section | #3, #7 |
| Pro callout (`Code from anywhere`) | #3, #7 (non-Pro-UI parts only — see Non-goals) |

| Docs page (existing or new) | Asset(s) |
| --- | --- |
| `docs/workflows/context-files.md` | #9 |
| `docs/workflows/templates.md` | #8 |
| `docs/workflows/index.md` / `your-first-workflow.md` | #6, #11 |
| `docs/reference/settings.md` | #4, #5 |
| `docs/pro/index.md` | #3, #7 |
| `docs/guide/concepts.md` or new editor page | #10 |
| New/expanded workflow-properties + permissions + MCP + hooks docs | #12 |

## Execution order (suggested)

1. Pick and record the primary capture theme + demo project setup (one-time).
2. Seed demo data: usage history (#4), status line format (#5), git changes + search hits (#10),
   multi-file diff (#11), populated drawer tabs (#12).
3. Author the demo multi-step, multi-harness workflow used by #6 (and reused as the "same workflow"
   across #1/#2's per-layer captures, so those composites show one coherent example, not six unrelated
   screenshots).
4. Capture stills: #4, #5, #10, #11, #12, then the 6+ raw layers for #1 and the 4–5 raw layers for #2.
5. Composite #1 and #2.
6. Capture GIFs: #6, #9, then #3/#7 (mobile, likely last since it needs the hosted server + a real or
   emulated device).
7. Produce the styled YAML snippet images (#8) — no app capture needed, can happen anytime.
8. Only then: touch `landing/` and `docs/` content to slot everything in (separate follow-up, not part
   of this checklist).
