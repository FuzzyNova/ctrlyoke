---
applyTo: "src/core/harness/shared/**"
---

<purpose>
Shared CLI-harness infrastructure: provider contracts, prompt assembly, response collection, event mapping, and parallel-safe settings helpers.
</purpose>

<providerContracts>
- `ICliProvider` is the boundary between shared orchestration and harness-specific behavior. Keep shared code provider-neutral; if behavior depends on one CLI’s payload/flags, expose it through the interface instead of hard-coding it in shared helpers.
- `buildCliArgs()` prepares provider base args; prompt placement belongs in `buildHeadlessArgs()` / `buildInteractiveArgs()`. Many CLIs have ordering constraints, so do not collapse those methods back together.
- Optional provider hooks matter: `augmentParsedOutput()` enriches mapped headless metadata from provider-owned artifacts such as Copilot's OTel export, `extractSessionIdFromLogs()` is fallback recovery, `buildNotificationHookArgs()` / `buildHeadlessUserHookArgs()` own hook wiring, and cleanup methods own provider-written artifacts.
</providerContracts>

<promptAndResponseFlow>
- `CliPromptPreparer` is the single place that chooses inline prompt text vs categorized temp files. Pure slash commands bypass wrapping entirely; prompts with only direct `@file` refs stay inline when safe; resume can intentionally omit agent/skills content.
- `CliPromptPreparer` also merges property-level prior context with inline `$...` references before splitting temp files. Keep that merge logic centralized there.
- In worktree mode, source-runtime bytes may be read by `ContextExpander`, but harness-openable full-file paths must resolve inside the execution checkout. Copied refs keep their workspace-relative token because the deferred `PreparedMutation` makes it true; read-in-place excerpts use the absolute source path in attachment metadata and rewritten inline tokens because no worktree file exists.
- `CliResponseCollector` is the post-parse choke point: parse raw output, then run optional provider augmentation, then fall back to log-based session discovery. Fix missing metadata here before adding ad hoc patches elsewhere.
- Runtime persistence belongs in `CliPromptRuntimeCoordinator` / `CliExecutionSession`, not in provider classes.
</promptAndResponseFlow>

<parallelSafety>
- `SettingsJsonMcpTracker` coordinates MCP edits to shared `.{tool}/settings.json` files, while `SettingsJsonHooksTracker` owns its hook-mutation mutex. Hook mutations must run under `hooksTracker.withLock()` so hook reads and writes cannot interleave.
- These trackers preserve a baseline snapshot and ref-count per workflow. Cleanup must unregister only the current workflow; never “reset” the whole file just because one run finished.
- When ctrlyoke creates a new tool settings file, the tracker may also create a temporary `.gitignore` beside it. That behavior is intentional so provider-owned config files do not appear as untracked workspace noise.
</parallelSafety>

<eventMapping>
- Each harness maps raw CLI events exactly once through its `ILogParser`; `CliEventMapper` + `BaseToolBuilder` remain the single source of truth for semantic tool-event classification.
- `CliTransportCoordinator` owns the per-spawn stdout line accumulator and calls the pure `parseHeadlessStdout()` hook with complete records only; keep provider parsers stateless and do not reintroduce raw-chunk assumptions at their call sites.
- `ICliProvider.headlessSource` chooses the transport source by fidelity: use stdout when its machine events preserve the session-log semantics, and use the log when the session log is richer or authoritative (Codex, Antigravity, and Qwen). Log-sourced headless runs still stream through `HeadlessLogTail` before process completion; source selection is not a latency preference. Resolve the mode only via `resolveHeadlessSourceMode()` — the streaming path and the final-output path must agree, or a harness streams one mapping and reports another.
- `HeadlessLogTail` must never resolve a session ID before the process spawns, and `start()` therefore only reads when the ID is already known (a resume). Both pre-spawn sources are wrong: a stdout ID does not exist yet (and Codex's discovery helper retries for seconds, delaying the launch of the stream it tails), while a provider log lookup can only see the *previous* run — Antigravity's `last_conversations.json` is keyed by workspace root with no timestamp, so a pre-spawn hit latches a stale session for the entire run and persists the wrong resume ID. Post-spawn stdout ticks and the idle poll are what drive discovery.
- `ApplyPatchParser` exists to turn patch payloads into accurate line ranges; prefer it over parser-specific regex heuristics.
- `CliProviderUtils.buildMcpConfigBlock()` centralizes “should MCP be attached at all?” logic. Providers should only supply format-specific config generation.
</eventMapping>

<usageStaleness>
- `isHarnessQuotaStale()` (`src/types/UsageTypes.ts`) is a **whole-snapshot** check: has it been more than `staleAfterMs` since the last provider fetch/push. It does not look at any window's `resetAt`. Use `isHarnessUsageWindowStale()` wherever a specific window's percentage is displayed or compared (chips, tooltips, selection-assist triggers/fallbacks) — it layers in that window's own reset time. Do not reintroduce a cross-window `Math.min(resetAt)` into the whole-snapshot check: Claude's five-hour window resets far more often than its seven-day window, so that shape makes the seven-day figure go stale the moment the five-hour window rolls over, even though nothing about the seven-day number changed.
- Claude quota freshness is capped by how often `ClaudeStatuslineSidecar` is alive, not by a background poll: `ClaudeUsageProvider.refreshUsage()` always returns `unavailable` (Claude has no safe standalone quota probe), and `ClaudeCliProvider` tears the sidecar down at the start of every prompt's mutation prep and again on workspace cleanup (`ClaudeCliProvider.ts`, the `statusLineSidecar?.stop()` call sites). Between Claude turns — or after the last one in a run — nothing pushes a new snapshot, so the cached quota ages toward `staleAfterMs` on its own. Display code should show the last-known percentage annotated stale rather than blanking it, since "no data" and "no *recent* data" are different states for the user.
</usageStaleness>

<windowsCliLaunch>
- `CliLauncherResolver.getWindowsCommandMetadata` resolves Windows CLI shims by preferring `Application` (`.cmd`/`.bat`/`.exe`) over `ExternalScript` (`.ps1`) — keep that ordering. npm-generated `.ps1` shims pipe `$input` to node when `$MyInvocation.ExpectingInput` is set; an open stdin pipe from `execFileAsync` makes PowerShell take the `$input |` branch and hang ~30s. The `.cmd` counterpart calls node directly and avoids it. The narrow exception is a pure `.bat` proxy whose entire body forwards `%*` to one absolute PowerShell file (the VS Code Copilot launcher shape): resolve that target directly because `cmd.exe` breaks Copilot's interactive `-i` prompt delivery. Keep `parsePowerShellBatchProxyTarget` strict; never interpret general batch syntax or interpolate prompt text into a shell command. The `.ps1` fallback is only for shims that lack a usable application launcher. If you must spawn an npm-generated `.ps1` and stdin hangs are a risk, close stdin (`stdio: ['ignore', 'pipe', 'pipe']`).
</windowsCliLaunch>
