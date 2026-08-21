---
applyTo: "src/scripts/**"
---

<purpose>
Runtime hook scripts used by CLI harnesses for session start/stop detection, tool-event notifications, and user hook delegation.
</purpose>

<buildAndDeployment>
- `src/scripts/*` is copied verbatim to `out/scripts/*` by the `copy-scripts` esbuild plugin. Do not add imports that require bundling, path rewriting, or transpilation, except for the deliberate statusline-wrapper boundary: `src/scripts/ctrlyoke-statusline-wrapper.js` requires the sibling `out/scripts/ctrlyoke-statusline-format.js`, which `esbuild.js` separately bundles from `src/utils/StatuslineFormat.ts`. This keeps the detached CommonJS process and the extension/webview on one formatter implementation while preserving the wrapper's standalone deployment shape.
- All stdin-based hooks stay plain CommonJS and depend only on Node built-ins plus `ctrlyoke-hook-utils.js`.
- `ctrlyoke-opencode-plugin.ts` is the exception: it must remain TypeScript + ESM and is loaded from the extension installation through OpenCode's inline `plugin[]` config. A provider-owned `.opencode/plugin/` copy is only a warning-backed compatibility fallback.
</buildAndDeployment>

<notificationFlow>
- There are two outputs: start/stop files for each harness notification monitor, and optional `{runId}-hook-*.json` artifacts for `HookEventMonitor`.
- `CTRLYOKE_RUN_ID` is the important anti-race contract: start files use `{runId}-start.json` when available so parallel workflows can do direct lookups instead of wildcard scans.
- Hook artifacts are opt-in. `CliExecutionRunner` sets `CTRLYOKE_NOTIFY_HOOK_EVENTS` plus workflow/prompt metadata env vars, and `ctrlyoke-hook-utils.js` turns those into artifact payloads consumed by `CompletionNotificationFactory`.
- Keep the shared start/stop schema aligned across harnesses (`hookEvent`, `sessionId`, `status`, `timestamp`) so `NotificationMonitorBase` subclasses can reuse the same polling logic.
</notificationFlow>

<harnessSpecificGotchas>
- Copilot is the odd one out: providers create per-prompt `.github/hooks/*.json` files and Copilot auto-discovers them. Headless mode may still need those repo hooks when user hooks or hook notifications are enabled (`GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS`).
- Claude writes a temp settings file and passes it through `--settings`; Codex/Qwen merge hooks into their settings/trust machinery instead of using temp script-generated config.
- Qwen treats `UserPromptSubmit` as a second start signal; its provider registers `userPromptSubmit` alongside `sessionStart`/`stop`.
- Codex and Qwen intentionally write an unconditional invocation log entry before diagnostic flag checks so hook-registration failures can be distinguished from logging/config issues.
- OpenCode is plugin-driven, not stdin-driven. Keep `permission.asked`, `tool.execute.before`, and `tool.execute.after` as top-level returned handlers; they do not come through the generic `event` callback.
- OpenCode completion detection intentionally tracks child sessions and treats any non-child `session.status idle` as the main stop signal because the main `session.created` event can be missed (`session.updated` is the fallback).
</harnessSpecificGotchas>

<debugLogging>
- Normal debug logging is opt-in via `CTRLYOKE_DIAGNOSTIC_LOGS=true`; `initializeLogger()` must stay best-effort and never break hook execution.
- Codex and Qwen also write a minimal unconditional invocation entry before diagnostics are checked.
- OpenCode keeps its own logger because it runs as a plugin, not a spawned stdin script.
</debugLogging>

<guidelines>
- Prefer extending `ctrlyoke-hook-utils.js` rather than re-implementing stdin parsing, decision-hook forwarding, artifact writing, or logger setup in each script.
- These scripts are integration glue, not business-logic hosts: keep them tiny, synchronous, and tolerant of malformed input. Fatal argument/parse errors should `console.error(...)` + `process.exit(1)`, not throw.
- Preserve the current write pattern (`fs.writeFileSync`) for notification/artifact files; monitors poll for complete files and then delete them.
- When adding a new harness, decide first whether it follows the stdin-hook model or the OpenCode-style plugin model; the deployment/wiring contract lives in the corresponding `*CliProvider`, not inside the script.
</guidelines>
