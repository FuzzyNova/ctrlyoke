# Media capture

Rerunnable capture scripts for the screenshots in `images/screenshots/`. The plan and the phases
still to come (run replay, the hero clip, the phone pipeline) are in
`dev/backlog/MEDIA_CAPTURE_AUTOMATION_PLAN.md`. The shot list is
`dev/backlog/SCREENSHOTS_AND_MEDIA_PLAN.md`.

## Use

From the repo root:

```sh
npm run media -- setup                  # once: dependencies, Chromium, demo-app clone
npm run media -- list                   # shots and the files they write
npm run media -- properties-tabs        # retake one shot into images/screenshots/
npm run media -- --all                  # retake every shot
npm run media -- properties-tabs --only mcp-tab-800x1600.png
npm run media -- --all --out ../preview # write somewhere else to compare first
npm run media -- host properties-tabs   # start the capture host and leave it running
npm run media -- replay hero --speed 0  # host on a recorded run's start state, armed to replay it
npm run media -- hero                   # record, edit and encode the hero video
npm run media -- hero --edit-only       # re-render the last take after changing its composition
```

Each capture compiles the extension, so it shows the current source. Stop any running dev host
first (`npm run dev:host:stop`): only one can run at a time. Your display scaling doesn't matter,
because stills render headless at 2×. `quantize` shots (media that ships in the VSIX) need
`ffmpeg` on `PATH`.

## How a capture runs

1. `prepareDemoApp` resets the demo-app clone in `.work/demo-app` to the ref pinned in
   `demo-app.json`, serves its dashboard on loopback over HTTP, and copies the shot's
   `fixtures/workflows/` files in.
2. `startHost` starts the `media` mode of `scripts/dev-host.mjs` on that clone. The host gets a
   fresh VS Code profile and a fresh user home (`USERPROFILE`/`HOME` = `.work/home`, seeded from
   `fixtures/home/`), so your own `~/.ctrlyoke` settings, MCP servers and skills never show up. It
   also loads `vscode-helper/`, which opens the ctrlyoke panel: hosted tabs don't finish starting
   until the panel has loaded.
3. Each still opens a fresh page at the shot's viewport, drives the dashboard to its state,
   and screenshots it. A theme switch rewrites the host's VS Code settings and waits until the
   dashboard serves the new theme.
4. Composites join part stills side by side, and the PNG size is checked against the file name's
   `-<w>x<h>` suffix.

## Videos

A video shot (`VideoShot` in `lib/video.ts`) is one take of the dashboard, replaying a recorded
run, cut by a Remotion composition and encoded. `npm run media -- <video>` runs all three:

1. **Take.** The host starts on the run's start tag with replay armed. The shot's `prepare` gets
   the dashboard to its opening frame unrecorded, then `record` performs the take through a
   `Timeline` (`lib/timeline.ts`): `timeline.click(locator, "run")`, `hover`, `focus` and `mark`
   each record a named beat with its time and the element's box. `lib/recorder.ts` records at 2×
   from Chromium's screencast. The take lands in `.work/video/<id>/` as `raw.mp4` and
   `timeline.json`.
2. **Edit.** `compositions/<Name>.tsx` lists cuts over the take by beat name: which stretch plays
   at what rate, which beat's box the camera frames, and holds. `compositions/edit.ts` turns
   that into frames, an eased camera and a drawn pointer (headless Chromium draws none).
   Change the edit, then `--edit-only` re-renders the last take without recording again.
   `npx remotion studio compositions/index.ts --public-dir .work/video/<id>` previews it live
   (paste the take's `timeline.json` as the props).
3. **Encode.** `lib/encode.ts` writes the AV1 file, the H.264 fallback, the WebP poster and,
   if the shot asks for one, a GIF of the opening (the README's). Every video stage is converted
   to limited-range BT.709 and tagged as such, because that is what browsers assume. Then
   `lib/colorCheck.ts` decodes one frame in Chromium and in ffmpeg and fails the shot if the
   colours differ.

Videos need `ffmpeg` with `libsvtav1` on `PATH`. A hero take replays the whole run, so it takes
about four minutes before rendering starts.

## Recorded runs

A shot that shows a run replays a recorded one instead of calling a harness, so every take shows
the same output and costs nothing. `fixtures/runs/` holds run bundles from `ctrlyoke export`, and
`fixtures/runs/fixtures.json` names each one with the demo-app tag its run started from.

`replay <run>` checks demo-app out at that tag, then starts the host with `HostOptions.replay`,
which arms the dev build's replay (`src/dev/replay/`) through `CTRLYOKE_DEV_REPLAY*` environment
variables. The host writes the run's workflow to `.ctrlyoke/workflows/`; loading and running it
plays the recording through the real engine, file changes included. `--speed 0` jumps each step to
its end state, and `--pause-at <seq>` holds playback before that event in `events.jsonl`.
`--max-gap <ms>` plays any idle stretch longer than that as that (before `--speed`), so long
thinking pauses shrink while the uneven rhythm of the rest survives. Replay
makes no git commits.

To add a run, export it from the workspace that recorded it and add it to `fixtures.json`:

```sh
ctrlyoke export --cwd <demo-app checkout> --workflow <key> --run <ref> --with-snapshots \
  --out media/fixtures/runs/<name>
```

Snapshots carry the file contents replay applies, so keep `--with-snapshots`. Check the export
summary for paths outside the workspace and the redaction count, then grep the bundle for your user
name before committing it.

## Adding a shot

Add `shots/<name>.capture.ts` exporting a `Shot` (see `lib/shot.ts`) and register it in
`shots/index.ts`. Put the workflow it shows in `fixtures/workflows/` with every value the shot
depends on spelled out. Helpers for the dashboard live in `lib/dashboard.ts`. Select elements by
role and accessible name; if an element has none, give it one in the component rather than
reaching for a CSS class.

Shots that show VS Code itself (the walkthrough's activity bar or integrated terminal frames)
can't come from the hosted dashboard and remain manual.
