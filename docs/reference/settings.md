---
description: "Every setting in .ctrlyoke/settings.json, generated from schemas/settings-schema.json."
editLink: false
---

<!-- AUTO-GENERATED from the JSON schemas — edit the schema descriptions or docs/reference/_partials/, then run `npm run generate-schema-docs` -->

# Settings reference

ctrlyoke reads its settings from two `settings.json` files. Both use the
same shape:

- **User scope:** `~/.ctrlyoke/settings.json`. Applies to every workspace.
- **Workspace scope:** `.ctrlyoke/settings.json` in the workspace. Applies
  only to that workspace and overrides user values.

Objects merge key by key across the two files. An array or a single value in
the workspace file replaces the user value entirely. The one exception is
[`permissions.trustedExternalRoots`](#external-file-roots): ctrlyoke
combines the roots from both files. When you run the `ctrlyoke` CLI, the
flags you pass override both files for that run.

Some settings are machine-specific and are read only from user scope:
`worktrees`, `storage`, `statusLine`, and
`usageTracking.enabled`. ctrlyoke ignores these settings in a workspace file.

The dashboard's Settings page edits these files for you. If you edit a file by
hand in VS Code, ctrlyoke checks every `.ctrlyoke/settings.json` against its
settings schema, so completion and error checking work as you type. Don't
add a `$schema` key in VS Code: a `$schema` URL replaces the extension's
bundled schema, so VS Code downloads the published copy instead, which fails
offline and needs `ctrlyoke.dev` in `json.schemaDownload.trustedDomains`. In
other editors, set `$schema` to
`https://ctrlyoke.dev/schema/v1/settings.json`. Every key is optional, and a
key you leave out keeps the default shown below.

```json
{
  "defaults": {
    "harness": "claude-cli",
    "models": { "claude-cli": "sonnet" },
    "executionMode": "headless"
  },
  "execution": { "scriptTimeout": 120 },
  "queue": { "maxParallelSteps": 4 }
}
```

Settings under [`defaults`](#defaults) set the starting values for workflow
fields. A workflow or step that sets the same field overrides them. See the
[workflow schema reference](/reference/workflow-schema) for the workflow
fields.

| Section | Purpose |
| --- | --- |
| [`general`](#general) | General format, template, and behavior settings. |
| [`defaults`](#defaults) | Default execution properties applied to all new workflows (mirrors ExecutionProperties). |
| [`worktrees`](#worktrees) | User-only worktree checkout placement configuration. |
| [`coordination`](#coordination) | Retention and participant settings for the execution-root coordination board. |
| [`storage`](#storage) | User-only storage location configuration. |
| [`permissions`](#permissions) | Harness-specific path and sandbox permission settings. |
| [`usageTracking`](#usagetracking) | Controls workspace-local provider quota and observed-usage collection. |
| [`execution`](#execution) | Execution settings. |
| [`queue`](#queue) | Queue management settings. |
| [`runs`](#runs) | Execution run retention settings. |
| [`terminal`](#terminal) | Embedded terminal settings. |
| [`ui`](#ui) | UI display settings. |
| [`server`](#server) | ctrlyoke hosted server settings. |
| [`notifications`](#notifications) | Notification settings. |
| [`commit`](#commit) | Commit message generation settings. |
| [`statusLine`](#statusline) | Machine-only settings for providers that install a global statusline command. |
| [`diagnostics`](#diagnostics) | Logging and diagnostic output settings. |
| [Top-level settings](#top-level) | Settings that sit directly at the root of settings.json. |
| [Shared types](#shared-types) | Value shapes referenced by more than one setting. |

## `general` {#general}

General format, template, and behavior settings.

### `general.defaultFormat` {#general-defaultformat}

- **Type:** `"yaml" | "json"`
- **Default:** `"yaml"`

Default file format for new workflows.

### `general.defaultTemplate` {#general-defaulttemplate}

- **Type:** `string`
- **Default:** `"blank"`

Default template to use for new workflows.

### `general.autoLoadRecentSession` {#general-autoloadrecentsession}

- **Type:** `boolean`
- **Default:** `true`

Automatically load the most recent session on startup.

### `general.omitPreviouslyAttachedAgentsSkillsOnResume` {#general-omitpreviouslyattachedagentsskillsonresume}

- **Type:** `boolean`
- **Default:** `true`

When resuming an existing session, omit only agent/skill declarations that were already attached earlier in that same session.

### `general.includeFullDiffsInPriorContext` {#general-includefulldiffsinpriorcontext}

- **Type:** `boolean`
- **Default:** `true`

Include full file diffs in captured AI responses so later prior-context attachments contain the actual changes instead of edit summaries.

## `defaults` {#defaults}

Default execution properties applied to all new workflows (mirrors ExecutionProperties).

### `defaults.harness` {#defaults-harness}

- **Type:** `"copilot-cli" | "claude-cli" | "codex-cli" | "opencode-cli" | "qwen-cli" | "antigravity-cli"`
- **Default:** `"copilot-cli"`
- **Workflow field:** [`harness`](/reference/workflow-schema#execution-properties-harness) — a workflow or step value overrides this default

The default harness to use for new workflows.

### `defaults.models` {#defaults-models}

- **Type:** `{ copilot-cli?, claude-cli?, codex-cli?, … }`

The default model to use for each harness for new workflows.

<details><summary>Default value</summary>

```json
{
  "copilot-cli": "claude-sonnet-4.6",
  "claude-cli": "sonnet",
  "codex-cli": "gpt-5.5",
  "opencode-cli": "opencode/big-pickle",
  "qwen-cli": "qwen3.5-plus",
  "antigravity-cli": "gemini-3.6-flash-medium"
}
```

</details>

Fields:

- `copilot-cli` · `string`
- `claude-cli` · `string`
- `codex-cli` · `string`
- `opencode-cli` · `string`
- `qwen-cli` · `string`
- `antigravity-cli` · `string`

### `defaults.additionalArgs` {#defaults-additionalargs}

- **Type:** `{ copilot-cli?, claude-cli?, codex-cli?, … }`
- **Default:** `{}`
- **Workflow field:** [`additionalArgs`](/reference/workflow-schema#execution-properties-additionalargs) — a workflow or step value overrides this default

The default additional CLI arguments for each harness for new workflows.

Fields:

- `copilot-cli` · `string`
- `claude-cli` · `string`
- `codex-cli` · `string`
- `opencode-cli` · `string`
- `qwen-cli` · `string`
- `antigravity-cli` · `string`

### `defaults.agent` {#defaults-agent}

- **Type:** `string` or `""` or `null`
- **Default:** `""`
- **Workflow field:** [`agent`](/reference/workflow-schema#execution-properties-agent) — a workflow or step value overrides this default

Default portable ctrlyoke workflow agent attachment for new workflows. Native harness agent discovery is managed separately by the Agents & Skills settings page.

Accepted forms:

- `string` matching `^[a-zA-Z0-9-_]+$`
- `""` — Empty string means no agent — the form the dashboard's "None" selection serializes to. Distinct from null, which explicitly disables an inherited agent.
- `null`

### `defaults.skills` {#defaults-skills}

- **Type:** `string[]` or `null`
- **Default:** `[]`
- **Workflow field:** [`skills`](/reference/workflow-schema#execution-properties-skills) — a workflow or step value overrides this default

Default portable ctrlyoke workflow skill attachments for new workflows. Native harness skill discovery is managed separately by the Agents & Skills settings page and does not determine workflow skill support.

### `defaults.secrets` {#defaults-secrets}

- **Type:** `string[]` or `null`
- **Default:** `[]`
- **Workflow field:** [`secrets`](/reference/workflow-schema#execution-properties-secrets) — a workflow or step value overrides this default

Default secret environment-variable names granted to new workflows. Values are resolved by the execution host and never stored in workflow definitions.

### `defaults.executionMode` {#defaults-executionmode}

- **Type:** `"interactive" | "headless"`
- **Default:** `"interactive"`
- **Workflow field:** [`executionMode`](/reference/workflow-schema#execution-properties-executionmode) — a workflow or step value overrides this default

Default execution mode for new workflows. 'interactive' spawns a live terminal (TUI) the user can steer; 'headless' runs in the background with output in the Output panel. Workflows and individual steps can override this.

### `defaults.resumeSession` {#defaults-resumesession}

- **Type:** `boolean`
- **Default:** `false`
- **Workflow field:** [`resumeSession`](/reference/workflow-schema#execution-properties-resumesession) — a workflow or step value overrides this default

Resume an existing session when running a workflow.

### `defaults.priorContext` {#defaults-priorcontext}

- **Type:** `"all" | "previous" | "none" | "finalStepAll" | "finalStepPrevious"` or `integer[]`
- **Default:** `"none"`
- **Workflow field:** [`priorContext`](/reference/workflow-schema#execution-properties-priorcontext) — a workflow or step value overrides this default

Default priorContext for every step that doesn't set its own.

### `defaults.mcpServers` {#defaults-mcpservers}

- **Type:** array of (`string` or `{ id, description?, command?, … }`)
- **Default:** `[]`
- **Workflow field:** [`mcpServers`](/reference/workflow-schema#execution-properties-mcpservers) — a workflow or step value overrides this default

Default MCP servers to attach to each prompt execution.

Fields:

- `id` · `string` · required — Unique server identifier
- `description` · `string` — Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.
- `command` · `string` — Command to run the MCP server process (stdio servers, e.g. "npx" or "node")
- `args` · `string[]` — Arguments to pass to the command (stdio servers only)
- `env` · map of `string` — Environment variables for the server process (stdio servers only)
- `autoApprove` · `boolean` or `string[]` — Tools to auto-approve: true = all tools, string[] = specific tools
- `url` · `string` — Remote endpoint URL for streamable-http or SSE servers (e.g. "https://mcp.example.com")
- `transport` · `"streamable-http" | "sse"` — Transport protocol for remote servers. Defaults to "streamable-http".
- `headers` · map of `string` — HTTP headers to send with every request (remote servers only, e.g. { "Authorization": "Bearer token" }). Secret references are allowed as ${secret:NAME} values.
- `deniedTools` · `string[]` — Tool names from this server to deny at execution time. Use bare tool names without the mcp\_\_&lt;serverid>\_\_ prefix (e.g. ["append\_step"]). Translated to mcp\_\_&lt;id>\_\_&lt;tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.

### `defaults.hooks` {#defaults-hooks}

- **Type:** array of `{ event, command, env?, … }`
- **Default:** `[]`
- **Workflow field:** [`hooks`](/reference/workflow-schema#execution-properties-hooks) — a workflow or step value overrides this default

User-defined hooks to run at various execution lifecycle points.

Fields:

- `event` · `"stop" | "sessionStart" | "preToolUse" | "postToolUse" | "userPromptSubmit" | "permissionRequest" | "notification" | "error"` · required — Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.
- `command` · `string` · required — Command to execute. Resolved relative to workspace root if not absolute.
- `env` · map of `string` — Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.
- `timeoutSec` · `integer` — Timeout in seconds. Only respected by CLIs that support per-hook timeouts.

### `defaults.errorBehavior` {#defaults-errorbehavior}

- **Type:** `{ onError, maxRetries?, retryDelaySec? }` or `null`
- **Default:** `null`
- **Workflow field:** [`errorBehavior`](/reference/workflow-schema#execution-properties-errorbehavior) — a workflow or step value overrides this default

Default policy for internal errors in any step phase. `null` (the default) stops the workflow unless the workflow or step sets its own policy.

Fields:

- `onError` · `"stopWorkflow" | "retry" | "continue"` · required — What to do when a step phase cannot run or otherwise encounters an internal error.
- `maxRetries` · `integer` — Maximum retry attempts when onError is retry.
- `retryDelaySec` · `number` — Delay before retrying, in seconds.

### `defaults.toolPermissions` {#defaults-toolpermissions}

- **Type:** `{ mode?, allowedTools?, deniedTools? }` or `null`
- **Workflow field:** [`toolPermissions`](/reference/workflow-schema#execution-properties-toolpermissions) — a workflow or step value overrides this default

Default tool permission settings for prompt execution. Allowed Tools and Denied Tools are currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode; Qwen is inline granular support and OpenCode uses OPENCODE\_CONFIG\_CONTENT without writing a workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns, and do NOT ENFORCE these lists.

Accepted forms:

- `{ mode?, allowedTools?, deniedTools? }` — Per-workflow/prompt tool permission overrides. Follows three-tier precedence: prompt > workflow > the `defaults.toolPermissions` setting.
- `null`

<details><summary>Default value</summary>

```json
{
  "mode": "allowAll",
  "allowedTools": [
    "write",
    "shell(git status)",
    "shell(git diff)",
    "shell(git add:*)",
    "shell(git commit:*)",
    "shell(git log:*)",
    "shell(npm:*)",
    "shell(yarn:*)",
    "shell(pnpm:*)",
    "shell(node:*)",
    "shell(npx:*)"
  ],
  "deniedTools": [
    "shell(rm:*)",
    "shell(del:*)",
    "shell(Remove-Item:*)",
    "shell(rd:*)",
    "shell(rmdir:*)",
    "shell(sudo:*)",
    "shell(chmod:*)",
    "shell(chown:*)",
    "shell(git push:*)",
    "shell(git reset:*)",
    "shell(git checkout:*)",
    "shell(git clean:*)",
    "shell(docker rm:*)",
    "shell(docker rmi:*)",
    "shell(kubectl delete:*)"
  ]
}
```

</details>

Fields:

- `mode` · `"dangerouslyAllowAll" | "allowAll" | "custom" | "none"` — Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).
- `allowedTools` · `string[]` — Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE\_CONFIG\_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.
- `deniedTools` · `string[]` — Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE\_CONFIG\_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.

### `defaults.endCondition` {#defaults-endcondition}

- **Type:** `{ script, env?, compareSource?, … }` or `null`
- **Default:** `null`
- **Workflow field:** [`endCondition`](/reference/workflow-schema#execution-properties-endcondition) — a workflow or step value overrides this default

Default end condition for new workflows. `null` (the default) means new workflows have no end condition.

Fields:

- `script` · `string` · required — Shell command or path to script. Resolved relative to workspace root or .ctrlyoke/.
- `env` · map of `string` — Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.
- `compareSource` · `"stdout" | "stderr" | "exitCode"` — Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.
- `returns` · removed — Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.
- `timeoutSec` · `number` — Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.
- `shell` · `string` — Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. "pwsh", "bash", "cmd". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.
- `operator` · `"eq" | "ne" | "contains" | "notContains" | "gte" | "gt" | "lte" | "lt" | "matches" | "isEmpty" | "isNotEmpty"` — How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. 'isEmpty'/'isNotEmpty' take no `expected`. Word tokens only: `operator: >=` is a YAML parse error and `operator: !=` silently parses as a YAML tag.
- `expected` · `string` or `number` — Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.
- `ignoreCase` · `boolean` — Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.
- `maxRetries` · `integer` — Maximum number of retry attempts. Use -1 for unlimited retries (with caution), 0 for no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.
- `retryPrompt` · `string` — Template for retry prompt. Supports $preCondition:&lt;field> and $endCondition:&lt;field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:\* works in the step and retry prompts; $endCondition:\* is only available in the retry prompt.
- `passRetryPrompt` · `string` — Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:&lt;field> and $endCondition:&lt;field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.
- `resumeSessionOnRetry` · `boolean` — Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.
- `onPass` · `"continue" | "retry" | "stopWorkflow"` — What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.
- `onFail` · `"continue" | "retry" | "stopWorkflow"` — What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times). 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default).

### `defaults.preCondition` {#defaults-precondition}

- **Type:** `{ script, env?, compareSource?, … }` or `null`
- **Default:** `null`
- **Workflow field:** [`preCondition`](/reference/workflow-schema#execution-properties-precondition) — a workflow or step value overrides this default

Default pre-condition for new workflows. `null` (the default) means new workflows have no pre-condition.

Fields:

- `script` · `string` · required — Shell command or path to script. Resolved relative to workspace root or .ctrlyoke/.
- `env` · map of `string` — Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.
- `compareSource` · `"stdout" | "stderr" | "exitCode"` — Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.
- `returns` · removed — Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.
- `timeoutSec` · `number` — Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.
- `shell` · `string` — Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. "pwsh", "bash", "cmd". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.
- `operator` · `"eq" | "ne" | "contains" | "notContains" | "gte" | "gt" | "lte" | "lt" | "matches" | "isEmpty" | "isNotEmpty"` — How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. 'isEmpty'/'isNotEmpty' take no `expected`. Word tokens only: `operator: >=` is a YAML parse error and `operator: !=` silently parses as a YAML tag.
- `expected` · `string` or `number` — Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.
- `ignoreCase` · `boolean` — Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.
- `onPass` · `"continue" | "skipPrompt" | "stopWorkflow"` — What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.
- `onFail` · `"continue" | "skipPrompt" | "stopWorkflow"` — What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.

### `defaults.worktree` {#defaults-worktree}

- **Type:** `false` or `true` or `string` or `{ mode: "managed", merge?, keep?, … }` or `{ mode: "named", branch, base?, … }`
- **Default:** `false`
- **Workflow field:** [`worktree`](/reference/workflow-schema#workflow-file-worktree) — a workflow or step value overrides this default

Default worktree behavior for workflows that omit a root worktree value. Uses the same false, shorthand, and object forms as workflow worktree; an inherited value degrades to ordinary execution when the workspace is not eligible.

Accepted forms:

- `false` — Explicitly run this workflow in the ordinary workspace.
- `true` — Managed-worktree shorthand.
- `string` — Named-worktree branch shorthand. The value must be a valid local Git branch name.
- `{ mode: "managed", merge?, keep?, … }` — Managed creates a throw-away worktree and branch per run and removes the directory when the workflow completes, leaving the branch for review; pick it for isolated runs you will not follow up on.
- `{ mode: "named", branch, base?, … }` — Named targets a persistent worktree you own, which ctrlyoke never commits, merges, or removes; pick it for conversational workflows you will append to.

**When `mode` is `"managed"`:**

Fields:

- `merge` · `boolean` — Merge the managed branch into the captured source checkout after the run.
- `keep` · `boolean` — Keeps the managed worktree directory after the run instead of removing it. Without it, appending a follow-up prompt recreates the directory from the branch; ignored files such as node\_modules are gone and the setup command runs again, so a long setup pays that cost on every append. Removing the directory also ends filesystem undo for that run.
- `base` · `string` — Optional Git ref resolved to a commit when the worktree is created.
- `setup` · `string` — Optional setup command run after a new managed worktree is created. Setup is outside the step-scoped errorBehavior policy: it runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run re-runs it; a succeeded outcome is skipped.

**When `mode` is `"named"`:**

Fields:

- `branch` · `string` · required — Local Git branch name for the named worktree.
- `base` · `string` — Optional Git ref resolved to a commit when the worktree is created.
- `setup` · `string` — Optional setup command run after a new named worktree is created. Setup is outside the step-scoped errorBehavior policy: it runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run re-runs it; a succeeded outcome is skipped.

## `worktrees` {#worktrees}

User-only worktree checkout placement configuration.

### `worktrees.root` {#worktrees-root}

- **Type:** `string`
- **Default:** `""`

Absolute or ~-prefixed directory where ctrlyoke creates worktrees.

## `coordination` {#coordination}

Retention and participant settings for the execution-root coordination board.

### `coordination.readNotesPageSize` {#coordination-readnotespagesize}

- **Type:** `integer`
- **Default:** `50`
- **Constraints:** minimum 1

Maximum number of coordination entries returned by one read\_notes page. Reads are always paged.

### `coordination.maxNoteLength` {#coordination-maxnotelength}

- **Type:** `integer`
- **Default:** `2000`
- **Constraints:** minimum 1

Maximum number of characters in a coordination note.

### `coordination.maxEntries` {#coordination-maxentries}

- **Type:** `integer`
- **Default:** `1000`
- **Constraints:** minimum 1

Maximum number of coordination entries retained after compaction.

### `coordination.maxBoardBytes` {#coordination-maxboardbytes}

- **Type:** `integer`
- **Default:** `5242880`
- **Constraints:** minimum 1

Hard maximum size of the coordination board in bytes.

### `coordination.maxEntryAgeDays` {#coordination-maxentryagedays}

- **Type:** `number`
- **Default:** `7`
- **Constraints:** minimum 1

Remove coordination notes older than this many days during compaction.

### `coordination.cliParticipantTtlMinutes` {#coordination-cliparticipantttlminutes}

- **Type:** `number`
- **Default:** `30`
- **Constraints:** minimum 1

Lease lifetime for participants delivered through the CLI or built-in skill.

### `coordination.allowExternalParticipants` {#coordination-allowexternalparticipants}

- **Type:** `boolean`
- **Default:** `true`

Allow participants not launched by ctrlyoke to join the coordination board.

## `storage` {#storage}

User-only storage location configuration.

### `storage.runHistoryLocation` {#storage-runhistorylocation}

- **Type:** `"user" | "workspace"`
- **Default:** `"user"`

Store run history under the user state home or beside the workspace.

## `permissions` {#permissions}

Harness-specific path and sandbox permission settings.

### External file roots

Workspace files are always trusted. To let ctrlyoke use a directory outside
the workspace, add it to `permissions.trustedExternalRoots`:

```json
{
  "permissions": {
    "trustedExternalRoots": [
      "C:/Users/me/.codex/sessions",
      "C:/temp/repros"
    ]
  }
}
```

- **User scope:** trusted immediately, because you edited your own settings
  file.
- **Workspace scope:** treated as a request. Each machine must approve it once,
  through the prompt in VS Code or by running `ctrlyoke trust-external-roots`
  in the workspace. Add `--yes` to approve every pending root without being
  asked. ctrlyoke stores approvals on the local machine and never writes them
  into the workspace settings file.

Roots from the user and workspace files are combined. They don't replace each
other.

A single workflow can inherit, replace, or disable this set with its
[`trustedExternalRoots`](/reference/workflow-schema#workflow-file-trustedexternalroots)
field. To approve the new roots a workflow declares, use
`ctrlyoke trust-workflow-external-roots <file>`.

### `permissions.codexSandboxMode` {#permissions-codexsandboxmode}

- **Type:** `"read-only" | "workspace-write" | "danger-full-access"`
- **Default:** `"workspace-write"`

Sandbox mode for Codex CLI.

### `permissions.codexApprovalPolicy` {#permissions-codexapprovalpolicy}

- **Type:** `"untrusted" | "on-request" | "never"`
- **Default:** `"on-request"`

Approval policy for Codex CLI tool calls.

### `permissions.trustedExternalRoots` {#permissions-trustedexternalroots}

- **Type:** `string[]`
- **Default:** `[]`

Absolute directory paths outside the workspace that ctrlyoke may read for prompt attachments and open from file links. Workspace files are always allowed. User-scope entries are trusted immediately; workspace-scope entries require a one-time batch approval before they take effect.

### `permissions.heuristicSecretRedactionEnabled` {#permissions-heuristicsecretredactionenabled}

- **Type:** `boolean`
- **Default:** `true`

Apply pattern-based heuristics (e.g. 'token=...', 'Bearer ...', private-key blocks) when redacting logs, transports, exports, and history, in addition to exact matches of resolved managed/env secret values. Exact-value redaction of secrets ctrlyoke actually resolved always stays on regardless of this setting. Disable this if the heuristics are over-matching and corrupting legitimate output, such as code samples or public identifiers that merely look like credentials.

## `usageTracking` {#usagetracking}

Controls workspace-local provider quota and observed-usage collection.

### `usageTracking.enabled` {#usagetracking-enabled}

- **Type:** `boolean`
- **Default:** `true`

Enable usage collection for ctrlyoke-started harness sessions.

### `usageTracking.providerRefreshEnabled` {#usagetracking-providerrefreshenabled}

- **Type:** `boolean`
- **Default:** `true`

Allow provider quota refreshes from configured collectors.

### `usageTracking.persistObservedUsage` {#usagetracking-persistobservedusage}

- **Type:** `boolean`
- **Default:** `true`

Persist normalized observed usage in the workspace.

### `usageTracking.warningPercentUsed` {#usagetracking-warningpercentused}

- **Type:** `number`
- **Default:** `80`
- **Constraints:** minimum 0 · maximum 100

Quota usage percentage at which ctrlyoke starts warning that a provider limit is close.

### `usageTracking.percentDirection` {#usagetracking-percentdirection}

- **Type:** `"used" | "remaining"`
- **Default:** `"used"`

Whether quota percentages are displayed as used or remaining.

## `execution` {#execution}

Execution settings.

### `execution.injectMode` {#execution-injectmode}

- **Type:** `boolean`
- **Default:** `true`

When true, keeps the TUI alive between prompts and writes follow-up prompts directly into the PTY. Faster than restarting and avoids the Claude Code resume cache bug.

### `execution.closeTerminalOnComplete` {#execution-closeterminaloncomplete}

- **Type:** `boolean`
- **Default:** `false`

Automatically close the terminal when execution completes.

### `execution.autoDeleteTempFiles` {#execution-autodeletetempfiles}

- **Type:** `boolean`
- **Default:** `true`

Automatically delete categorized prompt temp files after execution. Set to false to retain files in .ctrlyoke/temp/ for debugging.

### `execution.contextResolutionFailure` {#execution-contextresolutionfailure}

- **Type:** `"warn" | "fail"`
- **Default:** `"warn"`

How to handle a declared reference that fails to resolve: a missing/invalid secret (!NAME), an unknown skill (/skill:) or MCP server (/mcp:), an unresolved @file/#selection/#sym reference, or an unresolved ~diff/~staged/~stash/~&lt;hash> git reference. 'warn' (default) reports a diagnostic and lets the step run anyway. 'fail' stops the step before the harness spawns, naming the unresolved reference.

### `execution.maxPromptTimeoutSec` {#execution-maxprompttimeoutsec}

- **Type:** `integer`
- **Default:** `-1`
- **Constraints:** minimum -1

Maximum time in seconds to wait for a prompt to complete. Use -1 for unlimited.

### `execution.scriptTimeoutSec` {#execution-scripttimeoutsec}

- **Type:** `number`
- **Default:** `3600`

Maximum time in seconds for pre-condition, end-condition, and script-step scripts to run. A script's own `timeoutSec` (in seconds) overrides it.

### `execution.ctrlyokeMcpMode` {#execution-ctrlyokemcpmode}

- **Type:** `"native" | "skill"`
- **Default:** `"native"`

Whether ctrlyoke's own MCP server is attached natively or replaced with the built-in MCP tools skill. Only affects ctrlyoke's server, not other MCP servers configured in a workflow.

## `queue` {#queue}

Queue management settings.

`queue.maxParallelSteps` caps how many members of a
[parallel group](/reference/workflow-schema#parallel-group) run at once. If a
group has more members than the cap, the extra members wait for a free slot.
Set it to `1` to run grouped steps one at a time. Members share the workflow's
workspace and its worktree. This setting limits how many run at once. It does
not isolate members from each other or merge their work.

### `queue.maxSize` {#queue-maxsize}

- **Type:** `integer`
- **Default:** `100`

Maximum number of prompts allowed in the queue.

### `queue.maxParallelSteps` {#queue-maxparallelsteps}

- **Type:** `integer`
- **Default:** `6`
- **Constraints:** minimum 1

Maximum number of active members in a parallel step group.

### `queue.unlimitedMode` {#queue-unlimitedmode}

- **Type:** `boolean`
- **Default:** `false`

Disable queue size and time limits.

### `queue.notifyOnExtension` {#queue-notifyonextension}

- **Type:** `boolean`
- **Default:** `true`

Show a notification when the queue is extended.

### `queue.maxWorkflowExecutionTimeSec` {#queue-maxworkflowexecutiontimesec}

- **Type:** `integer`
- **Default:** `-1`
- **Constraints:** minimum -1

Maximum total execution time in seconds for a workflow. Use -1 for unlimited.

## `runs` {#runs}

Execution run retention settings. History is always on.

### `runs.maxRuns` {#runs-maxruns}

- **Type:** `integer`
- **Default:** `-1`
- **Constraints:** minimum -1

Deletes entire runs—definition and output—oldest first. -1 keeps all runs.

### `runs.historySearchCacheMb` {#runs-historysearchcachemb}

- **Type:** `number`
- **Default:** `320`
- **Constraints:** minimum 0

Approximate working-set budget in MB for caching parsed history-search documents from the most recent runs, evicted oldest-first when exceeded. Bounds real extension-host process memory (RSS), not a literal byte count — actual RSS runs above this number due to V8 overhead the estimate can't see, so the default is calibrated from measured RSS on a real index rather than the byte math alone. 0 disables the cache.

## `terminal` {#terminal}

Embedded terminal settings.

### `terminal.fontSize` {#terminal-fontsize}

- **Type:** `number`
- **Default:** `14`
- **Constraints:** minimum 8 · maximum 24

Terminal font size in pixels.

### `terminal.lineHeight` {#terminal-lineheight}

- **Type:** `number`
- **Default:** `1.2`
- **Constraints:** minimum 1 · maximum 2

Terminal line height multiplier.

### `terminal.scrollback` {#terminal-scrollback}

- **Type:** `integer`
- **Default:** `5000`
- **Constraints:** minimum 1000 · maximum 50000

Maximum scrollback lines retained in memory.

### `terminal.cursorStyle` {#terminal-cursorstyle}

- **Type:** `"block" | "underline" | "bar"`
- **Default:** `"block"`

Terminal cursor shape.

### `terminal.cursorBlink` {#terminal-cursorblink}

- **Type:** `boolean`
- **Default:** `true`

Blink the terminal cursor.

### `terminal.macOptionIsMeta` {#terminal-macoptionismeta}

- **Type:** `boolean`
- **Default:** `false`

Treat the macOS Option key as Meta.

### `terminal.wordSeparators` {#terminal-wordseparators}

- **Type:** `string`
- **Default:** `" ()[]{}',\"`"`

Characters treated as word boundaries on double-click selection.

### `terminal.replayBufferKb` {#terminal-replaybufferkb}

- **Type:** `number`
- **Default:** `50`
- **Constraints:** minimum 10 · maximum 500

Output replayed on webview reconnect, in KB.

### `terminal.shellExecutable` {#terminal-shellexecutable}

- **Type:** `string`
- **Default:** `""`

Override the shell spawned for user terminal sessions. Empty means auto-detect.

### `terminal.mobileControlBar` {#terminal-mobilecontrolbar}

- **Type:** `"auto" | "always" | "never"`
- **Default:** `"auto"`

When to show the mobile terminal control bar.

### `terminal.mobileBarLayout` {#terminal-mobilebarlayout}

- **Type:** `{ bar, popup, hidden }`

Which keys the mobile terminal control bar shows: 'bar' keys are always visible, 'popup' keys sit behind the More menu, and 'hidden' keys are not shown.

<details><summary>Default value</summary>

```json
{
  "bar": [
    "modifier:ctrl",
    "key:esc",
    "key:tab",
    "key:up",
    "key:down",
    "key:left",
    "key:right",
    "key:enter"
  ],
  "popup": [
    "shortcut:shift-tab",
    "shortcut:ctrl-c",
    "shortcut:ctrl-z",
    "shortcut:ctrl-l",
    "shortcut:ctrl-r",
    "shortcut:ctrl-a"
  ],
  "hidden": []
}
```

</details>

Fields:

- `bar` · `string[]` · required
- `popup` · `string[]` · required
- `hidden` · `string[]` · required

### `terminal.mobileCustomShortcuts` {#terminal-mobilecustomshortcuts}

- **Type:** array of `{ id, label, sequence }`
- **Default:** `[]`

Custom shortcuts in the mobile terminal control bar More menu.

Fields:

- `id` · `string` · required
- `label` · `string` · required
- `sequence` · `string` · required

## `ui` {#ui}

UI display settings.

### `ui.showCliCommand` {#ui-showclicommand}

- **Type:** `boolean`
- **Default:** `true`

Show the CLI command being executed.

### `ui.showHeadlessPermissionWarning` {#ui-showheadlesspermissionwarning}

- **Type:** `boolean`
- **Default:** `true`

Show a warning when headless execution uses limited tool permissions.

### `ui.autoFocusOutputOnExecution` {#ui-autofocusoutputonexecution}

- **Type:** `boolean`
- **Default:** `true`

Automatically expand the output section and switch to the relevant output view when a prompt starts. Headless runs show Output; interactive and inject-mode runs show Terminal.

### `ui.openPromptsInSecondGroup` {#ui-openpromptsinsecondgroup}

- **Type:** `boolean`
- **Default:** `false`

Open prompt files in a second editor group.

### `ui.respectGitignoreForCompletions` {#ui-respectgitignoreforcompletions}

- **Type:** `boolean`
- **Default:** `true`

Filter file completions using .gitignore rules.

### `ui.autoExpandEditorWhenTyping` {#ui-autoexpandeditorwhentyping}

- **Type:** `boolean`
- **Default:** `true`

Automatically grow the editor panel as you type past its current height, up to 60% of the available area. Shrinks back when text is deleted or the prompt is submitted.

### `ui.useAbsolutePathReferences` {#ui-useabsolutepathreferences}

- **Type:** `boolean`
- **Default:** `false`

Send absolute file paths to the harness/model instead of relative paths. Stored workflow text stays relative regardless of this setting. Forced on in multi-root workspaces and by harnesses that require it (e.g. Antigravity).

### `ui.outputVirtualizationRowThreshold` {#ui-outputvirtualizationrowthreshold}

- **Type:** `integer`
- **Default:** `200`
- **Constraints:** minimum -1

Minimum projected output row count before the Output panel uses virtualization. Use 0 to always virtualize, -1 to never virtualize.

### `ui.collapsedToolOutputLineCount` {#ui-collapsedtooloutputlinecount}

- **Type:** `integer`
- **Default:** `3`
- **Constraints:** minimum 1

Approximate number of wrapped lines shown for Bash and generic tool results before they collapse.

### `ui.confirmDeleteOperations` {#ui-confirmdeleteoperations}

- **Type:** `boolean`
- **Default:** `true`

Show a confirmation dialog before delete operations like removing prompts, deleting workflow history, or discarding untracked files.

### `ui.confirmResetOperations` {#ui-confirmresetoperations}

- **Type:** `boolean`
- **Default:** `true`

Show a confirmation dialog before resetting workflow start position.

### `ui.confirmContinuationDiscardOperations` {#ui-confirmcontinuationdiscardoperations}

- **Type:** `boolean`
- **Default:** `true`

Show a confirmation dialog before discarding a continuation's edited suffix (Discard Continuation, Start New Run Instead).

### `ui.hideGitIgnoredFiles` {#ui-hidegitignoredfiles}

- **Type:** `boolean`
- **Default:** `false`

Hide files and directories ignored by .gitignore in the workspace file explorer and workflow file picker.

### `ui.atomicContextReferences` {#ui-atomiccontextreferences}

- **Type:** `boolean`
- **Default:** `true`

In the prompt editor, treat @file/#symbol/~git/$context references as single units: arrow keys skip over them and Backspace/Delete removes the whole reference at once. In output, format clickable local references as compact chips. Clicking or long-pressing a reference still opens it; when off, editor references edit character by character and output uses ordinary text links.

### `ui.showCostEstimates` {#ui-showcostestimates}

- **Type:** `boolean`
- **Default:** `true`

Show token cost estimates in dashboard and CLI statistics.

### `ui.offerTrustForUntrustedFileLinks` {#ui-offertrustforuntrustedfilelinks}

- **Type:** `boolean`
- **Default:** `true`

Allow AI-generated file links outside trusted roots to offer a Trust Parent Folder action. Untrusted paths are always blocked unless their parent is explicitly trusted; this only controls whether the trust offer appears.

### `ui.stepColorMode` {#ui-stepcolormode}

- **Type:** `"none" | "harness" | "unique"`
- **Default:** `"none"`

Choose how workflow step identity colors are rendered: none uses status colors only, harness uses harness colors, and unique assigns a distinct color to each step.

### `ui.harnessColors` {#ui-harnesscolors}

- **Type:** `{ byHarness?, script? }`

Controls the per-harness identity colors used to correlate workflow steps across the dashboard.

### `ui.harnessColors.byHarness` {#ui-harnesscolors-byharness}

- **Type:** `{ copilot-cli?, claude-cli?, codex-cli?, … }`
- **Default:** `{}`

Optional hex color overrides for each harness. Remove an override to follow the built-in theme-aware chart color.

Fields:

- `copilot-cli` · `string`
- `claude-cli` · `string`
- `codex-cli` · `string`
- `opencode-cli` · `string`
- `qwen-cli` · `string`
- `antigravity-cli` · `string`

### `ui.harnessColors.script` {#ui-harnesscolors-script}

- **Type:** `string`
- **Default:** `"#808080"`
- **Constraints:** pattern `^#[0-9a-fA-F]{6}$`

Hex color used for script steps.

## `server` {#server}

ctrlyoke hosted server settings.

### `server.autoStart` {#server-autostart}

- **Type:** `boolean`
- **Default:** `false`

Automatically start the hosted dashboard server when the VS Code extension activates.

### `server.port` {#server-port}

- **Type:** `integer`
- **Default:** `4747`
- **Constraints:** minimum 1 · maximum 65535

Port for the ctrlyoke hosted server.

### `server.standalonePort` {#server-standaloneport}

- **Type:** `integer`
- **Default:** `4748`
- **Constraints:** minimum 1 · maximum 65535

Port for the standalone (non-extension) ctrlyoke server.

### `server.fallbackPorts` {#server-fallbackports}

- **Type:** `integer[]`
- **Default:** `[]`

Ordered ports to try, in order, if 'port' is already in use, before falling back to an OS-assigned port. Useful for a stable, bookmarkable URL across restarts when 'port' is often taken by another running instance.

### `server.theme` {#server-theme}

- **Type:** `"auto" | "light" | "dark"`
- **Default:** `"auto"`

Color theme for the hosted server UI.

### `server.bindAddress` {#server-bindaddress}

- **Type:** `string`
- **Default:** `"127.0.0.1"`

Network interface to bind the server to. Use '127.0.0.1' for localhost only or '0.0.0.0' for all interfaces.

### `server.tls` {#server-tls}

- **Type:** `{ enabled?, certPath?, keyPath? }`

TLS configuration for the hosted server.

### `server.tls.enabled` {#server-tls-enabled}

- **Type:** `boolean`
- **Default:** `false`

Whether TLS is enabled.

### `server.tls.certPath` {#server-tls-certpath}

- **Type:** `string`
- **Default:** `""`

Path to the TLS certificate file.

### `server.tls.keyPath` {#server-tls-keypath}

- **Type:** `string`
- **Default:** `""`

Path to the TLS private key file.

### `server.iconBgColor` {#server-iconbgcolor}

- **Type:** `string`
- **Default:** `"#3994BC"`
- **Constraints:** pattern `^#[0-9a-fA-F]{6}$`

Background color for the workspace icon (hex, e.g. '#1076ba'). Applies to the SVG favicon and PWA homescreen icon.

### `server.iconFgColor` {#server-iconfgcolor}

- **Type:** `string`
- **Default:** `"#051923"`
- **Constraints:** pattern `^#[0-9a-fA-F]{6}$`

Foreground (path/stroke) color for the workspace icon (hex, e.g. '#ffffff'). Applies to the SVG favicon and PWA homescreen icon.

## `notifications` {#notifications}

Notification settings.

### `notifications.vscode` {#notifications-vscode}

- **Type:** `{ enabled? }`

VS Code notification settings.

### `notifications.vscode.enabled` {#notifications-vscode-enabled}

- **Type:** `boolean`
- **Default:** `true`

Show VS Code notification popups when workflows complete.

### `notifications.browser` {#notifications-browser}

- **Type:** `{ mode? }`

Browser notification settings.

### `notifications.browser.mode` {#notifications-browser-mode}

- **Type:** `"never" | "connectedOnly" | "push"`
- **Default:** `"never"`

When to send browser notifications. 'connectedOnly' fires while the hosted dashboard is open; 'push' enables background push notifications.

### `notifications.toastLevel` {#notifications-toastlevel}

- **Type:** `"all" | "warningAndError" | "errorOnly" | "none"`
- **Default:** `"all"`

Minimum severity for operational toast/feedback popups, such as action results (save failures and validation errors); separate from completion notifications.

### `notifications.events` {#notifications-events}

- **Type:** `{ workflowComplete?, promptComplete?, hookEvents? }`

Which events trigger notifications.

### `notifications.events.workflowComplete` {#notifications-events-workflowcomplete}

- **Type:** `"all" | "failuresOnly" | "none"`
- **Default:** `"all"`

When to notify on workflow completion.

### `notifications.events.promptComplete` {#notifications-events-promptcomplete}

- **Type:** `"all" | "failuresOnly" | "none"`
- **Default:** `"none"`

When to notify on individual prompt completion.

### `notifications.events.hookEvents` {#notifications-events-hookevents}

- **Type:** `{ stop?, sessionStart?, preToolUse?, … }`

Which hook events trigger notifications. All default to false (opt-in).

### `notifications.events.hookEvents.stop` {#notifications-events-hookevents-stop}

- **Type:** `boolean`
- **Default:** `false`

Notify when the AI agent finishes responding.

### `notifications.events.hookEvents.sessionStart` {#notifications-events-hookevents-sessionstart}

- **Type:** `boolean`
- **Default:** `false`

Notify when a new AI session is created.

### `notifications.events.hookEvents.preToolUse` {#notifications-events-hookevents-pretooluse}

- **Type:** `boolean`
- **Default:** `false`

Notify before the AI invokes a tool.

### `notifications.events.hookEvents.postToolUse` {#notifications-events-hookevents-posttooluse}

- **Type:** `boolean`
- **Default:** `false`

Notify after the AI receives the result of a tool call.

### `notifications.events.hookEvents.userPromptSubmit` {#notifications-events-hookevents-userpromptsubmit}

- **Type:** `boolean`
- **Default:** `false`

Notify when a user prompt is submitted to the AI.

### `notifications.events.hookEvents.permissionRequest` {#notifications-events-hookevents-permissionrequest}

- **Type:** `boolean`
- **Default:** `false`

Notify when the AI requests permission to perform an action.

### `notifications.events.hookEvents.notification` {#notifications-events-hookevents-notification}

- **Type:** `boolean`
- **Default:** `false`

Notify when the harness displays a notification, including prompts that may require user input.

### `notifications.events.hookEvents.error` {#notifications-events-hookevents-error}

- **Type:** `boolean`
- **Default:** `false`

Notify when the harness reports a session-level error.

### `notifications.includeWorkflowName` {#notifications-includeworkflowname}

- **Type:** `boolean`
- **Default:** `true`

Include the workflow name in the notification message.

### `notifications.includePromptName` {#notifications-includepromptname}

- **Type:** `boolean`
- **Default:** `true`

Include the prompt name in the notification message.

### `notifications.onlyWhenWindowUnfocused` {#notifications-onlywhenwindowunfocused}

- **Type:** `boolean`
- **Default:** `true`

Suppress notifications while the VS Code window or hosted dashboard is focused.

## `commit` {#commit}

Commit message generation settings.

### `commit.harness` {#commit-harness}

- **Type:** `"copilot-cli" | "claude-cli" | "codex-cli" | "opencode-cli" | "qwen-cli" | "antigravity-cli"` or `""`
- **Default:** `""`

Harness to use for commit message generation. Empty = use the workspace default harness.

### `commit.model` {#commit-model}

- **Type:** `string`
- **Default:** `""`

Model override for commit message generation. Empty = use the commit harness default.

### `commit.systemPrompt` {#commit-systemprompt}

- **Type:** `string`

System prompt sent before the git diff. The diff is appended automatically.

<details><summary>Default value</summary>

```text
Generate a conventional commit message based on the included git diff. Return ONLY the final commit message content based on the included diff — no explanation, no code fences, no author or co-author attribution lines. Treat the provided diff and any optional user draft as the complete context for composing the message; do not read extra instruction files or inspect other workspace files unless explicitly instructed. Follow the Conventional Commits format: one or more 'type(scope): short description' header lines (use multiple headers if the change covers multiple distinct features or fixes), followed by a blank line, then one or more body paragraphs explaining the implementation details of what changed and why. Use markdown formatting in the body to improve readability where appropriate. Use bullet points for lists where necessary. If you are explicitly instructed to submit the message with a tool, call that tool with the complete commit message and do not repeat the message outside the tool call.

Example format:
feat(auth): add OAuth2 login support

Implemented OAuth2 authorization code flow using the existing HTTP client. Token refresh is handled automatically on 401 responses. Session state is persisted to localStorage to survive page reloads

Only return or submit the commit message, no extra text. Here is the git diff to generate the commit message for:

```

</details>

## `statusLine` {#statusline}

Machine-only settings for providers that install a global statusline command.

### `statusLine.useDifferentFormatPerHarness` {#statusline-usedifferentformatperharness}

- **Type:** `boolean`
- **Default:** `false`

Configure each harness's statusline format independently. When false (the default), every harness renders 'sharedFormat' and the per-harness 'format' values are left untouched but unused.

### `statusLine.sharedFormat` {#statusline-sharedformat}

- **Type:** [statusLineFormat](#type-statuslineformat)

Statusline format every harness renders while 'useDifferentFormatPerHarness' is false.

<details><summary>Default value</summary>

```json
[
  {
    "type": "literal",
    "text": "ctrlyoke"
  },
  {
    "type": "field",
    "field": "model"
  },
  {
    "type": "literal",
    "text": "·"
  },
  {
    "type": "field",
    "field": "context"
  },
  {
    "type": "literal",
    "text": "·"
  },
  {
    "type": "field",
    "field": "usage"
  }
]
```

</details>

### `statusLine.byHarness` {#statusline-byharness}

- **Type:** `{ claude-cli?, copilot-cli?, qwen-cli?, … }`

Statusline configuration keyed by ctrlyoke harness ID.

### `statusLine.byHarness.claude-cli` {#statusline-byharness-claude-cli}

- **Type:** [statusLineSettings](#type-statuslinesettings)

Statusline settings for Claude CLI.

<details><summary>Default value</summary>

```json
{
  "enabled": true,
  "customCommand": "",
  "useCtrlyokeStyle": true,
  "format": [
    {
      "type": "literal",
      "text": "ctrlyoke"
    },
    {
      "type": "field",
      "field": "model"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "context"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "usage"
    }
  ]
}
```

</details>

### `statusLine.byHarness.copilot-cli` {#statusline-byharness-copilot-cli}

- **Type:** [statusLineSettings](#type-statuslinesettings)

Statusline settings for Copilot CLI.

<details><summary>Default value</summary>

```json
{
  "enabled": true,
  "customCommand": "",
  "useCtrlyokeStyle": true,
  "format": [
    {
      "type": "literal",
      "text": "ctrlyoke"
    },
    {
      "type": "field",
      "field": "model"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "context"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "usage"
    }
  ]
}
```

</details>

### `statusLine.byHarness.qwen-cli` {#statusline-byharness-qwen-cli}

- **Type:** [statusLineSettings](#type-statuslinesettings)

Statusline settings for Qwen Code.

<details><summary>Default value</summary>

```json
{
  "enabled": true,
  "customCommand": "",
  "useCtrlyokeStyle": true,
  "format": [
    {
      "type": "literal",
      "text": "ctrlyoke"
    },
    {
      "type": "field",
      "field": "model"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "context"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "usage"
    }
  ]
}
```

</details>

### `statusLine.byHarness.antigravity-cli` {#statusline-byharness-antigravity-cli}

- **Type:** [statusLineSettings](#type-statuslinesettings)

Statusline settings for Antigravity CLI.

<details><summary>Default value</summary>

```json
{
  "enabled": true,
  "customCommand": "",
  "useCtrlyokeStyle": true,
  "format": [
    {
      "type": "literal",
      "text": "ctrlyoke"
    },
    {
      "type": "field",
      "field": "model"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "context"
    },
    {
      "type": "literal",
      "text": "·"
    },
    {
      "type": "field",
      "field": "usage"
    }
  ]
}
```

</details>

## `diagnostics` {#diagnostics}

Logging and diagnostic output settings.

### `diagnostics.verboseLogging` {#diagnostics-verboselogging}

- **Type:** `boolean`
- **Default:** `false`

Enable verbose diagnostic logging for troubleshooting.

### `diagnostics.logRawCliOutput` {#diagnostics-lograwclioutput}

- **Type:** `boolean`
- **Default:** `false`

Log raw CLI output to the extension output channel.

## Top-level settings {#top-level}

### `$schema` {#schema}

- **Type:** `string`

Schema URL used by JSON-aware editors for validation and completion.

### `schemaVersion` {#schemaversion}

- **Type:** `integer`
- **Default:** `1`
- **Constraints:** minimum 1

Settings format version. Absent means format 1. ctrlyoke stamps this field when it writes settings; an older host reads newer settings best-effort but refuses to write them.

### `modelPricing` {#modelpricing}

- **Type:** map of map of `{ inputPerMTok, outputPerMTok, cachedInputPerMTok?, … }`
- **Default:** `{}`

Optional per-harness/per-model USD pricing overrides. Rates are USD per one million tokens.

Fields:

- `inputPerMTok` · `number` · required
- `outputPerMTok` · `number` · required
- `cachedInputPerMTok` · `number`
- `cacheWritePerMTok` · `number`
- `reasoningPerMTok` · `number`

## Shared types {#shared-types}

### statusLineFormat {#type-statuslineformat}

- **Type:** array of (`{ type: "field", field, label?, … }` or `{ type: "literal", text, color? }`)

Ordered statusline segments. Used both for a provider's own 'format' and for the shared 'sharedFormat' that applies to every harness when 'useDifferentFormatPerHarness' is false.

**When `type` is `"field"`:**

Fields:

- `field` · `"brand" | "model" | "context" | "usage" | "usage1" | "usage2" | "version" | "cwd" | "sessionId" | "branch" | "date" | "time"` · required
- `label` · `string`
- `color` · `"default" | "red" | "yellow" | "green" | "cyan" | "blue" | "magenta" | "white" | "gray"`

**When `type` is `"literal"`:**

Fields:

- `text` · `string` · required
- `color` · `"default" | "red" | "yellow" | "green" | "cyan" | "blue" | "magenta" | "white" | "gray"`

### statusLineSettings {#type-statuslinesettings}

- **Type:** `{ enabled?, customCommand?, useCtrlyokeStyle?, … }`

Statusline settings for one harness.

#### `statusLineSettings.enabled` {#type-statuslinesettings-enabled}

- **Type:** `boolean`
- **Default:** `true`

Install ctrlyoke's statusline command for this harness.

#### `statusLineSettings.customCommand` {#type-statuslinesettings-customcommand}

- **Type:** `string`
- **Default:** `""`

Command to run for the provider's statusline output.

#### `statusLineSettings.useCtrlyokeStyle` {#type-statuslinesettings-usectrlyokestyle}

- **Type:** `boolean`
- **Default:** `true`

Show ctrlyoke's branded statusline instead of custom-command output.

#### `statusLineSettings.format` {#type-statuslinesettings-format}

- **Type:** [statusLineFormat](#type-statuslineformat)

Statusline format for this harness, used only while 'useDifferentFormatPerHarness' is true.
