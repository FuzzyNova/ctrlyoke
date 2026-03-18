---
applyTo: "src/scripts/**"
---

<purpose>
Hook/notify scripts executed by CLI harnesses (Copilot, Claude, Codex) during agent sessions.
These are plain Node.js scripts (no TypeScript, no bundler) copied to `out/scripts/` during build.
Each CLI provider references its script via an absolute path resolved at runtime.
</purpose>

<scripts>
**`flightpath-hook-utils.js`** — Shared utilities (required by all three hook scripts)

- `isDiagnosticLogsEnabled(workspaceDir)` — checks for `.flightpath/.diagnostic-logs` flag file; hook scripts cannot read VS Code settings directly, so the extension writes this file when `flightpath.enableDiagnosticLogs` is true
- `getDebugLogPath(logsDir, scriptName)` — returns log file path, creating `logsDir` if needed
- `getTempLogPath(scriptName)` — fallback: returns path in `os.tmpdir()`
- `createLogger(logPath)` — returns a `debugLog(message, data?)` function; pass `null` for a no-op logger; errors silently swallowed
- `getLogsDirFromNotifyDir(notifyDir)` — navigates `notifyDir/../..` to reach `.flightpath/`, appends `logs/`
- `getWorkspaceRootFromNotifyDir(notifyDir)` — navigates `notifyDir/../../..` to reach workspace root

**`flightpath-copilot-hook.js`** — Copilot CLI hook handler

- Handles two events: `sessionStart`, `sessionEnd`
- Arguments: `node <script> <notifyDir> <hookType>`
- Input: JSON read from **stdin** (Copilot pipes hook payload including `sessionId`, `cwd`)
- Registered via `.github/hooks/*.json` config files (one per event):
  ```json
  { "version": 1, "hooks": { "sessionStart": [{"type": "command", "bash": "node <script> <dir> sessionStart"}] } }
  ```
- Writes notification files using the **same schema as Claude** so `NotificationMonitorBase` can share all monitoring logic:
  - `sessionStart` → `{sessionId}-start.json` with `{ hookEvent: "SessionStart", status: "started", ... }`
  - `sessionEnd`   → `{sessionId}-stop.json`  with `{ hookEvent: "Stop", status: "completed", ... }`
- Falls back to `${hookType}-${Date.now()}.json` if no session ID is present

**`flightpath-claude-hook.js`** — Claude Code CLI hook handler

- Handles two events: `SessionStart` (session discovery), `Stop` (completion signal)
- Arguments: `node <script> <notifyDir>` — hook type read from stdin payload field `hook_event_name`
- Input: JSON read from **stdin**; relevant fields: `session_id`, `hook_event_name`, `transcript_path`, `permission_mode`
- Registered via `--settings` inline JSON passed to `claude`:
  ```json
  {"hooks":{"SessionStart":[...],"Stop":[...]}}
  ```
- `SessionStart` → `{sessionId}-start.json`, `Stop` → `{sessionId}-stop.json` (session-ID-named files)
- Ignores any `hook_event_name` other than `SessionStart` or `Stop` (exits 0)

**`flightpath-codex-notify.js`** — Codex CLI completion notify handler

- Handles `agent-turn-complete` events only; ignores all other types
- Arguments: `node <script> '<notificationJson>'` — entire notification is `process.argv[2]` (not stdin)
- Notification fields: `type`, `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`
- Registered via Codex `--config notify='["node","<path>"]'`
- **Derives the notify directory from `notification.cwd`** (not a CLI argument):
  `<cwd>/.flightpath/temp/codex-notifications/`
- Writes `{threadId}.json` with `{ threadId, turnId, status: "completed", cwd, lastMessage, inputMessages }`
</scripts>

<notificationMechanism>
All three scripts use the same pattern:

1. Parse input (stdin for Copilot/Claude, argv[2] JSON string for Codex)
2. Write a JSON notification file to `.flightpath/temp/<harness>-notifications/`
3. The corresponding `*NotificationMonitor` polls that directory

**File naming:**
- Copilot/Claude: `{sessionId}-start.json` / `{sessionId}-stop.json` (shared schema, shared monitor base)
- Codex: `{threadId}.json`

**Notify directory source:**
- Copilot/Claude: passed as `argv[2]` by the CLI provider before launching the harness
- Codex: derived at runtime from `notification.cwd` (Codex provides workspace path in the payload)
</notificationMechanism>

<buildAndDeploy>
- Source: `src/scripts/*.js`
- Output: `out/scripts/*.js` (copied verbatim by esbuild config — NOT bundled or transpiled)
- Referenced by CLI providers using `path.join(context.extensionPath, "out", "scripts", "<filename>")`
- Must remain plain CommonJS — no ES modules, no TypeScript, no external `npm` dependencies
</buildAndDeploy>

<debugLogging>
Debug logging is **opt-in**: scripts check for `.flightpath/.diagnostic-logs` (written by the extension when `flightpath.enableDiagnosticLogs` is true) before enabling logging. When enabled, logs go to `<workspace>/.flightpath/logs/<script-name>-debug.log`. All log errors are silently swallowed so they never interfere with hook execution.
</debugLogging>

<guidelines>
- Keep scripts self-contained — only Node.js built-ins (`fs`, `path`, `os`, `readline`) plus `flightpath-hook-utils.js`
- Initialize `debugLog = createLogger(null)` at module level; replace with real logger only after confirming `isDiagnosticLogsEnabled()`
- `process.exit(1)` on fatal argument/parse errors; never throw unhandled exceptions
- Use `fs.writeFileSync` for atomic-enough single writes; notify monitors read complete files
- When adding a new harness hook script: arg parsing → diagnostic log init → stdin/argv read → validate → write notification file
</guidelines>
