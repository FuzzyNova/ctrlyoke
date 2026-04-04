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
**`flightpath-hook-utils.js`** — Shared utilities (required by all hook scripts)

- `getDebugLogPath(logsDir, scriptName)` — returns log file path, creating `logsDir` if needed
- `getTempLogPath(scriptName)` — fallback: returns path in `os.tmpdir()`
- `createLogger(logPath)` — returns a `debugLog(message, data?)` function; pass `null` for a no-op logger; errors silently swallowed
- `getLogsDirFromNotifyDir(notifyDir)` — navigates `notifyDir/../..` to reach `.flightpath/`, appends `logs/`
- `getWorkspaceRootFromNotifyDir(notifyDir)` — navigates `notifyDir/../../..` to reach workspace root
- `initializeLogger(scriptName, notifyDir)` — checks `FLIGHTPATH_DIAGNOSTIC_LOGS` env var (injected by FlightPath at spawn time); returns a configured logger when enabled, no-op logger otherwise
- `readStdinJson(scriptPrefix, debugLog, callback)` — reads all stdin as a single JSON object, handles readline setup, JSON parsing, error reporting, then invokes callback with parsed object; used by all stdin-based hooks (Copilot, Claude, Gemini, Qwen)

**`flightpath-copilot-hook.js`** — Copilot CLI hook handler

- Handles two events: `sessionStart`, `sessionEnd`
- Arguments: `node <script> <notifyDir> <hookType>`
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
- Writes notification files using the **shared schema** so `NotificationMonitorBase` can share all monitoring logic:
  - `sessionStart` → `{runId|sessionId}-start.json` with `{ hookEvent: "SessionStart", status: "started", ... }`
  - `sessionEnd` → `{sessionId}-stop.json` with `{ hookEvent: "Stop", status: "completed", ... }`
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set (for parallel-workflow collision avoidance), falls back to sessionId
- Falls back to `${hookType}-${Date.now()}.json` if no session ID is present

**`flightpath-claude-hook.js`** — Claude Code CLI hook handler

- Handles two events: `SessionStart` (session discovery), `Stop` (completion signal)
- Arguments: `node <script> <notifyDir>` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin** via `readStdinJson`; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `permission_mode`
- Registered via `--settings` inline JSON passed to `claude`:
  ```json
  {"hooks":{"SessionStart":[...],"Stop":[...]}}
  ```
- `SessionStart` → `{runId|sessionId}-start.json`, `Stop` → `{sessionId}-stop.json`
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set, falls back to sessionId
- Ignores any `hook_event_name` other than `SessionStart` or `Stop` (exits 0)

**`flightpath-codex-notify.js`** — Codex CLI completion notify handler

- Handles `agent-turn-complete` events only; ignores all other types
- Arguments: `node <script> '<notificationJson>'` — entire notification is `process.argv[2]` (not stdin)
- Notification fields: `type`, `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`
- Registered via Codex `--config notify='["node","<path>"]'`
- **Derives the notify directory from `notification.cwd`** (not a CLI argument):
  `<cwd>/.flightpath/temp/codex-notifications/`
- Writes `{threadId}.json` with `{ threadId, turnId, status: "completed", cwd, lastMessage, inputMessages }`
- Uses `FLIGHTPATH_DIAGNOSTIC_LOGS` env var for diagnostic logging (derives logs dir from `notification.cwd`)

**`flightpath-gemini-hook.js`** — Gemini CLI hook handler

- Handles two events: `SessionStart` (session discovery), `AfterAgent` (completion signal)
- Arguments: `node <script> <notifyDir>` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin** via `readStdinJson`; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `cwd`
- Registered via `.gemini/settings.json`:
  ```json
  { "hooks": { "SessionStart": [...], "AfterAgent": [...] } }
  ```
- Normalizes `AfterAgent` → `Stop` in notification data so `NotificationMonitorBase` works unchanged
- `SessionStart` → `{runId|sessionId}-start.json`, `AfterAgent` → `{sessionId}-stop.json`
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set, falls back to sessionId
- Ignores any `hook_event_name` other than `SessionStart` or `AfterAgent` (exits 0)

**`flightpath-qwen-hook.js`** — Qwen Code CLI hook handler

- Handles three events: `SessionStart`, `UserPromptSubmit` (both treated as start events), `Stop`
- Arguments: `node <script> <notifyDir>` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin** via `readStdinJson`; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `permission_mode`, `stop_hook_active`, `last_assistant_message`
- Registered via `.qwen/settings.json` (requires `--experimental-hooks`):
  ```json
  { "hooks": { "SessionStart": [...], "Stop": [...] } }
  ```
- `SessionStart`/`UserPromptSubmit` → `{runId|sessionId}-start.json`, `Stop` → `{sessionId}-stop.json`
- Start file uses `FLIGHTPATH_RUN_ID` env var as prefix when set, falls back to sessionId
- Has unconditional invocation logging (writes to log before any diagnostic flag checks for troubleshooting)
- Ignores any `hook_event_name` other than `SessionStart`, `UserPromptSubmit`, or `Stop` (exits 0)

**`flightpath-opencode-plugin.ts`** — OpenCode completion plugin (TypeScript/ESM)

- **Not a hook script** — an OpenCode plugin (`export const FlightPathHook`) deployed to `.opencode/plugin/flightpath-completion-hook.ts`
- OpenCode only loads `.ts` plugins; this file uses ESM `import`/`export` syntax (not CommonJS)
- Uses env vars (not CLI args): `FLIGHTPATH_NOTIFY_DIR` (notification directory), `FLIGHTPATH_RUN_ID` (per-run UUID)
- Filters child sessions (`parentID`) to avoid subagent false positives (only on `session.created`)
- Listens for two event types via the plugin `event` callback:
  - `session.created` (no parentID) → writes `{runId|sessionId}-start.json` with `{ hookEvent: "SessionStart", status: "started" }` ⚠️ known OpenCode bug #14808 — may not fire
  - `session.idle` → writes `{sessionId}-stop.json` with `{ hookEvent: "Stop", status: "completed" }` (no session tracking Set needed)
- Self-contained diagnostic logging (derives logs dir from `FLIGHTPATH_NOTIFY_DIR`, does not use `initializeLogger`)
- **Deployment**: `OpenCodeCliProvider.deployCompletionPlugin()` reads `out/scripts/flightpath-opencode-plugin.ts` and copies it verbatim to `.opencode/plugin/flightpath-completion-hook.ts` when no user hooks are configured. When user hooks are present, `OpenCodePluginGenerator.generate(userHooks)` produces a customized plugin string with hook commands embedded (supports `stop`→`session.idle`, `sessionStart`→`session.created`, `preToolUse`→`tool.execute.before`, `postToolUse`→`tool.execute.after`)
  </scripts>

<notificationMechanism>
All scripts write JSON notification files that FlightPath's `*NotificationMonitor` polls for:

1. Parse input (stdin for Copilot/Claude/Gemini/Qwen, argv[2] JSON string for Codex, env vars + plugin API for OpenCode)
2. Write a JSON notification file to `.flightpath/temp/<harness>-notifications/`
3. The corresponding `*NotificationMonitor` polls that directory

**File naming (shared convention across stdin-based hooks):**

- Start events: `{runId|sessionId}-start.json` — uses `FLIGHTPATH_RUN_ID` env var when set (prevents parallel-workflow collision), falls back to sessionId
- Stop events: `{sessionId}-stop.json`
- Codex (unique): `{threadId}.json` (single file, completion only)
- Copilot fallback: `${hookType}-${Date.now()}.json` when no session ID available
- OpenCode stop: `session.idle` event (no session tracking needed, unlike the older JS version)

**Notify directory source:**

- Copilot: passed as `argv[2]` by the CLI provider
- Claude/Gemini/Qwen: passed as `argv[2]` by the CLI provider
- Codex: derived at runtime from `notification.cwd` (Codex provides workspace path in the payload)
- OpenCode: passed via `FLIGHTPATH_NOTIFY_DIR` environment variable

**Cross-cutting: `FLIGHTPATH_RUN_ID`:**
All scripts (except Codex) use the `FLIGHTPATH_RUN_ID` env var — a per-prompt UUID injected by FlightPath at spawn time — as the start file name prefix. This allows `waitForSessionStart` to do a direct file lookup instead of a wildcard scan, preventing races when multiple workflows run in parallel.
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
- Deployed at runtime by `OpenCodeCliProvider.deployCompletionPlugin()` to `.opencode/plugin/flightpath-completion-hook.ts`
- When user hooks are configured, `OpenCodePluginGenerator.generate(userHooks)` produces a customized plugin string instead of using the static file
- Note: `src/scripts/flightpath-opencode-plugin.js` still exists in the repo as a legacy artifact but is no longer deployed
</buildAndDeploy>

<debugLogging>
Debug logging is **opt-in**: scripts check the `FLIGHTPATH_DIAGNOSTIC_LOGS` environment variable (set to `"true"` by the extension when `flightpath.enableDiagnosticLogs` is enabled and injected into the CLI process env at spawn time). When enabled, logs go to `<workspace>/.flightpath/logs/<script-name>-debug.log`. All log errors are silently swallowed so they never interfere with hook execution.

- Stdin-based hooks (Copilot, Claude, Gemini, Qwen) use `initializeLogger()` from utils
- Codex derives the logs directory from `notification.cwd`
- OpenCode derives the logs directory from `FLIGHTPATH_NOTIFY_DIR`; logging is gated on `notifyDir` being set
- Qwen additionally writes an unconditional invocation log entry before any flag checks (for troubleshooting hook registration)
  </debugLogging>

<guidelines>
- Keep JS hook scripts self-contained — only Node.js built-ins (`fs`, `path`, `os`, `readline`) plus `flightpath-hook-utils.js`
- Initialize `debugLog = createLogger(null)` at module level; replace with real logger via `initializeLogger()` or after checking `FLIGHTPATH_DIAGNOSTIC_LOGS` env var
- Prefer `initializeLogger()` + `readStdinJson()` from utils for new stdin-based hooks to avoid boilerplate
- `process.exit(1)` on fatal argument/parse errors; never throw unhandled exceptions
- Use `fs.writeFileSync` for atomic-enough single writes; notify monitors read complete files
- When adding a new harness hook script: arg parsing → diagnostic log init → stdin/argv read → validate → write notification file
</guidelines>
