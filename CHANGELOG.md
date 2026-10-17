# Changelog

All notable changes to ctrlyoke will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-16

This release renames many settings and workflow fields. Old keys are not migrated: they are
ignored, and unknown workflow fields now produce a warning. See **Changed** for the full list.

### Added

- **Language intelligence in the dashboard editor.** ctrlyoke can install and manage language
  servers (Settings > Language Servers, `languageServers.*`), so the workspace file editor gets
  diagnostics, hovers, go-to-definition, find references, rename and code actions, including
  multi-file edits. Symbol completions in prompts use them too, and the configured servers can
  be exported to harness configs.
- **Workflow file intelligence everywhere.** Workflow YAML/JSON files get schema-aware key, value,
  script and prompt-token completions, schema diagnostics, outline hovers and prompt lint, both in
  VS Code and in the dashboard's workspace editor. The prompt editor highlights prompt text as
  Markdown (including fenced code languages), shows `{{var}}` placeholders, and treats inline code
  as literal text.
- **Standalone dashboard server.** `ctrlyoke server` runs the hosted dashboard without VS Code,
  with prompt and symbol completions. **ctrlyoke: Start/Stop Hosted Dashboard Server** are in the
  command palette, and `server.autoStart` starts it when the extension activates.
- **Connect from anywhere (Pro).** `server.publicHostname` adds a Tailscale, dynamic-DNS or public
  address to the generated certificate and the Connect via link/QR code. A new docs page covers
  remote access. The server warns when its TLS certificate doesn't cover the LAN address, and
  Chrome on Android can download the certificate.
- **Multi-select steps.** Select several steps to reorder, recolor, delete, or edit shared prompt
  properties in bulk.
- **Reply to Step.** Right-click a finished step to continue that step's session with a follow-up
  prompt.
- **Templates:** Bug Hunt Loop, Bug Drain Loop and Feature-Driven Loop built-in templates; a
  `model` variable type that follows a harness variable; required variables; and saved default
  values per variable in the new Templates settings tab (`templates.variableDefaults`).
- **Workflow limits and guardrails.** A workflow-level `maxSteps` caps the queue (overriding
  `queue.maxSteps`), and runs stopped by a step, time or retry guardrail say which limit stopped
  them, in the dashboard, CLI and run file.
- **Prior context:** `$previous:N` for the last N outputs, run-address sources that pick an earlier
  run by workflow name and run number (`priorContext.workflow` / `run`), and a `:summary` detail
  (`$previous:summary`, `$step:summary:1,3-5`) with a matching `priorContextDetail` Full / Summary
  choice. Script verdicts are included in prior context.
- **CLI:** new `ctrlyoke status`, `ctrlyoke history steps`, `ctrlyoke history trash`,
  `ctrlyoke about` and `ctrlyoke uninstall` commands; `ctrlyoke history show` gains step selectors,
  filters and paging. Runs render tool calls,
  file edits, commands, user steers and ctrlyoke MCP calls live, matching the dashboard summary.
  `--force` applies run flags to individual steps.
- **Recently deleted.** Every history delete, including Clear all history, now moves runs to a
  per-project trash with an Undo toast; they can be restored for `storage.trashRetentionDays`
  (default 30). Clear all history moved to Settings > General > Run History behind a typed
  confirmation.
- Uninstalling ctrlyoke now removes its status line from the global settings of Claude Code,
  Copilot, Qwen Code and Antigravity, restoring any command you had before, and deletes
  `~/.ctrlyoke/bin/`. The extension does this when VS Code restarts after you uninstall it; for
  the npm CLI, run the new `ctrlyoke uninstall` before `npm uninstall -g ctrlyoke`. While another
  ctrlyoke installation is still in use, the status line is left for it.
- Every harness CLI has a supported-version window: a CLI below the minimum is reported as
  unavailable with its update command, and one below the recommended version is flagged as
  outdated in the harness picker.
- The bundled `ctrlyoke-syntax` skill teaches agents ctrlyoke's reference syntax, and agent
  frontmatter can declare `skills:`. File, range, symbol and commit references cited in a reply
  become clickable links in Output.
- Settings search; output and editor font size settings (`ui.outputFontSize`,
  `ui.editorFontSize`); `ui.wordWrap` for code views; and a theme control for the browser
  dashboard.
- Copy buttons on fenced code blocks, blockquotes and missing-harness install commands.
- Run time is shown on recent workflow rows, run rows and the run summary in one clock format,
  ticking live while running.
- Enterprise licenses show seat usage in the License tab. Codex steps show reasoning summaries and
  token counts for encrypted reasoning. Getting Started walkthrough steps have themed screenshots.
- Workflow and settings files carry a `schemaVersion`, and versioned schemas are published for
  editor validation.

### Changed

- **Renamed settings.** Update `.ctrlyoke/settings.json` by hand; the old keys are ignored:
  - `permissions.statusLineTracking` → top-level `statusLine`, with per-harness formats under
    `statusLine.byHarness.<harness-id>` (for example `claude-cli`)
  - `permissions.allowedExternalFileRoots` → `permissions.trustedExternalRoots`
  - `execution.injectMode` → `execution.reuseRunningTerminal`
  - `execution.maxPromptTimeout` → `execution.maxPromptTimeoutSec`;
    `execution.scriptTimeout` → `execution.scriptTimeoutSec`
  - `execution.strictContextResolution` → `execution.contextResolutionFailure`
  - `ctrlyokeMcpMode` → `execution.ctrlyokeMcpMode`
  - `queue.maxSize` → `queue.maxSteps`;
    `queue.maxWorkflowExecutionTime` → `queue.maxWorkflowExecutionTimeSec`
  - `coordination.maxEntryAgeDays` → `coordination.maxNoteAgeHours` (default 24)
  - `enableDiagnosticLogs` → `diagnostics.verboseLogging`;
    `ui.logRawCliOutput` → `diagnostics.logRawCliOutput`
  - `ui.hideCost` → `ui.showCostEstimates` (inverted)
  - `server.enabled` → `server.autoStart`
  - `commit.prompt` → `commit.systemPrompt`
  - The `off`/`never` values of `ui.stepColorMode`, `notifications.toastLevel` and
    `notifications.events.*` are now `none`.
  - `defaults.worktree` accepts the same `false`, shorthand and object forms as a workflow's
    `worktree`.
- **Renamed workflow fields.** All durations are now in seconds: `timeout` → `timeoutSec` (steps,
  `endCondition`, `preCondition`) and `errorBehavior.retryDelayMs` → `retryDelaySec`.
  `errorBehavior.onError: stop` is now `stopWorkflow`, and `priorContext` run sources use
  `workflow` / `run` instead of `workflowKey` / `runRef`.
- `defaults.resumeSession` now defaults to `true`, so a workflow continues its conversation like a
  chat. The built-in loop templates still set `resumeSession: false`.
- `defaults.harness` now defaults to auto-detect: the first installed harness in alphabetical
  order. Harness pickers are sorted alphabetically.
- One execution of a workflow's final step is now called a "pass" everywhere (`--step final:N`).
- `read_notes` returns only unread coordination notes, and a note expires once it is older than
  `coordination.maxNoteAgeHours` and its author has left the board.
- The hosted server token is scoped to each workspace, so regenerating it no longer breaks every
  saved phone link.
- Prior output references include commands, tool calls and results, search results, file changes,
  and other structured events, consistently across machines. Command output is tail-truncated and
  file reads include only their path and line range.
- Run timeline format v2 drops duplicate prompt and flattened response fields from output records.
  v1 runs still display, including a v1 run continued under v2.
- Copy Output copies the assistant's text; the new Copy Full Output copies the complete structured
  transcript. Script search matches use `matchField: "output"` and come from recorded stdout and
  stderr.
- A prompt sent to a running terminal shows under a "Prompt sent to running terminal:" header in
  Output.
- Inserting, moving or removing steps never rewrites step references in other prompts' text;
  the dashboard warns when an insert shifts them instead.
- The default status line ends with an "edit in ctrlyoke" hint, and its usage field is labeled
  "usage" for every harness.
- `@` file completions come from a workspace file index built in a background worker and stream
  in as you type, covering every Git-visible file instead of stopping at a walk cap.
- The extension and an npm CLI on different versions keep separate history search indexes and
  share a stable `~/.ctrlyoke/bin` status line launcher.
- `.ctrlyoke/` is only created after you opt a folder in, and settings that run programs, or add
  external workspace roots, require approval when they come from workspace settings.

### Removed

- `general.includeFullDiffsInPriorContext`, `queue.unlimitedMode` (use `-1` limits instead),
  `queue.notifyOnExtension`, and `server.standalonePort`.
- The Clear History item in the workflow dropdown (now in Settings).

### Fixed

- Secrets split across PTY output chunks or other output streams are redacted, workflow hook and
  MCP secrets are no longer granted to script steps, and an unapproved grant with no value warns
  instead of failing.
- Paused workflows stay paused across a VS Code restart, a crashed owner's in-flight step is
  settled so its run can continue, and a recorded step failure no longer also fails the next
  step.
- Script steps and condition scripts are terminated with their whole process tree on cancel or
  timeout, honor `timeoutSec` in headless runs, and report timeouts as timeouts. Exit codes
  compare numerically for `eq`/`ne`, and regex comparisons are time-limited
  (`execution.regexTimeoutSec`).
- Error retries are counted separately from end-condition retries, and retry prompts resolve their
  sources correctly.
- Hook timeouts are honored (and written in seconds for Antigravity); timed-out hook trees are
  killed on Windows; each hook gets its own environment; stale Qwen and Antigravity hook groups
  are cleaned up.
- A harness that rejects a resumed session is retried without resume; Claude subagent prompts are
  no longer recorded as user steers; Copilot, OpenCode, Claude and Codex token and context-window
  usage is reported correctly; failed OpenCode and Antigravity tool calls are surfaced.
- The hosted server authenticates WebSocket upgrades, rejects empty tokens, contains workspace
  viewer paths (including through symlinks and outside links), validates icon colors, and blocks
  saves of redacted or stale files.
- Reconnecting to the dashboard no longer duplicates a running step's output, live terminals
  replay to newly connected clients, and the terminal replay buffer survives panel reconnects.
- Undo restores overwritten files correctly and keeps per-file redo state.
- Managed worktrees land branches the agent committed itself, run setup in the configured script
  shell outside the mutation lock, and release their lease on setup errors.
- `ctrlyoke run`, `rerun` and `append` reject unknown `--harness` values, exit 3 when the harness
  executable is missing, persist `--var` overrides, resolve workflows by exact name, and shut
  down gracefully.
- Commit messages are generated for the SCM repository you clicked, with restricted permissions,
  and large staged diffs are read instead of falling back to unstaged changes.
- Many file-lock, runner-lock and credential-store fixes for Windows (delete-pending `EPERM`,
  torn writes, stale-lock recovery).
- Many dashboard fixes, including High Contrast Light preflight commands, narrow and mobile
  layouts, the minimap, modal Escape handling, and machine deactivation feedback in the License
  tab.

## [0.1.2] - 2026-09-25

### Added

- The `ctrlyoke` CLI ships inside the extension and is on `PATH` in VS Code's integrated
  terminals and in the harness processes ctrlyoke starts. For other shells and CI it is also
  published to npm as `ctrlyoke` at the same version; **ctrlyoke: Install CLI for Use Outside VS
  Code** types the install command for you.
- The CLI and the extension each record their version, and warn when an npm CLI is older than the
  installed extension.
- Shared run, lock, trust and coordination state carries a schema version. An older ctrlyoke
  refuses to write state created by a newer one instead of silently dropping fields.
- History search: `ctrlyoke history` commands on the CLI, plus regex and deep search in the
  dashboard drawer, with results streamed as they're found.
- Fuzzy-ranked file and symbol completions, with the matched characters highlighted.
- End-condition scripts compare stdout/stderr through an explicit operator.
- Prepare a run without starting it, final-step progress on workflow rows, and parallel-group
  highlighting in the prompt chip rail.

### Changed

- The `passthrough` permission mode is renamed to `none`, and `none` no longer escalates to
  bypass.
- The harness portability report is now a compatibility accordion.
- History search streams its index instead of holding it in memory.

### Fixed

- Steps wait for harness background tasks to finish, and the dashboard shows why a step is held.
- Interactive steps whose CLI exits non-zero before completing now fail instead of hanging.
- `ctrlyoke run` picks the harness from the workflow instead of defaulting to Copilot CLI.
- `--no-color` disables colored CLI output.
- Codex session logs are read from `CODEX_HOME`, and OpenCode resumes interactive prompts through
  its plugin.
- Headless output and session IDs survive stream-chunk boundaries, including multi-byte UTF-8.
- A cancelled headless run no longer leaves an orphaned harness process.
- The runner lock hands off cleanly between consecutive runs.
- MCP tools refuse operations they can't perform instead of reporting success.
- Many dashboard fixes: undo for workflow properties and step reorders, status-badge flicker,
  context-window gauge restore, and mobile layout of the dry-run dialog.

## [0.1.1] - 2026-09-17

### Changed

- Save As now creates a portable workflow bundle by copying generated attachments into a sibling
  `<workflow>.assets/` directory and inlining lone generated prompt files. The new ignore rules do
  not untrack files already committed; the only migration gap is a new screenshot added to an
  already-committed workflow that is never re-saved.
- `.ctrlyoke/settings.json` is tracked by default as project configuration. `server.certPath` and
  `server.keyPath` remain machine-local paths and should be configured separately on each machine.

## [0.1.0] - 2026-05-12

Initial release.

### Added

- Multi-harness execution: Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, and Antigravity CLI
- Parallel workflow execution with independent pause, resume, and cancel per workflow
- React dashboard with CodeMirror 6 prompt editor, live output viewer, and embedded terminal
- Script-based end conditions with retry logic, timeout protection, and template variable substitution
- Dynamic workflows via MCP tools — the AI can append steps to a running workflow at runtime
- Agent injection via `.agent.md` files and per-prompt `agent:` field
- Skills injection with per-prompt `skills:` field
- IntelliSense completions for `@file`, `#file:`, and `#sym:` references with gitignore-aware filtering
- Output history with run selector and persistent per-run snapshots
- Workflow templates: blank, simple-feature, fix-tests, and full-feature
- Multi-format workflow files: `.ctrlyoke.yaml`, `.ctrlyoke.json`, `.prompt.md` with unified JSON Schema validation
- Status bar showing real-time execution state
- Standalone CLI binary (`ctrlyoke run`, `ctrlyoke validate`)
- MCP server binary (`ctrlyoke-mcp`) for tool-based queue operations from AI assistants
- Variable substitution with `--var key=value` flag and `{{varName}}` placeholders in workflows
- Per-prompt session management with three-tier resolution (prompt > workflow > global)
- Side-by-side diff view for comparing AI-generated changes
- Stale-state recovery with atomic file locking and PID-based runner detection
