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
- `CliResponseCollector` is the post-parse choke point: parse raw output, then run optional provider augmentation, then fall back to log-based session discovery. Fix missing metadata here before adding ad hoc patches elsewhere.
- Runtime persistence belongs in `CliPromptRuntimeCoordinator` / `CliExecutionSession`, not in provider classes.
</promptAndResponseFlow>

<parallelSafety>
- `SettingsJsonMcpTracker` and `SettingsJsonHooksTracker` coordinate edits to shared `.{tool}/settings.json` files. Hooks mutations must run under `mcpTracker.withLock()` so MCP and hook writes cannot interleave.
- These trackers preserve a baseline snapshot and ref-count per workflow. Cleanup must unregister only the current workflow; never “reset” the whole file just because one run finished.
- When ctrlyoke creates a new tool settings file, the tracker may also create a temporary `.gitignore` beside it. That behavior is intentional so provider-owned config files do not appear as untracked workspace noise.
</parallelSafety>

<eventMapping>
- Each harness maps raw CLI events exactly once through its `ILogParser`; `CliEventMapper` + `BaseToolBuilder` remain the single source of truth for semantic tool-event classification.
- `ICliProvider.headlessSource` chooses the transport source by fidelity: use stdout when its machine events preserve the session-log semantics, and use the log when the session log is richer or authoritative (Codex, Antigravity, and Qwen). Log-sourced headless runs still stream through `HeadlessLogTail` before process completion; source selection is not a latency preference. Resolve the mode only via `resolveHeadlessSourceMode()` — the streaming path and the final-output path must agree, or a harness streams one mapping and reports another.
- `HeadlessLogTail` must never resolve a session ID before the process spawns, and `start()` therefore only reads when the ID is already known (a resume). Both pre-spawn sources are wrong: a stdout ID does not exist yet (and Codex's discovery helper retries for seconds, delaying the launch of the stream it tails), while a provider log lookup can only see the *previous* run — Antigravity's `last_conversations.json` is keyed by workspace root with no timestamp, so a pre-spawn hit latches a stale session for the entire run and persists the wrong resume ID. Post-spawn stdout ticks and the idle poll are what drive discovery.
- `ApplyPatchParser` exists to turn patch payloads into accurate line ranges; prefer it over parser-specific regex heuristics.
- `CliProviderUtils.buildMcpConfigBlock()` centralizes “should MCP be attached at all?” logic. Providers should only supply format-specific config generation.
</eventMapping>

<windowsCliLaunch>
- `CliLauncherResolver.getWindowsCommandMetadata` resolves Windows CLI shims by preferring `Application` (`.cmd`/`.bat`/`.exe`) over `ExternalScript` (`.ps1`) — keep that ordering. npm-generated `.ps1` shims pipe `$input` to node when `$MyInvocation.ExpectingInput` is set; an open stdin pipe from `execFileAsync` makes PowerShell take the `$input |` branch and hang ~30s. The `.cmd` counterpart calls node directly and avoids it. The `.ps1` fallback is only for shims that lack that pattern (e.g. VS Code's `copilot.ps1`). If you must spawn a `.ps1` and stdin hangs are a risk, close stdin (`stdio: ['ignore', 'pipe', 'pipe']`).
</windowsCliLaunch>
