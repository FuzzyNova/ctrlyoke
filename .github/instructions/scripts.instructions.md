---
applyTo: "src/scripts/**"
---

<purpose>
Hook/notify scripts executed by CLI harnesses (Copilot, Claude, Codex, Gemini, Qwen, OpenCode) during agent sessions.
All files in `src/scripts/` are copied verbatim to `out/scripts/` during build (no bundling or transpilation).
Each CLI provider references its script via an absolute path resolved at runtime.

Most scripts are plain CommonJS Node.js (`.js`). The **OpenCode plugin is the exception** — it is TypeScript/ESM (`.ts`) because OpenCode only loads `.ts` plugin files.
</purpose>

<scripts>
**`flightpath-hook-utils.js`** — Shared utilities (required by all stdin-based hook scripts)

- `getDebugLogPath(logsDir, scriptName)` — returns log file path, creating `logsDir` if needed
- `getTempLogPath(scriptName)` — fallback: returns path in `os.tmpdir()`
- `createLogger(logPath)` — returns a `debugLog(message, data?)` function; pass `null` for a no-op logger; errors silently swallowed
- `getLogsDirFromNotifyDir(notifyDir)` — navigates `notifyDir/../..` to reach `.flightpath/`, appends `logs/`
- `getWorkspaceRootFromNotifyDir(notifyDir)` — navigates `notifyDir/../../..` to reach workspace root
- `initializeLogger(scriptName, notifyDir)` — checks `FLIGHTPATH_DIAGNOSTIC_LOGS` env var (injected by FlightPath at spawn time); returns a configured logger when enabled, no-op logger otherwise
- `readStdinJson(scriptPrefix, debugLog, callback)` — reads all stdin as a single JSON object, handles readline setup, JSON parsing, error reporting, then invokes callback with parsed object; used by all stdin-based hooks (Copilot, Claude, Codex, Gemini, Qwen)
- `runDecisionHook(command, payloadJson, debugLog)` — runs a permission-decision hook, forwards child stdout back to the harness, and returns the child exit code
- `buildArtifactBase()` / `isHookEventEnabled()` — derive per-run hook artifact metadata from `FLIGHTPATH_*` env vars and filter logical events against `FLIGHTPATH_NOTIFY_HOOK_EVENTS`
- `writeHookArtifact()` / `maybeWriteHookArtifact()` — write `{runId}-hook-*.json` artifact files consumed by `HookEventMonitor` for browser/host hook notifications

**`flightpath-copilot-hook.js`** — Copilot CLI hook handler

- Handles six native events: `sessionStart`, `agentStop`, `preToolUse`, `postToolUse`, `userPromptSubmitted`, `permissionRequest`
- Arguments: `node <script> <notifyDir> <hookType> [encodedDecisionHook]`
- Input: JSON read from **stdin** via `readStdinJson` (Copilot pipes hook payload including `sessionId`, `cwd`)
- Registered via `.github/hooks/*.json` config files (one per event):
  ```json
  {
    "version": 1,
    "hooks": {
      "sessionStart": [
        { "type": "command", "bash": "node <script> <dir> sessionStart" }
      ]
    }
  }
  ```
- `sessionStart` / `agentStop` write notification files using the **shared schema** so `NotificationMonitorBase` can share all monitoring logic:
  - `sessionStart` → `{runId|sessionId}-start.json` with `{ hookEvent: "SessionStart", status: "started", ... }`
  - `agentStop` → `{sessionId}-stop.json` with `{ hookEvent: "Stop", status: "completed", ... }`
- `preToolUse`, `postToolUse`, `userPromptSubmitted`, and `permissionRequest` do not write start/stop files; they optionally emit `{runId}-hook-*.json` artifacts via `maybeWriteHookArtifact()` when `FLIGHTPATH_NOTIFY_HOOK_EVENTS` enables those logical events
- `permissionRequest` optionally decodes the base64 command passed on argv[4] and proxies the decision via `runDecisionHook()`; without a decision hook it exits 0
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set (for parallel-workflow collision avoidance), falls back to sessionId
- Falls back to `${hookType}-${Date.now()}.json` if no session ID is present

**`flightpath-claude-hook.js`** — Claude Code CLI hook handler

- Handles six events: `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PermissionRequest`
- Arguments: `node <script> <notifyDir> [encodedDecisionHook]` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin** via `readStdinJson`; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `permission_mode`
- Registered via `--settings` inline JSON passed to `claude`:
  ```json
  {"hooks":{"SessionStart":[...],"Stop":[...]}}
  ```
- `SessionStart` / `Stop` write `{runId|sessionId}-start.json` and `{sessionId}-stop.json`
- `PreToolUse`, `PostToolUse`, and `UserPromptSubmit` are artifact-only events: they emit optional `{runId}-hook-*.json` files but skip notification-file I/O
- `PermissionRequest` optionally runs a base64-decoded decision hook from argv[3] via `runDecisionHook()`; otherwise it exits 0 without stdout
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set, falls back to sessionId
- Ignores any unhandled `hook_event_name` (exits 0)

**`flightpath-codex-notify.js`** — Codex CLI hook handler

- Handles six events: `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PermissionRequest`
- Arguments: `node <script> <notifyDir> [encodedDecisionHook]` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin** via `readStdinJson`; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `cwd`, `permission_mode`, `stop_hook_active`, `last_assistant_message`, `source`
- Registered via `.codex/hooks.json` (requires `--enable codex_hooks`):
  ```json
  { "hooks": { "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node <script> <notifyDir>" }] }], "Stop": [...] } }
  ```
- `SessionStart` / `Stop` write `{runId|sessionId}-start.json` and `{sessionId}-stop.json`
- `PreToolUse`, `PostToolUse`, and `UserPromptSubmit` are artifact-only events: they emit optional `{runId}-hook-*.json` files but skip notification-file I/O
- `PermissionRequest` optionally runs a base64-decoded decision hook from argv[3] via `runDecisionHook()`; otherwise it exits 0 without stdout
- Has unconditional invocation logging (writes to log before any diagnostic flag checks for troubleshooting)
- Ignores any unhandled `hook_event_name` (exits 0)

**`flightpath-gemini-hook.js`** — Gemini CLI hook handler

- Handles five events: `SessionStart`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`
- Arguments: `node <script> <notifyDir> [encodedDecisionHook]` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin** via `readStdinJson`; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `cwd`
- Registered via `.gemini/settings.json`:
  ```json
  { "hooks": { "SessionStart": [...], "AfterAgent": [...] } }
  ```
- Normalizes `AfterAgent` → `Stop` in notification data so `NotificationMonitorBase` works unchanged
- `SessionStart` / `AfterAgent` write `{runId|sessionId}-start.json` and `{sessionId}-stop.json`
- `BeforeTool` and `AfterTool` are artifact-only events: they emit optional `{runId}-hook-*.json` files but skip notification-file I/O
- `Notification` is only meaningful when `notification_type === "ToolPermission"`; those events map to logical `permissionRequest` and may run a base64-decoded decision hook from argv[3] via `runDecisionHook()`
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set, falls back to sessionId
- Ignores non-permission notifications and any other unhandled `hook_event_name` (exits 0)

**`flightpath-qwen-hook.js`** — Qwen Code CLI hook handler

- Handles six events: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `PermissionRequest`
- Arguments: `node <script> <notifyDir> [encodedDecisionHook]` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin** via `readStdinJson`; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `permission_mode`, `stop_hook_active`, `last_assistant_message`
- Registered via `.qwen/settings.json` (requires `--experimental-hooks`):
  ```json
  { "hooks": { "SessionStart": [...], "Stop": [...] } }
  ```
- `SessionStart` / `UserPromptSubmit` write `{runId|sessionId}-start.json`; `Stop` writes `{sessionId}-stop.json`
- `PreToolUse` and `PostToolUse` are artifact-only events: they emit optional `{runId}-hook-*.json` files but skip notification-file I/O
- `PermissionRequest` optionally runs a base64-decoded decision hook from argv[3] via `runDecisionHook()`; otherwise it exits 0 without stdout
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set, falls back to sessionId
- Has unconditional invocation logging (writes to log before any diagnostic flag checks for troubleshooting)
- Ignores any unhandled `hook_event_name` (exits 0)

**`flightpath-opencode-plugin.ts`** — OpenCode completion plugin (TypeScript/ESM)

- **Not a hook script** — an OpenCode plugin (`export const FlightPathHook`) deployed to `.opencode/plugin/flightpath-completion-hook.ts`
- OpenCode only loads `.ts` plugins; this file uses ESM `import`/`export` syntax (not CommonJS)
- Uses env vars (not CLI args): `FLIGHTPATH_NOTIFY_DIR` (notification directory), `FLIGHTPATH_RUN_ID` (per-run UUID), `FLIGHTPATH_WORKSPACE_ROOT` (workspace root for headless mode)
- Tracks **child sessions** (`childSessions` Set) to invert completion detection — stop events fire for any session NOT in `childSessions` (avoids subagent false positives even when `session.created` is missed)
- Three Sets: `childSessions`, `mainSessions`, `startFilesWritten`
- Event handlers:
  - `session.created` with `parentID` → adds to `childSessions`; without `parentID` → adds to `mainSessions`, calls `_writeStartFile()`, fires `sessionStart` user hooks
  - `session.updated` — fallback for main session when `session.created` was missed (OpenCode bug #14808); adds to `mainSessions` and calls `_writeStartFile()` (no duplicate hook fire)
  - `session.deleted` → removes from both Sets
  - `session.status busy` (non-child) → fires `userPromptSubmit` user hooks
  - `session.status idle` (non-child) → writes `{sessionId}-stop.json`, fires `stop` user hooks
- `tool.execute.before` / `tool.execute.after` — OpenCode trigger hooks returned as top-level keys on the plugin object (NOT inside the `event` callback); fire `preToolUse` / `postToolUse` user hooks
- User hooks loaded at startup from sidecar file `{workspaceRoot}/.opencode/plugin/flightpath-hooks.json` (format: `[{ event, command }]`); executed via `execSync`
- Self-contained diagnostic logging (derives logs dir from `FLIGHTPATH_NOTIFY_DIR`, falls back to `FLIGHTPATH_WORKSPACE_ROOT`; does not use `initializeLogger`)
- **Deployment**: `OpenCodeCliProvider.deployCompletionPlugin()` always copies the static `out/scripts/flightpath-opencode-plugin.ts` verbatim to `.opencode/plugin/flightpath-completion-hook.ts`, then writes/removes `flightpath-hooks.json` alongside it based on configured user hooks
  </scripts>

<notificationMechanism>
The scripts write two kinds of JSON files into the notify directory:

1. **Start/stop notification files** consumed by each harness `*NotificationMonitor`
2. **Hook artifact files** (`{runId}-hook-*.json`) consumed by `HookEventMonitor` for browser/host notifications

Common flow:

1. Parse input (stdin for Copilot/Claude/Codex/Gemini/Qwen, env vars + plugin API for OpenCode)
2. Optionally write a start/stop notification file to `.flightpath/temp/<harness>-notifications/`
3. Optionally write a `{runId}-hook-*.json` artifact when `FLIGHTPATH_NOTIFY_HOOK_EVENTS` enables the logical event
4. The corresponding monitor polls that directory

**File naming (shared convention across stdin-based hooks):**

- Start events: `{runId|sessionId}-start.json` — uses `FLIGHTPATH_RUN_ID` env var when set (prevents parallel-workflow collision), falls back to sessionId
- Stop events: `{sessionId}-stop.json`
- Hook artifacts: `{runId}-hook-{timestamp}-{pid}.json`
- Copilot fallback: `${hookType}-${Date.now()}.json` when no session ID available
- OpenCode stop: written on `session.status idle` for any non-child session (using inverted childSessions tracking)

**Notify directory source:**

- Copilot: passed as `argv[2]` by the CLI provider
- Claude/Codex/Gemini/Qwen: passed as `argv[2]` by the CLI provider
- OpenCode: passed via `FLIGHTPATH_NOTIFY_DIR` environment variable

**Cross-cutting: `FLIGHTPATH_RUN_ID`:**
All scripts (except OpenCode plugin which uses it via env var directly) use the `FLIGHTPATH_RUN_ID` env var — a per-prompt UUID injected by FlightPath at spawn time — as the start file name prefix. This allows `waitForSessionStart` to do a direct file lookup instead of a wildcard scan, preventing races when multiple workflows run in parallel.
</notificationMechanism>

<buildAndDeploy>
**Plain JS hook scripts** (Copilot, Claude, Codex, Gemini, Qwen):
- Source: `src/scripts/*.js`
- Output: `out/scripts/*.js` (copied verbatim by the `copy-scripts` esbuild plugin — NOT bundled or transpiled)
- Referenced by CLI providers using `path.join(context.extensionPath, "out", "scripts", "<filename>")`
- Must remain plain CommonJS — no ES modules, no TypeScript, no external `npm` dependencies

**OpenCode plugin** (`flightpath-opencode-plugin.ts`):

- Source: `src/scripts/flightpath-opencode-plugin.ts` (TypeScript/ESM — must stay this way; OpenCode only loads `.ts` plugins)
- Output: `out/scripts/flightpath-opencode-plugin.ts` (also copied verbatim by the same esbuild plugin)
- Deployed at runtime by `OpenCodeCliProvider.deployCompletionPlugin()` to `.opencode/plugin/flightpath-completion-hook.ts`; always uses the static file — no code generation
- User hooks are passed via a `flightpath-hooks.json` sidecar file written alongside the plugin (not embedded in the plugin source)
  </buildAndDeploy>

<debugLogging>
Debug logging is **opt-in**: scripts check the `FLIGHTPATH_DIAGNOSTIC_LOGS` environment variable (set to `"true"` by the extension when `flightpath.enableDiagnosticLogs` is enabled and injected into the CLI process env at spawn time). When enabled, logs go to `<workspace>/.flightpath/logs/<script-name>-debug.log`. All log errors are silently swallowed so they never interfere with hook execution.

- Stdin-based hooks (Copilot, Claude, Gemini, Qwen) use `initializeLogger()` from utils
- Codex uses `initializeLogger()` from utils; also derives the logs directory from `argv[2]` notifyDir for the unconditional invocation log
- OpenCode derives the logs directory from `FLIGHTPATH_NOTIFY_DIR`; falls back to `FLIGHTPATH_WORKSPACE_ROOT`; logging is gated on `FLIGHTPATH_DIAGNOSTIC_LOGS=true`
- Qwen and Codex additionally write an unconditional invocation log entry before any flag checks (for troubleshooting hook registration)
  </debugLogging>

<guidelines>
- Keep JS hook scripts self-contained — only Node.js built-ins (`fs`, `path`, `os`, `readline`) plus `flightpath-hook-utils.js`
- Initialize `debugLog = createLogger(null)` at module level; replace with real logger via `initializeLogger()` or after checking `FLIGHTPATH_DIAGNOSTIC_LOGS` env var
- Prefer `initializeLogger()` + `readStdinJson()` from utils for new stdin-based hooks to avoid boilerplate
- `process.exit(1)` on fatal argument/parse errors; never throw unhandled exceptions
- Use `fs.writeFileSync` for atomic-enough single writes; notify monitors read complete files
- When adding a new harness hook script: arg parsing → diagnostic log init → stdin/argv read → validate → optionally emit start/stop notifications, hook artifacts, and permission-decision stdout
</guidelines>
