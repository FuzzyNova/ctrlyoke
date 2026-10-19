# Media Capture Automation Plan

**Status (2026-10-18):** Phase 1 done: `media/` exists and retakes #12's ten tab shots and the
walkthrough's `verifyHarness` image (four themes) with `npm run media -- --all`. Phases 2-5 are
open. This is the "how" for [`SCREENSHOTS_AND_MEDIA_PLAN.md`](SCREENSHOTS_AND_MEDIA_PLAN.md), which
stays the shot list and slotting plan. `media/README.md` covers using it and adding shots.

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
  package.json          # playwright, typescript (remotion arrives with phase 3)
  cli.ts                # `npm run media -- ...` (run by Node's type stripping, no build)
  demo-app.json         # demo project repo URL, pinned ref, named start tags (see 7)
  shots/                # one capture script per shot list entry
    properties-tabs.capture.ts
    walkthrough.capture.ts
    hero.capture.ts     # phase 3
  compositions/         # phase 3: Remotion compositions, one per video asset
  lib/
    devHost.ts          # start/stop the dev host, switch its theme
    demoApp.ts          # clone, reset and seed the demo-app work copy
    dashboard.ts        # Playwright helpers for the hosted dashboard
    stills.ts           # capture, composite, size check
    encode.ts           # the ffmpeg recipes (palette compression so far)
    timeline.ts         # phase 3: the beat recorder (see 3)
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

To check before building on it: whether `page.screencast` frames are captured at the context's
device scale factor. Third-party reports say the older `recordVideo` option records at 1× and
looks soft on HiDPI. If screencast is also 1×, either assemble the frames from `onFrame` (JPEG,
`quality: 100`), or record the headed browser window with ffmpeg `ddagrab`.

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
2. **Minimal export plus replay.** Only the parts of `RUN_EXPORT_PLAN.md` replay needs:
   `RunBundleExporter` core (path rewrite, identity demotion, redaction) and a CLI command, not the
   UI. Then the dev-only replay command (see 5). Export the hero and rate-limiter runs as the first
   fixtures.
3. **Hero clip on replay.** `lib/timeline.ts`, the hero capture script and `Hero.tsx`, replaying
   the 2026-09-08 run into a scratch copy at `hero-start`. Settle the HiDPI question from 3.
   Outcome: a new hero clip with the current heading row, retakeable for free.
4. **Phone pipeline.** Rebuild one existing iOS still set from its raw recording and compare it to
   the Resolve output.
5. **New media.** Capture the shots that were never taken (#9, #14, #10's phone clip) on the new
   pipeline.

If the hero clip is needed before phase 2 lands, run `hero-gif.ctrlyoke.yaml` once more in a
`hero-start` worktree. That costs one six-harness run and gives a second fixture. Check the models
it names are still available first.

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

1. Does replay belong behind the dev build only, or should the CLI ship a `ctrlyoke replay` for
   users from the start?

(Fixture storage and where demo-app lives were decided 2026-10-18; see 7.)
