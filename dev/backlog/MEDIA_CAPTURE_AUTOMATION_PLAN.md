# Media Capture Automation Plan

**Status (2026-10-18):** Phase 1 done: `media/` exists and retakes #12's ten tab shots and the
walkthrough's `verifyHarness` image (four themes) with `npm run media -- --all`. Phase 2 done
2026-10-18: `ctrlyoke export` writes run bundles, a dev build replays one, and the hero and six
rate-limiter runs are fixtures (`npm run media -- replay <run>`). Phase 3 done 2026-10-18: the
video pipeline (2× take, beat timeline, Remotion edit, encode) and a new hero
(`npm run media -- hero`). Phases 4-7 are open; the two desktop clips (#9, #14) were moved ahead
of the phone pipeline on 2026-10-18. This is the "how"
for [`SCREENSHOTS_AND_MEDIA_PLAN.md`](SCREENSHOTS_AND_MEDIA_PLAN.md), which stays the shot list and
slotting plan. `media/README.md` covers using it and adding shots.

## Goal

Retaking the screenshots and videos after a UI change should take one command per shot, not a day
of manual work. Concretely:

- **Desktop and hosted-dashboard media** (stills, the hero clip, #9, #13d, #14) are captured by
  committed scripts, edited by code, and encoded by the existing ffmpeg recipes. A UI change means
  rerunning the script.
- **Real-device media** (#7, #10's phone set) still needs a human holding the phone. Everything
  after the raw recording (trim, phone frame, rounded-corner alpha, stills, WebP) is scripted.
- **Captures don't depend on a live harness.** A recorded run replays into the dashboard, so every
  take shows the same output at the same timing and costs nothing (see "Run replay" below).

## Why

Media has been the slowest part of the release work. The hero clip is already outdated (it still
shows the old heading-row buttons). Every reshoot today means re-performing a live demo against a
real harness: it costs money, the output differs each take, and the edit is redone by hand in
Resolve. Stills are already mostly agent-driven through the Playwright MCP, but each retake is a
fresh agent session rather than a rerunnable script.

## Tool survey (2026-10-18)

| Tool                                           | Verdict                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ffmpeg**                                     | Keep for encoding (AV1/H.264, the GIF recipe, animated WebP) and the phone-frame composite (`overlay` + `alphamerge`). Too awkward for keyframed zooms.                                                                                                                                                                                      |
| **Remotion**                                   | **Chosen editor.** React/TypeScript compositions rendered headless: CSS transforms with `interpolate()`/`spring()` for zoom and pan, `<Video playbackRate>` for slow motion, plus captions and title cards. Agents can edit it like any component; Remotion Studio gives a live preview. Free license covers companies of up to 3 employees. |
| Motion Canvas / Revideo                        | MIT-licensed fallback with similar power if Remotion's license ever stops fitting.                                                                                                                                                                                                                                                           |
| MLT `melt`                                     | A real multitrack CLI editor with keyframed `affine` pan/zoom, but its XML is hard for an agent to author.                                                                                                                                                                                                                                   |
| DaVinci Resolve API                            | Rejected for automation. Resolve 21.1 moved Python and external scripting to Studio; the free edition only runs in-app Lua. Resolve stays available for one-off manual edits.                                                                                                                                                                |
| Auto-zoom recorders (Recordly, ScreenArc, Cap) | Fine for ad-hoc recordings, but GUI-driven and not rerunnable.                                                                                                                                                                                                                                                                               |
| Playwright (library)                           | **Chosen capture tool.** `page.screenshot({ clip })` at `deviceScaleFactor: 2` for stills; `page.screencast` (1.59+) for video, with `showActions`, `showOverlay` and `showChapter` for click highlights and title cards.                                                                                                                    |
| `@playwright/cli`                              | A cheaper replacement for the Playwright MCP when an agent explores interactively. Not used for shots we want to retake.                                                                                                                                                                                                                     |

## Design

### 1. Layout

A separate `media/` package at the repo root, like `landing/`, with its own `package.json`, so
Remotion and its dependencies never reach the extension's `node_modules` or the VSIX.

```
media/
  package.json          # playwright, remotion, react, typescript
  cli.ts                # `npm run media -- ...` (run by Node's type stripping, no build)
  demo-app.json         # demo project repo URL, pinned ref, named start tags (see 7)
  shots/                # one capture script per shot list entry
    properties-tabs.capture.ts
    walkthrough.capture.ts
    hero.capture.ts     # a VideoShot: the take
    hero.beats.ts       # beat names shared by the take and its edit
  compositions/         # Remotion: index.ts, Root.tsx, one <Name>.tsx edit per video
    edit.ts             # cuts -> frames, camera, pointer (unit-tested: `npm test` in media/)
    Edit.tsx            # renders an edit over a take
  lib/
    devHost.ts          # start/stop the dev host, switch its theme
    demoApp.ts          # clone, reset and seed the demo-app work copy
    dashboard.ts        # Playwright helpers for the hosted dashboard
    stills.ts           # capture, composite, size check
    encode.ts           # the ffmpeg recipes (palette compression, AV1/H.264/poster)
    recorder.ts         # 2× screencast over CDP (see 3)
    timeline.ts         # the beat recorder (see 3)
    video.ts            # take -> render -> encode
  vscode-helper/        # opens the ctrlyoke panel in the capture host (see 2)
  fixtures/workflows/   # the workflows the stills show
  fixtures/home/        # seeds the capture host's user home
  fixtures/runs/        # phase 2: recorded run bundles used by replay (see 5)
  .work/                # gitignored: demo-app clone, VS Code profile, user home
```

`npm run media -- <shot>` captures one asset into `images/screenshots/` under its final name.
`npm run media -- --all` retakes everything that doesn't need a device.

### 2. Stills

Each still is one entry: a dev-host mode, the dashboard state to reach (seeded settings, an opened
workflow, a replayed run), the element to clip to, and the output name. The script:

1. Starts the dev host in its `media` mode on a demo-app work copy and reads the URL from
   `.ctrlyoke/dev/server-url.txt`.
2. Opens a browser context at `deviceScaleFactor: 2` and the shot's viewport.
3. Drives the UI to the state, sets the theme, hides the cursor, and screenshots the clip.
4. Runs every theme variant the shot needs without changing anything else (the walkthrough's four
   themes, for example).

What phase 1 found out, which the code depends on:

- **The capture host replaces the whole user home**, not just `CTRLYOKE_HOME`. ctrlyoke reads
  user settings, MCP servers, skills and agents from `os.homedir()` (`createUserConfigBackend`);
  `CTRLYOKE_HOME` only moves run state. Without the fake home, a capture showed the capturing
  user's default model, skills and permission mode. Harness detection only needs `PATH`.
- **The VS Code panel has to open.** Hosted tabs only finish startup after the panel's READY
  (`dev/bugs/backlog/hosted-tabs-wait-for-vscode-panel-to-open.md`), and a fresh profile never
  shows it. `media/vscode-helper/`, a second `--extensionDevelopmentPath`, runs
  `ctrlyoke.dashboard.focus` at startup. It is also the obvious place to add commands later for
  driving VS Code itself.
- **Themes come from VS Code, not the browser.** The panel captures VS Code's theme colors and the
  server serves them. Rewriting `workbench.colorTheme` in the capture profile switches all four
  themes live, and the page's `<body>` class confirms the switch.
- **New tabs are slow once workflows are loaded**, 10-30 s each
  (`dev/bugs/backlog/hosted-tab-startup-stalls-with-loaded-workflows.md`). `--all` takes about
  6 minutes, mostly that wait.
- Two Playwright traps, both now guarded: clicking a drawer tab mid-slide scrolls the page body,
  and a mouse wheel at the end of a panel scrolls the page too. A capture fails if the body is
  scrolled.

This replaces the agent-driven MCP retakes for #12's tab shots and the walkthrough's
`verifyHarness` image; #4/#5's settings pages and #10's desktop stills can follow the same
pattern. Of the walkthrough stills, only `verifyHarness` comes from the dashboard alone. The others
frame VS Code itself (activity bar, integrated terminal, the panel inside the window) and stay
manual until something can drive and capture a VS Code window.

### 3. Video capture writes its own edit list

The capture script knows exactly what it clicks and when. While it records, it writes a
`timeline.json` next to the raw video:

```json
{
  "video": "hero.raw.webm",
  "viewport": { "width": 1350, "height": 900 },
  "beats": [
    {
      "t": 1.2,
      "kind": "click",
      "label": "Run",
      "box": { "x": 1180, "y": 24, "w": 64, "h": 28 }
    },
    {
      "t": 3.4,
      "kind": "focus",
      "label": "Output pane",
      "box": { "x": 420, "y": 80, "w": 900, "h": 760 }
    },
    { "t": 9.8, "kind": "hold", "duration": 1.0 }
  ]
}
```

`lib/timeline.ts` wraps the Playwright actions (`beat.click(locator, label)`), so each beat records
the timestamp and `boundingBox()` at the moment it happens. No one has to find timestamps by
scrubbing.

**HiDPI, settled 2026-10-18:** Playwright's `page.screencast` (both `path` and `onFrame`) and
`recordVideo` deliver CSS-size frames whatever the context's `deviceScaleFactor`; a "2×" video
from them is an upscaled 1× one. Chromium's own `Page.startScreencast` sends device-pixel frames
only when the browser runs at that scale, so `lib/recorder.ts` launches Chromium with
`--force-device-scale-factor=2`, keeps `deviceScaleFactor: 2` on the context, and reads the
screencast over a CDP session. Frames arrive on repaint (about 26 fps at 2700×1800 on the
dashboard) with their own timestamps and are laid onto 30 fps by ffmpeg's concat demuxer.

**As built (phase 3).** Beats are `click`, `hover`, `focus` and `mark`, each with a label, time
and box. Holds are an edit decision, so they live in the composition, not the timeline. Headless
Chromium draws no cursor, so the edit draws one from the click and hover beats (it glides between
them, ripples on a click and fades when idle) rather than relying on Playwright's `showActions`
overlay. A take's `prepare` reaches the opening frame unrecorded and must leave the document
unscrolled: loading a workflow through the Load Workflow File dialog scrolls the body, and the
take refuses to start if it is.

### 4. Edit as code

A Remotion composition takes the raw video and `timeline.json` and builds the edit:

- zoom and pan toward each `focus`/`click` beat's box, eased, and back out
- slow motion or speed-up per segment (`playbackRate`)
- trims, holds and loop points for GIFs
- optional captions and title cards

Each asset is a short composition (`Hero.tsx`) on top of shared helpers (`zoomToBox`, `hold`,
`loopFade`). Changing the edit means editing a small TSX file, which an agent can do from a
one-line request ("hold half a second longer on the output pane"). Remotion renders an MP4, and
`lib/encode.ts` then runs the existing AV1/H.264 and GIF recipes.

### 5. Run replay (makes captures repeatable)

The capture scripts can only produce the same frames each take if the dashboard shows the same run
each take. **Run replay** plays a recorded run back into the live dashboard: steps start, output
streams, file changes and end conditions arrive with the original relative timing (optionally
scaled), and no harness is started.

- **Source:** a run's `events.jsonl` is already the complete, typed record of what the dashboard
  showed (`TIMELINE_EVENT_TYPES`). Recording a demo run once with a real harness gives a fixture;
  reshooting after a UI change replays it into the new UI.
- **Portability:** fixtures need to move between machines and live in `media/fixtures/runs/`. That
  is the run bundle from [`RUN_EXPORT_PLAN.md`](RUN_EXPORT_PLAN.md): replay should consume that
  bundle format rather than invent a second one, and reuse the materializer it shares with
  [`HARNESS_SESSION_IMPORT_PLAN.md`](HARNESS_SESSION_IMPORT_PLAN.md). The bundle's redaction pass
  also covers anything personal in a fixture.
- **Seam:** replay should feed events in through the same path a live run publishes through (the
  run-view publisher that the dashboard already subscribes to), so the dashboard can't tell the
  difference and no UI code changes. Confirm the exact seam when this starts; don't add a parallel
  render path.
- **Controls:** `--speed <factor>`, pause at a given event, and "jump to the end state" (for stills
  that show a finished run).
- **Workspace side effects:** file-change events reference real paths. A replay either reapplies
  the recorded diffs to a scratch copy of the demo project (so diffs and Undo are real), or shows
  them read-only. Stills of the diff pane and Undo dialog need the first.
- **Scope:** starts as a dev-only command (`src/dev/`, dead-code-eliminated from production) driven
  by the capture scripts. A user-facing "replay this run" (watching a past run play back) is a
  possible later feature and should not be designed out, but it isn't the goal here.

Fixtures to record first: the hero demo workflow (#6), the rate-limiter run behind the harness
deck (#1), and a run with a multi-file change (#11).

**The first two already exist and don't need re-recording.** The hero workflow's completed run
from 2026-09-08 (`hero-gif-2026-09-03T03-48-14-807/run-2026-09-08T03-14-04-220Z`, 191 events, all
six steps) and the six `rate-limiter-middleware-*` runs are in demo-app's user-scoped run history.
Replay renders them in the current UI, so the outdated heading row in the old clip doesn't matter.
Because that history is machine-local, raw copies are backed up outside any repo in
`~/ctrlyoke-media-raw-runs/` on Nathan's desktop. They are not committed raw: they hold absolute
paths and unredacted transcripts. They go into `media/fixtures/runs/` only as exported bundles.

Replay removes the harness, not the workspace. File-change events, diffs, Undo and the
workspace-viewer stills need the demo project's real files at the run's starting commit. **A
fixture is therefore a run bundle plus a demo-app start tag**, and that pair is the only coupling
between the two repos (see 7).

**As built (phase 2).** The design above held except for the seam:

- **Seam: the harness, not the publisher.** `src/dev/replay/` swaps the harness and script
  runners, not the run-view publisher. `WorkflowOrchestrator.setExecutionOverride` gives new
  instances a `ReplayIntegrationFactory`, whose `ReplayIntegration` (an `HarnessIntegration`)
  plays back each step's recorded stream and output, and whose `ReplayScriptProcessRunner`
  returns each pre/end-condition and script step's recorded result without running it. Everything
  above that (state machine, retries, end-condition policy, history, timeline, dashboard sink) is
  the real engine, so the run being shown is a live run that the dashboard and history record
  like any other. Feeding the publisher instead would have meant re-deriving all of that state.
- **Arming:** environment variables read once at activation in a dev build (`IS_DEV_MODE`), before
  any instance exists, because an instance captures its factory when built:
  `CTRLYOKE_DEV_REPLAY=<bundle dir>`, `CTRLYOKE_DEV_REPLAY_SPEED` (default 1; `0` jumps each step
  to its end state), `CTRLYOKE_DEV_REPLAY_MAX_GAP_MS` (idle-gap cap, see phase 3) and
  `CTRLYOKE_DEV_REPLAY_PAUSE_AT=<event seq>` (holds until the host stops).
  The bundle's workflow is written to `.ctrlyoke/workflows/<slug>.ctrlyoke.json` with every step
  forced headless; the capture script loads and runs it like any workflow.
- **Workspace side effects** are real: streamed `fileWrite` events are applied as they arrive,
  and each step's end state is rebuilt from its snapshot's patches, so the bundles carry
  snapshots (`--with-snapshots`). A hero replay at `hero-start` in the real capture host completed
  all six steps and left every tracked file byte-identical to `hero-end` (checked 2026-10-18).
- **Timing is the recording's own.** Each streamed delivery plays at its recorded offset from
  its attempt's start, divided by the speed, and is scheduled against that start, so waits never
  drift. There is no fixed tick and nothing was trimmed from the fixtures. A delivery is whatever
  the live run appended at once (a message, a tool call, a batch of up to four events), not
  single tokens, because that is what `events.jsonl` records and what the live dashboard showed.
  The gaps are uneven and sometimes long: the hero run is 18 minutes, with step 3 (Codex, 7
  minutes) waiting a median 4.7 s between deliveries and up to 92 s. A uniform speed-up keeps
  the variation but also keeps the dead air in proportion, so the hero clip needs idle gaps
  capped (see phase 3).
- **Limits:** git commits are not recreated (the hero's `commit` step plays its output but makes
  no commit); interactive steps play headless; arming applies to every run in that host;
  harness-availability badges still come from the real detectors; payload session ids are kept;
  workflow assets are not bundled yet.

### 6. Phone recordings

The capture stays manual (real device, see `SCREENSHOTS_AND_MEDIA_PLAN.md` #7). The edit becomes
`npm run media -- phone <recording.MOV> <shot>`:

1. HEVC variable frame rate → H.264 at a constant 30 fps (ffmpeg).
2. Trim to the shot's in/out points, kept in a small per-shot JSON next to the composition.
3. Composite into the transparent phone frame with a rounded-corner mask, done with ffmpeg
   `overlay` and `alphamerge` or as a Remotion composition (`PhoneFrame.tsx`). This replaces the
   Resolve Fusion mask.
4. Export the stills at the listed timestamps (750×1532 PNG) and the overview as an animated WebP
   with alpha.

### 7. Demo project and fixtures (decided 2026-10-18)

- **Capture scripts and fixtures live in this repo, under `media/`.** They depend on ctrlyoke's
  selectors, the `dev:host:*` scripts, `server-url.txt` and the `events.jsonl` schema, so they break
  when the UI changes and must be versioned with it. demo-app is what gets filmed, not the tool.
- **demo-app stays its own git repo**, published privately as
  `https://github.com/nhickster/ctrlyoke-demo-app` (tags included). It has to be a real repo: the workflows commit, the Source Control shots show its history graph, and
  `prompt-editor-demo.ctrlyoke.yaml` cites a `~commit`. Vendoring a copy into this repo would give
  it new commit hashes on every machine.
- **`media/demo-app.json` pins it:** the repo URL, the ref to check out, and the named start tags
  the fixtures use. `npm run media -- setup` clones it into a gitignored work folder. A git
  submodule was considered and rejected: it has to be initialized again in every long-lived
  worktree (`big-feature`, `small-feature`, `bug-fix`), and agents trip over it.
- **Each starting state is a tag in demo-app, not a hash in a comment.** Tags today:
  `hero-start` (`5d8ae81`) and `hero-end` (`61af34a`, the 2026-09-08 run's output) for #6;
  `rate-limiter-start` (`c1e9eef`) for #1. `baseline` is not a start state; it tracks the latest
  capture-workflow commit.
- **Live takes run in a worktree at the start tag** (`git worktree add ../demo-app-hero
hero-start`), never in the main checkout, where `git reset --hard` plus `git clean -fd` would
  wipe later workflows and uncommitted work. Replay's scratch copy follows the same rule: the
  capture script materializes it from the tag in the work folder.
- **Fixtures are committed as exported, redacted run bundles** in `media/fixtures/runs/`, each
  naming its demo-app start tag. The hero run's `events.jsonl` is about 850 KB, so plain git is fine
  for now. Reconsider compression or LFS only if fixtures grow past a few MB each.

## Phases

The original order spiked the hero clip against a live run because no fixture existed. One does
(see 5), so the hero clip now waits for replay and never needs a paid re-run.

1. **Scaffolding plus stills. Done 2026-10-18.** `media/` with `setup`, the `media` dev host
   mode, #12's ten tab shots and the walkthrough's `verifyHarness` image in four themes, all
   retaken by script. The MCP-driven retakes for those shots are retired.
2. **Minimal export plus replay. Done 2026-10-18.** `RunBundleExporter` core (path rewrite,
   identity demotion, redaction) and `ctrlyoke export`, no UI; dev-only replay (see "As built" in
   5); the hero and six rate-limiter runs exported to `media/fixtures/runs/` and listed in its
   `fixtures.json` with their start tags.
3. **Hero clip on replay. Done 2026-10-18.** `lib/timeline.ts`, `lib/recorder.ts`,
   `lib/video.ts`, `shots/hero.capture.ts` and `compositions/Hero.tsx`. Replay gained an idle-gap
   cap (`CTRLYOKE_DEV_REPLAY_MAX_GAP_MS`, `--max-gap`): a gap between deliveries longer than the
   cap plays as the cap, shorter gaps as recorded, applied before `--speed`; event timestamps
   move with their delivery. At 1.2 s the 18-minute run records in about 2.3 minutes, and the edit
   cuts that to 31 s. The hero now ships as `hero-av1-2700x1800.mp4` (2×, AV1 CRF 48, 24 fps,
   about 4 MB), the 1× fallback `hero-h264-1350x900.mp4` and `hero-poster-2700x1800.webp`.
   It is larger than the old 1×, 5 fps clip (720 KB) because it is twice the resolution and
   five times the frame rate; raise the CRF or drop to 1× in `lib/encode.ts` if weight matters
   more than sharpness. The same edit also writes the README's `readme-demo-900x600.gif`.
   **Colour, found 2026-10-19:** screencast JPEGs are full-range BT.601 and ffmpeg passes that
   through untouched, so stills made with ffmpeg looked right while browsers (which treat web
   video as limited-range BT.709) showed crushed, shifted colours. Every video stage now
   converts and tags limited-range BT.709 (`webVideoColorArgs`, Remotion `colorSpace: "bt709"`),
   and `lib/colorCheck.ts` decodes a frame in Chromium and in ffmpeg after each encode and fails
   the shot when they disagree.
4. **Prompt editor clip (#9).** Typed live by Playwright into the hosted dashboard with
   `pressSequentially` and a per-key delay, so completions open as they would for a person. The
   opening "Add Selection to ctrlyoke" beat moves from VS Code to the workspace viewer: open
   `src/routes/notes.ts` in it, select lines 17-37 with the mouse (click the start of line 17,
   shift-click the end of line 37: the editor's handle isn't reachable from the page), right-click, pick "Add Selection to ctrlyoke"
   (`useWorkspaceEditorContextMenu`), close the viewer and continue typing the beats in
   `prompt-editor-demo.ctrlyoke.yaml`. Prep the header asks for (`atomicContextReferences` on, a
   dummy `CODECOV_TOKEN` secret) goes in the capture's fixtures, not by hand. Needs no replay.
5. **"Build visually or edit as YAML" clip (#14).** Two pages on the same host, recorded
   separately and composed side by side; they show the same workflow but are not live-synced.
   Left: the dashboard step list building `bug-sweep.ctrlyoke.yaml`, dragging a step into the
   parallel group and reordering, then setting harness and model in the properties panel. Steps
   drag with dnd-kit's pointer sensor, so the script drives `page.mouse` down, a multi-step move
   past the 5 px activation distance, and up (Playwright's `dragTo` dispatches HTML5 drag events,
   which dnd-kit ignores). Right: the same file open in the workspace viewer's
   `WorkspaceFileEditor`, typing a step and accepting ctrlyoke's YAML completions (a `harness:`
   value, an `@` path, `$step:`). Ships with the landing heading change in
   `SCREENSHOTS_AND_MEDIA_PLAN.md` #14.
6. **Phone pipeline.** Rebuild one existing iOS still set from its raw recording and compare it to
   the Resolve output. Deferred behind the two clips above because the phone stills already
   exist.
7. **New media.** The rest of the shots that were never taken (#10's phone clip) on the new
   pipeline.

**VS Code itself stays manual.** The capture host is driven through the hosted dashboard in
headless Chromium: it can't select text in a VS Code editor, open VS Code's own menus, or record
the VS Code window. Anything that has to show VS Code (the walkthrough frames in #13, the
integrated terminal) is captured by hand; a shot that only needs a VS Code feature that the
dashboard also has (selection to prompt, YAML editing) is moved onto the dashboard instead.

## Rejected: embedding live dashboard components in the site

Rendering real dashboard components in `landing/` or `docs/` instead of screenshots (always
current, crisp at any DPI, theme-aware) was considered and rejected for now:

- **Size.** The dashboard bundle is one large entry (`out/ui/webview-react/assets/dashboard.js` is
  about 12 MB in a dev build, before the ELK, Cytoscape, KaTeX and CodeMirror chunks). Panels import
  shared stores, hooks and editors, so a single panel pulls in most of it. Tree-shaking it down to
  one component would mean restructuring imports for the site's sake.
- **Runtime coupling.** Components expect the message bridge, Zustand stores populated by the
  extension, `--vscode-*` theme variables, Codicons and the Tailwind build. A showcase build would
  have to stub all of these and keep the stubs in sync with every refactor, or the site breaks
  silently.
- **The landing page is static Astro** with no UI framework integration. Adding React islands is
  possible but is a real cost for a marketing page.

If it's ever worth revisiting, the narrow version is a separate Vite "showcase" entry that renders
one component with its stores seeded from a fixture (the way the Vitest component tests already
do), served as a standalone page inside an `<iframe>` on the docs only. The capture scripts above
could screenshot that same page, so it would be groundwork for both.

## Open questions

None open. Fixture storage and where demo-app lives were decided 2026-10-18 (see 7). Replay is
dev-only for now (decided 2026-10-18 with phase 2): a user-facing `ctrlyoke replay` would need
the limits in 5 lifted first, commits above all, and the `ExecutionHarnessOverride` seam leaves
room for it.
