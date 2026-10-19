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

## Adding a shot

Add `shots/<name>.capture.ts` exporting a `Shot` (see `lib/shot.ts`) and register it in
`shots/index.ts`. Put the workflow it shows in `fixtures/workflows/` with every value the shot
depends on spelled out. Helpers for the dashboard live in `lib/dashboard.ts`. Select elements by
role and accessible name; if an element has none, give it one in the component rather than
reaching for a CSS class.

Shots that show VS Code itself (the walkthrough's activity bar or integrated terminal frames)
can't come from the hosted dashboard and remain manual.
