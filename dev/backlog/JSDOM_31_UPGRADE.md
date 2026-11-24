# Upgrade jsdom 30 → 31

**Status:** blocked. Dependabot ignores jsdom majors (`.github/dependabot.yml`); delete that entry to get the PR back.

## Why it's blocked

jsdom is a dev dependency used only by the React dashboard's Vitest suite (`npm run test:ui`), so nothing ships to users. Dependabot PR #25 (jsdom 30.1.3 → 31.0.1) failed 13 UI tests and was closed. The extension-host suite and `checks` passed.

jsdom 31.0.0 replaced its CSS parsing, cascade and computed-style implementation with a new integrated engine. Its release notes say "CSS serialization and computed values can differ from previous releases". Almost every failure is a `toHaveStyle()` or inline-style assertion on a color, border or transform:

- `OutputRow`, `OutputScrollSeekPlaceholder`, `WorkflowStepsPanel` and `StepChipRail`: step identity bars, palette colors and severity borders.
- `WorkflowStepRowDisplacement`: drag displacement transforms and rail colors.
- `fileBrowserShared` (`EntryRow` header tracks) and `ToastViewport` (safe-area offset, elevated layer).
- `DiffFileList` virtualization: "restores the first visible file anchor after a global reset" can no longer find `file-50.ts`. This one is about layout and measurement, not serialization, so look at it separately.

Each failure has to be classified as one of two things. Either the test asserts jsdom's old serialization of a value (for example a color format or a shorthand expansion), so the assertion should be fixed. Or the component sets a style the new engine rejects, which would be a real bug that browsers might share.

## What the upgrade has to do

1. Bump jsdom on `main`, run `npm run test:ui`, and go through the failures above. Don't loosen assertions until a failure is confirmed to be serialization only.
2. jsdom 31 moved its optional canvas backend from `canvas` to `@napi-rs/canvas`. ctrlyoke installs neither today; if a test starts needing canvas, install `@napi-rs/canvas`, not `canvas`.
3. The `textRange(...).getClientRects is not a function` lines in the PR #25 log are stderr from CodeMirror. They come from test files that don't install the `Range.prototype.getClientRects` polyfill many editor tests define locally, and they don't fail the run. Don't mistake them for upgrade failures.
4. Remove the `ignore` entry and close this doc in the same commit.
