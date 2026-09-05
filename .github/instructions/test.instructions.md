---
applyTo: "src/test/**"
---

<purpose>
Mocha/TDD tests for ctrlyoke core logic and the VS Code extension host. This scope also includes the separate real-harness suite under `src/test/harness/**`; React webview tests live under `src/ui/webview-react/**` and use Vitest instead.
</purpose>

<entryPoints>

- `src/test/runTest.ts` launches `@vscode/test-electron`; `src/test/suite/index.ts` discovers compiled `**/**.test.js` files under `out/test`.
- `src/test/suite/index.ts` ignores only `harness/**`. `src/test/suite/harness/LogParsers.test.ts` is still part of normal `npm test`; only `src/test/harness/**` is excluded.
- `package.json`: `npm test` runs `test:extension` (the extension-host suite), `test:ui`, and `test:packaging`; `npm run test:harness` runs only `out/test/harness/**/*.test.js` with a 15-minute timeout; `test:unit` is a narrow `MOCHA_GREP` target, not the full unit suite.
- **`compile-tests` is `tsc -p . && node esbuild.js`, and the two halves must stay together.** `tsc` emits unbundled output over esbuild's bundles; the trailing esbuild run restores them. Those bundles alias `vscode` to `src/platform/vscode-shim.ts`, so without it `out/mcp-server.js` and `out/cli.js` die with `MODULE_NOT_FOUND: vscode` when a test spawns them — which reads like an import leak and is not one.

</entryPoints>

<organization>

- Keep the existing split: top-level `src/test/*.test.ts` for legacy/core tests, `unit/` for focused module tests, `integration/` for extension-host behavior, `suite/harness/` for log-parser contract tests, and `harness/` for real CLI end-to-end tests.
- Prefer one test file per production module. Use Mocha TDD style (`suite`, `test`, `setup`, `teardown`) with Node `assert`; this tree generally uses hand-written fakes/test subclasses instead of Sinon.
- When testing abstract or protected behavior, expose it via a small test subclass rather than weakening production visibility.

</organization>

<stateIsolation>

- Many tests mutate process-wide state (`RuntimeMode`, `HOME`/`USERPROFILE`/`APPDATA`, `process.platform`, config singletons, temp workspace roots). Always restore globals in `teardown`/`afterEach` to avoid cross-test pollution. `process.platform` is the sharpest of these: a suite that fakes it per case without restoring leaves every later test in the run seeing the last value set, so a Windows host silently exercises POSIX branches and the damage surfaces far from its cause.
- Temporary directories are commonly created with `os.tmpdir()`; cleanup is part of the contract. Do not leave harness workspaces, temp JSONL files, or exported config files behind.
- Integration tests that need the real extension should activate it via `vscode.extensions.all`/`extension.activate()` and keep that scope narrow; most behavior should stay in unit tests with lightweight fakes.

</stateIsolation>

<pathAndFixtureGotchas>

- Tests execute from compiled `out/test`, not directly from `src/test`. Resolve fixture paths from `__dirname` accordingly instead of assuming `process.cwd()`.
- Use repo-relative resolution only when the code under test truly depends on repository layout (for example compiled CLI paths or workspace-scoped config files).
- Never hardcode absolute, OS-specific paths (e.g. `C:\dev\ctrlyoke\...`) in fixtures or assertions — the suite runs on Windows, macOS, and Linux. Use neutral relative forward-slash paths (`src/foo.ts`) or derive real paths via `os.tmpdir()`/`path.join`. Pure parser/string inputs that merely _represent_ CLI output and never touch the filesystem may stay realistic.

</pathAndFixtureGotchas>

<harnessTests>

- `src/test/harness/helpers/harnessRunner.ts` is the shared helper for new real-harness tests: compiled CLI path, cheapest-model defaults, `runWorkflowFile()`, and exit-code-3 skip handling already live there.
- Real harness tests are correctness checks, not fast unit tests. Keep generous timeouts, require compiled output, and treat CLI exit code `3` as "harness not installed" (skip) rather than a failure.
- Do **not** run `npm run test:harness` to verify ordinary code changes: it drives **live** AI CLIs, takes ~30 minutes, and individual harnesses can be unavailable (e.g. a vendor pulling CLI support). For verification use `npm test` / `npm run test:ui`, and target specific cases by grep (extension host: `MOCHA_GREP="<pattern>" npm run test:extension`, which compiles first — `runTest.js` accepts no `--grep` flag, only the env var read by `src/test/suite/index.ts`; Vitest: pass a file path).
- Keep real-harness coverage focused on flows that mocks cannot prove: hook delivery, multi-step execution, retry/end-condition behavior, MCP queue extension, and other harness-specific end-to-end contracts.

</harnessTests>

<coverageTooling>

- `npm run test:coverage` (see `scripts/report-extension-coverage.mjs`) covers the extension-host suite. `nyc`/`c8` can't wrap `out/test/runTest.js` directly because it spawns VS Code as a separate Electron process — instead the script sets `NODE_V8_COVERAGE` so that process writes raw V8 coverage itself, then runs `c8 report` against those files.
- On Windows, Node always lowercases the drive letter in `file://` coverage URLs (e.g. `file:///c:/dev/ctrlyoke/...`) while `c8` resolves the project root with OS-native casing (`C:\dev\ctrlyoke`). Since `c8`'s glob matching is case-sensitive, every file silently reports 0% unless the raw coverage JSON is normalized first (the script does this).
- `c8`'s `--include`/`--exclude` glob must match the _executed_ script path (`out/**/*.js`, since tests `require()` the tsc output directly) — not the original `src/**/*.ts`. The remap to `.ts` filenames for display happens afterward via source maps, so filtering on `src/**/*.ts` matches nothing and reports empty.
- `out/ui/webview-react/**` and `out/runtime-deps/**` are Vite/copied bundles with inlined vendor sourcemaps (mermaid, cytoscape, lodash, react, ...); leaving them in `--include` pollutes the report with thousands of always-0% vendor "files". They're excluded in the script; webview coverage lives separately via `npm run test:ui:coverage`.

</coverageTooling>

<highValueCoverage>

- The most important unit-test seams in this tree are runtime state ownership (`WorkflowStateMachine`, `WorkflowInstance`, `WorkflowExecutor`), working/history file persistence, CLI transport/parsing coordinators, property/session resolution, MCP/hooks config file mutation, and path/security validation.
- When changing workflow persistence or replay behavior, update tests around timeline-backed history (`OutputHistoryManager`, `TimelineRecorder`, `OutputCaptureBuffer`) because those pieces encode cross-file data flow that is easy to break.
- `schemaUiPropertyRoundTrip.integration.test.ts` and the `WorkflowSerializer` round-trip suite enumerate schema properties and assert each one survives save and has a live editor control. **Never add an opt-out entry (`UI_CONTROL_OPTOUTS`, or a local deferred-field set) just to make a partially-staged step go green.** These suites are the only thing that catches a per-step field missing from `WorkflowSerializer.PROMPT_FIELDS` — that allowlist silently drops anything absent from it, so the field appears editable and is discarded on save. An opt-out added "until the next step" reliably outlives the step that added it and converts a loud failure into a silent data-loss bug; a per-step field is not done until it is in `PROMPT_PROPERTIES`, in `PROMPT_FIELDS`, and registered in the control-id map.

</highValueCoverage>
