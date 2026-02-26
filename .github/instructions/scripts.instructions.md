---
applyTo: "src/scripts/**"
---

<purpose>
Hook/notify scripts executed by CLI harnesses (Copilot, Claude, Codex) during agent sessions.
These are plain Node.js scripts (no TypeScript, no bundler) copied to `out/scripts/` during build.
Each CLI provider references its script via an absolute path resolved at runtime.
</purpose>

<scripts>
**`flightpath-copilot-hook.js`** — Copilot CLI hook handler
- Handles three events: `sessionStart`, `userPromptSubmitted`, `sessionEnd`
- Hook type passed as second CLI argument: `node <script> <notifyDir> <hookType>`
- Input: JSON read from **stdin** (Copilot pipes hook payload)
- Registered via `.github/hooks/*.json` config files (one per event):
  ```json
  { "version": 1, "hooks": { "sessionEnd": [{"type": "command", "bash": "node <script> <dir> sessionEnd"}] } }
  ```
- `sessionEnd` writes a completion notification file that `CopilotNotificationMonitor` polls
- Debug log: `<workspace>/.flightpath/logs/flightpath-copilot-hook-debug.log`

**`flightpath-claude-hook.js`** — Claude Code CLI hook handler

- Handles two events: `SessionStart` (provides session ID), `Stop` (completion signal)
- Single CLI argument: `node <script> <notifyDir>` — hook type determined from stdin payload (`hook_event_name`)
- Input: JSON read from **stdin** (Claude pipes hook payload including `session_id`)
- Registered via `--settings` inline JSON passed to `claude` command:
  ```json
  {"hooks":{"SessionStart":[...],"Stop":[...]}}
  ```
- `SessionStart` extracts and writes the `session_id` for session tracking; `Stop` writes completion file
- Debug log: `<workspace>/.flightpath/logs/flightpath-claude-hook-debug.log`

**`flightpath-codex-notify.js`** — Codex CLI completion notify handler

- Handles `agent-turn-complete` events
- Notification JSON passed as **command-line argument**: `node <script> '<notificationJson>'`
- Input: single JSON string in `process.argv[2]` (not stdin) containing `thread-id`, `turn-id`, `cwd`, `last-assistant-message`
- Registered via Codex `--config notify='["node","<path>"]'`
- Writes a notification file that `CodexNotificationMonitor` polls for completion detection
- Debug log: `<workspace>/.flightpath/logs/flightpath-codex-notify-debug.log`
  </scripts>

<notificationMechanism>
All three scripts use the same pattern:

1. Parse input (stdin for Copilot/Claude, argv for Codex)
2. Write a JSON notification file to the **notify directory** (`.flightpath/temp/<harness>-notifications/`)
3. The corresponding `*NotificationMonitor` in the CLI provider polls that directory

The notify directory is created by the CLI provider before launching the harness and passed to the hook script as an argument (Copilot/Claude) or embedded in the Codex config.

**Notification file naming**: timestamp-based filename (`<timestamp>.json`) to avoid collisions across concurrent sessions.
</notificationMechanism>

<buildAndDeploy>
- Source: `src/scripts/*.js`
- Output: `out/scripts/*.js` (copied verbatim by esbuild config — NOT bundled or transpiled)
- Referenced by CLI providers using `path.join(context.extensionPath, "out", "scripts", "<filename>")`
- Must remain plain CommonJS — no ES modules, no TypeScript, no external dependencies
</buildAndDeploy>

<debugLogging>
All scripts log to `.flightpath/logs/` (derived from the notify directory argument). If the directory argument is missing or the path cannot be derived, they fall back to `os.tmpdir()`. Logging uses `fs.appendFileSync` with ISO timestamps and JSON-formatted payloads. Errors in debug logging are silently swallowed so they never interfere with hook execution.
</debugLogging>

<guidelines>
- Keep scripts self-contained — only Node.js built-ins (`fs`, `path`, `os`, `readline`)
- Always write a fallback log path so debugging works even with bad arguments
- `process.exit(1)` on fatal argument errors; never throw unhandled exceptions
- Notification files must be written atomically (write then rename, or single `writeFileSync`) to avoid partial reads by the monitor
- When adding a new harness hook script, follow the same structure: arg parsing → debug init → stdin/argv read → notification write
</guidelines>
