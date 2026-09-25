---
applyTo: "src/test/**"
---

<purpose>
Mocha/TDD tests for ctrlyoke core logic and the VS Code extension host. This scope also includes the separate real-harness suite under `src/test/harness/**`; React webview tests live under `src/ui/webview-react/**` and use Vitest instead.
</purpose>

<entryPoints>

- `src/test/runTest.ts` launches `@vscode/test-electron`; `src/test/suite/index.ts` discovers compiled `**/**.test.js` files under `out/test`.
- `src/test/suite/index.ts` ignores only `harness/**`. `src/test/suite/harness/LogParsers.test.ts` is still part of normal `npm test`; only `src/test/harness/**` is excluded.
- `package.json`: `npm test` is `scripts/run-test-suites.mjs`, which compiles once and then runs `test:extension:run`, `test:ui`, and `test:packaging` **concurrently** (see `<parallelism>`); `npm run test:harness` runs only `out/test/harness/**/*.test.js` with a 15-minute timeout; `test:unit` is a narrow `MOCHA_GREP` target, not the full unit suite.
- **`compile-tests` is `tsc -p . && node esbuild.js`, and the two halves must stay together.** `tsc` emits unbundled output over esbuild's bundles; the trailing esbuild run restores them. Those bundles alias `vscode` to `src/platform/vscode-shim.ts`, so without it `out/mcp-server.js` and `out/cli.js` die with `MODULE_NOT_FOUND: vscode` when a test spawns them — which reads like an import leak and is not one.
- **`pretest` deliberately builds only the webview.** `compile-tests` already runs `tsc -p .`, which emits _and_ type-checks the extension, plus the same `node esbuild.js` that `compile:extension` runs — so a `pretest` of `npm run compile` duplicated a whole `tsc` pass and an esbuild pass on every `npm test`. What `compile-tests` does _not_ produce is the Vite webview bundle under `out/ui/webview-react/`, which the extension host loads, and that is exactly what `pretest` is for.

</entryPoints>

<parallelism>

- **`npm test` compiles first, then runs all three suites at once.** Compiling is hoisted into the orchestrator (`PREPARE_SCRIPT`) rather than left inside `test:extension`, because the extension suite and the packaging suite both read `out/` — `generate-compatibility-docs.test.mjs` reads `out/types/CompatibilityTypes.js`, `statusline-format-packaging.test.mjs` spawns `out/scripts/ctrlyoke-statusline-wrapper.js` — and a compile running concurrently with either one is a race. `test:extension:run` exists for the orchestrator to spawn the already-compiled runner; `test:extension` is the standalone wrapper that still chains the compile, and it is what the summary tells you to re-run.
- **Mocha's `--parallel` cannot be used for the extension suite.** It farms test files out to plain `node` worker processes, and these files load production modules that `require("vscode")`, which only resolves inside the extension host. The only way to use more than one core is more than one extension host: `runTest.ts` launches `CTRLYOKE_TEST_SHARD_COUNT` VS Code instances and `suite/sharding.ts` gives each a disjoint slice of the globbed files (longest-first bin packing, weighted as the next bullet describes — striping a sorted list is not good enough, because the heavy suites cluster by name prefix).
- **Shards are balanced on _recorded_ runtime, not file size.** Splitting on compiled size wasted most of the parallelism: shard durations came out 1m/1m/2m/2m/2m/3m against a 4m45s serial run, because the slow files here are slow for waiting on spawned CLIs and timers, not for being large. Each shard now records per-file elapsed time and `runTest.ts` merges it into `.vscode-test/ctrlyoke-test-timings.json`, which the next split reads (`suite/sharding.ts`); file size is only the cold-start fallback, so a fresh checkout's _first_ `npm test` is the badly balanced one and every run after it is not. Deleting that file is always safe.
- **Past a point the extension suite is floored by its single slowest _file_, not by shard count.** Sharding is file-granular, so no split beats the heaviest file, and adding shards past that only leaves cores idle — when this was first measured, one shard ran 59 tests in 3m while the other five ran 676-967 each in 2m. `.vscode-test/ctrlyoke-test-timings.json` is the place to look before trying to make `npm test` faster: sort it descending and the top entry is the ceiling. Making that file faster is the lever; splitting it is not, because this tree keeps one test file per production module.
- **Every shard needs its own `--user-data-dir`.** `@vscode/test-electron` otherwise points all of them at one shared `.vscode-test/user-data`, which VS Code treats as a single-instance lock: the later instances hand off to the first and exit without running a thing. Each shard also gets its own `CTRLYOKE_HOME`, and `downloadAndUnzipVSCode()` is resolved once up front so the shards do not race each other onto the download cache.
- **Deleting a shard's user-data dir has to tolerate `EBUSY` on Windows.** VS Code is still writing `logs/**/exthost.log` as it shuts down, so an immediate `fs.rm` fails; `runTest.ts` retries and then gives up with a warning, because a leftover temp directory must never fail an otherwise green run.
- **Vitest is already file-parallel; what it needs is a _budget_.** Left at its default it claims a worker per core, which then contends with the extension hosts running beside it. The orchestrator is the single place that knows the whole core budget (`planParallelism`) and passes this suite its share via `CTRLYOKE_UI_TEST_WORKERS`. Unset means "this suite has the machine to itself", which is right for `npm run test:ui`.
- **Use `--serial` when a suite's own output is what you are reading.** Concurrent suites buffer their output and flush it as one labelled block on completion (three reporters writing to one terminal interleave into nonsense), so live progress is a 30-second ticker. `npm test -- --serial` restores one-at-a-time live streaming, and `--bail` implies it — a suite that is already running cannot be "not run".
- **Never call `this.timeout()` with a value at or below the suite default in `src/test/suite/index.ts` (currently 30s).** That default is deliberately sized for a healthy test waiting on a subprocess while five other extension hosts and the Vitest pool have the machine — it is a budget for catching a genuine hang, not a performance assertion. Most `this.timeout()` calls in this tree were written to _raise_ the old 2s default and silently became _lowerings_ when the harness default went up; every one of them was a latent flake that only fired under `npm test` (a one-run sweep removed 31 of them). Raise the harness default instead if a whole suite needs more, and pin a per-file timeout only to go _above_ it, with a comment saying why. The same applies to wall-clock assertions in a test body (`elapsed < 300`): make the thing being outrun far longer than the bound, so the assertion keeps measuring the behaviour rather than the host's scheduler.
- **A test that proves a production limit by actually reaching it pays that cost on every run.** Making the limit a `protected readonly` member a test subclass can shrink (as `HostedWorkspaceViewerService.searchMaxFiles` is) exercises the same boundary without, in that case, 5001 `writeFileSync` calls and their teardown — which is what used to time the case out. Temp-directory cleanup in a `teardown` that ran real `git` needs `maxRetries`/`retryDelay` and a `.catch(() => {})`: Windows holds pack-file locks as git exits, and residual cleanup must never fail an otherwise green run.
- **A test that asserts on chalk-formatted output must pin `chalk.level` itself.** `npm` exports `FORCE_COLOR` to the scripts it runs whenever _its own_ stdout is a TTY, and chalk honours that in preference to `isTTY` — so the colour level of every process in the run, child processes included, is decided by whether the developer redirected the output. This produces the most confusing flake shape in this tree: a bare `npm test` fails while `npm test > out.log` passes, and the case passes in isolation whenever you captured its output to look at it. Assertions like `line === "Steps"` or `lines.includes("  runs sequentially")` are the ones that break. Pin `chalk.level = 0` in `setup` and restore in `teardown` (see `CliDryRunOutput.test.ts`), turn it back up only in a case that is specifically about colour, and pass `FORCE_COLOR: "0"` in the `env` of any child process whose output you assert on — the child inherits the variable.
- **A sharded run puts test files in different processes, which is what makes cross-file order dependence fail.** A file that quietly relied on an earlier _file_ having set up global state will now pick a different shard and break; that is the sharding surfacing a real bug, not sharding being wrong. Likewise, a fixed `path.join(os.tmpdir(), "literal-name")` shared by two test files is safe only while it stays a pure path _fixture_ — the moment one of them creates that directory for real, two shards will fight over it.
- **When you hit a flaky test, investigate it; do not just re-run until green.** Start from the failure's actual error: every `npm test` writes its full output to the log file named on the summary's `Full output:` line (`.ctrlyoke/logs/test-runs/`, newest 10 kept). If the cause is plain, fix it. If it will not reproduce, try recreating the load: run the suite (`MOCHA_GREP=… node ./out/test/runTest.js`) while `npm run test:ui` runs beside it, and compare per-test durations with an idle run. Tests that spawn real `git` measured about 6× slower that way, and a full `npm test` is heavier still, so a slow test within reach of the 30s default is a common cause (see `WorktreeManager.test.ts`). If you still cannot reproduce it, stop chasing it. Instead, add instrumentation that will capture the cause the next time it fails (assertion messages carrying the observed state, or timing around the slow step), and report what you found and what you added.

</parallelism>

<organization>

- Keep the existing split: top-level `src/test/*.test.ts` for legacy/core tests, `unit/` for focused module tests, `integration/` for extension-host behavior, `suite/harness/` for log-parser contract tests, and `harness/` for real CLI end-to-end tests.
- Prefer one test file per production module. Use Mocha TDD style (`suite`, `test`, `setup`, `teardown`) with Node `assert`; this tree generally uses hand-written fakes/test subclasses instead of Sinon.
- When testing abstract or protected behavior, expose it via a small test subclass rather than weakening production visibility.
- Do not spawn real node-pty processes to test `PtyProcessManager` lifecycle. On Windows, a real PTY killed inside the extension-host test runner never delivers `onExit` (the same kill does in plain Node), so the test hangs to the suite timeout. Subclass `PtyProcessManager`, override `loadNodePty()`, and return a fake `IPty` (see `PtyProcessManager.test.ts`).

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
