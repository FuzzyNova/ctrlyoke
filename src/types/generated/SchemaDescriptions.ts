// AUTO-GENERATED from schemas/settings-schema.json and schemas/workflow-schema.json. Do not edit by hand.

export const SCHEMA_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "$schema": "Schema URL used by JSON-aware editors for validation and completion.",
  "_runtime": "Per-prompt runtime execution metadata (optional, added automatically during execution)",
  "_runtime.activeParallelGroup": "Durable admission state for the currently executing parallel group",
  "_runtime.additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "_runtime.agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "_runtime.completedAt": "Timestamp when this prompt completed execution (set for all terminal states, not just successful completion)",
  "_runtime.contextWindowSize": "Context window size in tokens, captured from the last completed output",
  "_runtime.contextWindowUsed": "Context window tokens in use, captured from the last completed output",
  "_runtime.currentIndex": "Index of currently executing prompt (0-based)",
  "_runtime.elapsed": "Completed prompt duration in seconds",
  "_runtime.endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "_runtime.endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "_runtime.endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "_runtime.endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "_runtime.endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "_runtime.endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "_runtime.endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "_runtime.endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "_runtime.endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "_runtime.endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "_runtime.endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "_runtime.endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "_runtime.endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "_runtime.endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "_runtime.endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "_runtime.endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "_runtime.errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "_runtime.errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "_runtime.errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "_runtime.errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "_runtime.executionEndTime": "Wall-clock timestamp when workflow execution reached a terminal state",
  "_runtime.executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "_runtime.executionState": "Current execution state",
  "_runtime.failureKind": "Structured classification of the last harness/session failure for this prompt.",
  "_runtime.failureMessage": "Human-readable message describing the last harness/session failure.",
  "_runtime.finalStep": "Runtime metadata for final step execution state (optional, added automatically during execution)",
  "_runtime.finalStep.completedAt": "Timestamp when final step execution completed",
  "_runtime.finalStep.endCondition": "Latest end-condition evaluation retained for the final step's automation result projection",
  "_runtime.finalStep.endCondition.action": "Populated for pre-conditions, where it explains the gate decision.",
  "_runtime.finalStep.endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "_runtime.finalStep.failureKind": "Structured classification for the latest final-step failure",
  "_runtime.finalStep.failureMessage": "Human-readable reason for the latest final-step failure",
  "_runtime.finalStep.loopCount": "0-based index of the current final-step pass (pass N is loopCount N-1)",
  "_runtime.finalStep.phase": "Current workflow execution phase",
  "_runtime.finalStep.preCondition": "Latest pre-condition evaluation retained for the final step's automation result projection",
  "_runtime.finalStep.preCondition.action": "Populated for pre-conditions, where it explains the gate decision.",
  "_runtime.finalStep.preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "_runtime.finalStep.startedAt": "Timestamp when final step execution started",
  "_runtime.finalStep.status": "Current final step status",
  "_runtime.harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "_runtime.hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "_runtime.hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "_runtime.hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "_runtime.hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "_runtime.hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "_runtime.lastActivityAt": "Latest persisted activity for the run, including an appended step that has not started yet.",
  "_runtime.mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "_runtime.mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "_runtime.mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "_runtime.mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "_runtime.mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "_runtime.mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "_runtime.mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "_runtime.mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "_runtime.mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "_runtime.mcpServers[].id": "Unique server identifier",
  "_runtime.mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "_runtime.mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "_runtime.model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "_runtime.pausedTime": "Wall-clock timestamp when the current pause began",
  "_runtime.pendingRewind": "Durable marker for an in-place, nonzero rewind. The full pre-rewind file is kept beside the run until the continuation is committed or discarded.",
  "_runtime.pendingRewind.baseDefinitionRevision": "Definition revision the rewind was taken from",
  "_runtime.pendingRewind.fromStepIndex": "0-based index of the first rewound step",
  "_runtime.preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "_runtime.preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "_runtime.preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "_runtime.preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "_runtime.preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "_runtime.preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "_runtime.preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "_runtime.preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "_runtime.preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "_runtime.preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "_runtime.preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "_runtime.preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "_runtime.priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "_runtime.priorContext.previous": "How many of the most recent earlier outputs to include",
  "_runtime.priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "_runtime.priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "_runtime.priorContext[]": "1-based prompt number",
  "_runtime.resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "_runtime.retryCount": "Number of retry attempts for this prompt",
  "_runtime.schemaVersion": "Run-file format version for _runtime metadata and run bookkeeping, stamped on every write. It is independent of the root schemaVersion, which versions the workflow definition format. A file written by a newer ctrlyoke is refused rather than overwritten.",
  "_runtime.secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "_runtime.sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "_runtime.skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "_runtime.startTime": "Wall-clock timestamp when active workflow execution timing began",
  "_runtime.startedAt": "Timestamp when the executor claimed this step for dispatch",
  "_runtime.stepId": "Stable internal identity for this queue step within its run",
  "_runtime.stopReason": "Structured reason when a run ended because an execution guardrail fired.",
  "_runtime.stopReason.message": "Canonical human-readable message for the stop.",
  "_runtime.stopReason.observed": "Observed value in the unit named by `unit`.",
  "_runtime.stopReason.threshold": "Configured guardrail threshold in the unit named by `unit`.",
  "_runtime.terminalFailure": "Whether a failed member remains terminal for its parallel group. False when a per-step continue policy resolved the failure.",
  "_runtime.terminalStatus": "Terminal state of this prompt. Absent or 'completed' means successful completion. Used to restore the correct visual status after a working file reload.",
  "_runtime.tokenTotals": "Latest run-scoped token aggregate projected from timeline history (working files only, written automatically during execution)",
  "_runtime.tokenTotals.byHarness": "Same aggregate partitioned by the harness recorded on each immutable attempt output.",
  "_runtime.tokenTotals.byHarness.*": "Per-harness token subtotal within a run aggregate.",
  "_runtime.tokenTotals.byLocalDay": "Same per-harness subtotals partitioned by the attempt start's local day (YYYY-MM-DD).",
  "_runtime.tokenTotals.byLocalDay.*.*": "Per-harness token subtotal within a run aggregate.",
  "_runtime.tokenTotals.coverage": "'complete' only when every executed AI attempt reported a usable total",
  "_runtime.tokenTotals.isFinal": "False while the run can still add usage",
  "_runtime.tokenTotals.total": "Sum of every AI attempt's token total observed in this run",
  "_runtime.toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "_runtime.toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "_runtime.toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "_runtime.toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "_runtime.totalPausedDuration": "Accumulated time spent paused before the current pause, in milliseconds",
  "_runtime.worktree": "Disk-authoritative lifecycle metadata for a worktree-backed run. Distinct from the authored root `worktree` setting: this records the checkout the run actually used.",
  "_runtime.worktree.changedFileCount": "Number of files in the landed branch diff from baseCommit, when known",
  "_runtime.worktree.comparisonBaseLabel": "Recorded comparison base used for named-branch divergence, when known",
  "_runtime.worktree.dirty": "Whether the named checkout had uncommitted changes at run start",
  "_runtime.worktree.origin": "Whether ctrlyoke created the worktree, found it already present, or recovered it after an interrupted run",
  "_runtime.worktree.sourceCheckoutDirty": "Whether source checkout changes existed when the managed worktree was created",
  "_runtime.worktreeNotice": "Durable notice recorded when an inherited worktree default degraded to ordinary execution",
  "_templateMeta": "Marks the file as a reusable template and describes its placeholders. Removed when the template is instantiated.",
  "_templateMeta.description": "Short explanation shown in the template picker.",
  "_templateMeta.name": "Display name shown in the template picker.",
  "_templateMeta.variables": "Metadata for placeholders used by this template, keyed by variable name.",
  "_templateMeta.variables.*.autoFillFilename": "Use the selected file or directory basename as the initial workflow name.",
  "_templateMeta.variables.*.default": "Initial value used when the user leaves the variable unchanged.",
  "_templateMeta.variables.*.description": "Help text shown below the variable control.",
  "_templateMeta.variables.*.fileFilter": "File-picker glob patterns used by file variables.",
  "_templateMeta.variables.*.multiline": "Render a text variable as a multiline input.",
  "_templateMeta.variables.*.options": "Available values for a select variable.",
  "_templateMeta.variables.*.type": "Control used to collect this variable in the template dialog.",
  "additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "color": "Optional authored identity colour for this step.",
  "commit": "Commit message generation settings.",
  "commit.harness": "Harness to use for commit message generation. Empty = use the workspace default harness.",
  "commit.model": "Model override for commit message generation. Empty = use the commit harness default.",
  "commit.systemPrompt": "System prompt sent before the git diff. The diff is appended automatically.",
  "compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "coordination": "Retention and participant settings for the execution-root coordination board.",
  "coordination.allowExternalParticipants": "Allow participants not launched by ctrlyoke to join the coordination board.",
  "coordination.cliParticipantTtlMinutes": "Lease lifetime for participants delivered through the CLI or built-in skill.",
  "coordination.maxBoardBytes": "Hard maximum size of the coordination board in bytes.",
  "coordination.maxEntries": "Maximum number of coordination entries retained after compaction.",
  "coordination.maxEntryAgeDays": "Remove coordination notes older than this many days during compaction.",
  "coordination.maxNoteLength": "Maximum number of characters in a coordination note.",
  "coordination.readNotesPageSize": "Maximum number of coordination entries returned by one read_notes page. Reads are always paged.",
  "defaults": "Default execution properties applied to all new workflows (mirrors ExecutionProperties).",
  "defaults.additionalArgs": "The default additional CLI arguments for each harness for new workflows. A workspace-scope value takes effect only after you approve that exact value on this machine, through the VS Code prompt or `ctrlyoke trust-workspace-settings`; until then the user value applies.",
  "defaults.agent": "Default portable ctrlyoke workflow agent attachment for new workflows. Native harness agent discovery is managed separately by the Agents & Skills settings page.",
  "defaults.endCondition": "Default end condition for new workflows. `null` (the default) means new workflows have no end condition. A workspace-scope value takes effect only after you approve that exact value on this machine, through the VS Code prompt or `ctrlyoke trust-workspace-settings`; until then the user value applies.",
  "defaults.endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "defaults.endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "defaults.endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "defaults.endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "defaults.endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "defaults.endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "defaults.endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "defaults.endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "defaults.endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "defaults.endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "defaults.endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "defaults.endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "defaults.endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "defaults.endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "defaults.endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "defaults.errorBehavior": "Default policy for internal errors in any step phase. `null` (the default) stops the workflow unless the workflow or step sets its own policy.",
  "defaults.errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "defaults.errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "defaults.errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "defaults.executionMode": "Default execution mode for new workflows. 'interactive' spawns a live terminal (TUI) the user can steer; 'headless' runs in the background with output in the Output panel. Workflows and individual steps can override this.",
  "defaults.harness": "The default harness for workflows and steps that do not name one. Empty = auto-detect: the first installed harness in alphabetical order (antigravity-cli, claude-cli, codex-cli, copilot-cli, opencode-cli, qwen-cli).",
  "defaults.hooks": "User-defined hooks to run at various execution lifecycle points. A workspace-scope hook takes effect only after you approve that exact hook on this machine, through the VS Code prompt or `ctrlyoke trust-workspace-settings`; until then the user value applies.",
  "defaults.hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "defaults.hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "defaults.hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "defaults.hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "defaults.mcpServers": "Default MCP servers to attach to each prompt execution. A workspace-scope entry that launches a command takes effect only after you approve that exact entry on this machine, through the VS Code prompt or `ctrlyoke trust-workspace-settings`; until then the user value applies.",
  "defaults.mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "defaults.mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "defaults.mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "defaults.mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "defaults.mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "defaults.mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "defaults.mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "defaults.mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "defaults.mcpServers[].id": "Unique server identifier",
  "defaults.mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "defaults.mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "defaults.models": "The default model to use for each harness for new workflows.",
  "defaults.preCondition": "Default pre-condition for new workflows. `null` (the default) means new workflows have no pre-condition. A workspace-scope value takes effect only after you approve that exact value on this machine, through the VS Code prompt or `ctrlyoke trust-workspace-settings`; until then the user value applies.",
  "defaults.preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "defaults.preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "defaults.preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "defaults.preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "defaults.preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "defaults.preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "defaults.preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "defaults.preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "defaults.preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "defaults.preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "defaults.preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "defaults.priorContext": "Default priorContext for every step that doesn't set its own.",
  "defaults.priorContext.previous": "How many of the most recent earlier outputs to include",
  "defaults.priorContext[]": "1-based prompt number",
  "defaults.resumeSession": "Resume an existing session when running a workflow.",
  "defaults.secrets": "Default secret environment-variable names granted to new workflows. Values are resolved by the execution host and never stored in workflow definitions.",
  "defaults.skills": "Default portable ctrlyoke workflow skill attachments for new workflows. Native harness skill discovery is managed separately by the Agents & Skills settings page and does not determine workflow skill support.",
  "defaults.toolPermissions": "Default tool permission settings for prompt execution. Allowed Tools and Denied Tools are currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode; Qwen is inline granular support and OpenCode uses OPENCODE_CONFIG_CONTENT without writing a workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns, and do NOT ENFORCE these lists.",
  "defaults.toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "defaults.toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "defaults.toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "defaults.worktree": "Default worktree behavior for workflows that omit a root worktree value. Uses the same false, shorthand, and object forms as workflow worktree; an inherited value degrades to ordinary execution when the workspace is not eligible.",
  "defaults.worktree.base": "Optional Git ref resolved to a commit when the worktree is created.",
  "defaults.worktree.branch": "Local Git branch name for the named worktree.",
  "defaults.worktree.keep": "Keeps the managed worktree directory after the run instead of removing it. Without it, appending a follow-up prompt recreates the directory from the branch; ignored files such as node_modules are gone and the setup command runs again, so a long setup pays that cost on every append. Removing the directory also ends filesystem undo for that run.",
  "defaults.worktree.merge": "Merge the managed branch into the captured source checkout after the run.",
  "defaults.worktree.setup": "Optional setup command run after a new managed worktree is created. Setup is outside the step-scoped errorBehavior policy: it runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run re-runs it; a succeeded outcome is skipped.",
  "definitionRevision": "Monotonic optimistic-concurrency counter, bumped on every definition-changing edit and not on runtime-only writes. Starts at 1; each promoted run restarts its own sequence at 1 (working files only).",
  "diagnostics": "Logging and diagnostic output settings.",
  "diagnostics.logRawCliOutput": "Log raw CLI output to the extension output channel.",
  "diagnostics.verboseLogging": "Enable verbose diagnostic logging for troubleshooting.",
  "enabled": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution.",
  "endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "execution": "Execution settings.",
  "execution.autoDeleteTempFiles": "Automatically delete categorized prompt temp files after execution. Set to false to retain files in .ctrlyoke/temp/ for debugging.",
  "execution.closeTerminalOnComplete": "Automatically close the interactive terminal when execution completes. Turning this on disables `execution.injectMode`.",
  "execution.contextResolutionFailure": "How to handle a declared reference that fails to resolve: a missing/invalid secret (!NAME), an unknown skill (/skill:) or MCP server (/mcp:), an unresolved @file/#selection/#sym reference, or an unresolved ~diff/~staged/~stash/~<hash> git reference. 'warn' (default) reports a diagnostic and lets the step run anyway. 'fail' stops the step before the harness spawns, naming the unresolved reference.",
  "execution.ctrlyokeMcpMode": "Whether ctrlyoke's own MCP server is attached natively or replaced with the built-in MCP tools skill. Only affects ctrlyoke's server, not other MCP servers configured in a workflow.",
  "execution.injectMode": "When true, keeps the TUI alive between prompts and writes follow-up prompts directly into the PTY. Faster than restarting and avoids the Claude Code resume cache bug. Interactive steps only, and only when the step resumes the previous session. Has no effect while `execution.closeTerminalOnComplete` is on.",
  "execution.maxPromptTimeoutSec": "Maximum time in seconds for one harness prompt to complete. A finite value stops the prompt when its execution budget expires; `-1` disables the prompt timeout.",
  "execution.scriptTimeoutSec": "Maximum time in seconds for pre-condition, end-condition, and script-step scripts, and for a worktree's setup command, to run. This setting must be greater than zero and has no unlimited value. A script's own `timeoutSec` (in seconds) overrides it.",
  "executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "finalStep": "A step that always runs after all queued prompts complete. Can be an AI prompt or a script step. If mcpServers includes \"ctrlyoke\" and the finalStep appends prompts, those prompts run before finalStep executes again. Working files store resolved harness/model/session metadata on finalStep._runtime; workflow phase/status remains in the root _runtime.finalStep block.",
  "finalStep._runtime": "Per-prompt runtime execution metadata (optional, added automatically during execution)",
  "finalStep._runtime.additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "finalStep._runtime.agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "finalStep._runtime.completedAt": "Timestamp when this prompt completed execution (set for all terminal states, not just successful completion)",
  "finalStep._runtime.contextWindowSize": "Context window size in tokens, captured from the last completed output",
  "finalStep._runtime.contextWindowUsed": "Context window tokens in use, captured from the last completed output",
  "finalStep._runtime.elapsed": "Completed prompt duration in seconds",
  "finalStep._runtime.endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "finalStep._runtime.endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "finalStep._runtime.endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "finalStep._runtime.endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "finalStep._runtime.endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "finalStep._runtime.endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "finalStep._runtime.endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "finalStep._runtime.endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "finalStep._runtime.endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "finalStep._runtime.endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "finalStep._runtime.endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "finalStep._runtime.endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "finalStep._runtime.endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "finalStep._runtime.endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "finalStep._runtime.endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "finalStep._runtime.endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "finalStep._runtime.errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "finalStep._runtime.errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "finalStep._runtime.errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "finalStep._runtime.errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "finalStep._runtime.executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "finalStep._runtime.failureKind": "Structured classification of the last harness/session failure for this prompt.",
  "finalStep._runtime.failureMessage": "Human-readable message describing the last harness/session failure.",
  "finalStep._runtime.harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "finalStep._runtime.hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "finalStep._runtime.hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "finalStep._runtime.hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "finalStep._runtime.hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "finalStep._runtime.hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "finalStep._runtime.mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "finalStep._runtime.mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "finalStep._runtime.mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "finalStep._runtime.mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "finalStep._runtime.mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "finalStep._runtime.mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "finalStep._runtime.mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "finalStep._runtime.mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "finalStep._runtime.mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "finalStep._runtime.mcpServers[].id": "Unique server identifier",
  "finalStep._runtime.mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "finalStep._runtime.mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "finalStep._runtime.model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "finalStep._runtime.preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "finalStep._runtime.preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "finalStep._runtime.preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "finalStep._runtime.preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "finalStep._runtime.preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "finalStep._runtime.preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "finalStep._runtime.preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "finalStep._runtime.preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "finalStep._runtime.preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "finalStep._runtime.preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "finalStep._runtime.preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "finalStep._runtime.preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "finalStep._runtime.priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "finalStep._runtime.priorContext.previous": "How many of the most recent earlier outputs to include",
  "finalStep._runtime.priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "finalStep._runtime.priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "finalStep._runtime.priorContext[]": "1-based prompt number",
  "finalStep._runtime.resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "finalStep._runtime.retryCount": "Number of retry attempts for this prompt",
  "finalStep._runtime.secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "finalStep._runtime.sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "finalStep._runtime.skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "finalStep._runtime.startedAt": "Timestamp when the executor claimed this step for dispatch",
  "finalStep._runtime.stepId": "Stable internal identity for this queue step within its run",
  "finalStep._runtime.terminalFailure": "Whether a failed member remains terminal for its parallel group. False when a per-step continue policy resolved the failure.",
  "finalStep._runtime.terminalStatus": "Terminal state of this prompt. Absent or 'completed' means successful completion. Used to restore the correct visual status after a working file reload.",
  "finalStep._runtime.toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "finalStep._runtime.toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "finalStep._runtime.toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "finalStep._runtime.toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "finalStep.additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "finalStep.agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "finalStep.color": "Optional authored identity colour for this step.",
  "finalStep.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "finalStep.enabled": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution.",
  "finalStep.endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "finalStep.endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "finalStep.endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "finalStep.endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "finalStep.endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "finalStep.endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "finalStep.endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "finalStep.endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "finalStep.endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "finalStep.endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "finalStep.endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "finalStep.endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "finalStep.endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "finalStep.endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "finalStep.endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "finalStep.endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "finalStep.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "finalStep.errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "finalStep.errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "finalStep.errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "finalStep.errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "finalStep.executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "finalStep.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "finalStep.harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "finalStep.hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "finalStep.hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "finalStep.hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "finalStep.hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "finalStep.hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "finalStep.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "finalStep.mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "finalStep.mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "finalStep.mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "finalStep.mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "finalStep.mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "finalStep.mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "finalStep.mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "finalStep.mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "finalStep.mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "finalStep.mcpServers[].id": "Unique server identifier",
  "finalStep.mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "finalStep.mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "finalStep.model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "finalStep.name": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a truncated preview of the prompt text.",
  "finalStep.onFail": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default).",
  "finalStep.onPass": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately.",
  "finalStep.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "finalStep.preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "finalStep.preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "finalStep.preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "finalStep.preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "finalStep.preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "finalStep.preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "finalStep.preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "finalStep.preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "finalStep.preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "finalStep.preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "finalStep.preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "finalStep.preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "finalStep.priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "finalStep.priorContext.previous": "How many of the most recent earlier outputs to include",
  "finalStep.priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "finalStep.priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "finalStep.priorContext[]": "1-based prompt number",
  "finalStep.prompt": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported.",
  "finalStep.resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "finalStep.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "finalStep.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "finalStep.secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "finalStep.sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "finalStep.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "finalStep.skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "finalStep.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "finalStep.toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "finalStep.toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "finalStep.toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "finalStep.toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "finalStep.type": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible).",
  "general": "General format, template, and behavior settings.",
  "general.autoLoadRecentSession": "Automatically load the most recent session on startup.",
  "general.defaultFormat": "Default file format for new workflows.",
  "general.defaultTemplate": "Default template to use for new workflows.",
  "general.includeFullDiffsInPriorContext": "Include full file diffs in captured AI responses so later prior-context attachments contain the actual changes instead of edit summaries.",
  "general.omitPreviouslyAttachedAgentsSkillsOnResume": "When resuming an existing session, omit only agent/skill declarations that were already attached earlier in that same session.",
  "harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "languageServers": "Managed language server definitions and language selections for the workspace editor.",
  "languageServers.definitions": "Server id to command definition. Workspace definitions remain pending until the user approves them.",
  "languageServers.definitions.*": "Command, supported languages, and root markers for one managed language server.",
  "languageServers.definitions.*.command": "Executable followed by its arguments. For example: [\"pyright-langserver\", \"--stdio\"].",
  "languageServers.definitions.*.env": "Environment variables passed to the server process.",
  "languageServers.definitions.*.extensions": "File extensions served, without a leading dot.",
  "languageServers.definitions.*.languages": "LSP language ids served by this definition.",
  "languageServers.definitions.*.rootMarkers": "Files or directories used to find the project root.",
  "languageServers.idleShutdownMinutes": "User-only idle timeout in minutes before a server without open documents is stopped. 0 disables idle shutdown.",
  "languageServers.maxRunning": "User-only maximum number of concurrently running language servers.",
  "languageServers.settings": "Server id to LSP initialization and workspace/configuration settings.",
  "languageServers.startOnLaunch": "User-only opt-in to start selected language servers when the hosted server launches. Defaults to lazy startup.",
  "languageServers.use": "Language id to selected server id, or false to disable language intelligence. Workspace scope may select available servers.",
  "maxSteps": "Maximum number of entries in the run's `steps` array, regardless of who queued them, including parallel members and disabled steps. `finalStep` iterations and retries are not counted. Omit to inherit `queue.maxSteps`. `-1` means unlimited.",
  "mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "mcpServers[].id": "Unique server identifier",
  "mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "modelPricing": "Optional per-harness/per-model USD pricing overrides. Rates are USD per one million tokens.",
  "name": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a truncated preview of the prompt text.",
  "notifications": "Notification settings.",
  "notifications.browser": "Browser notification settings.",
  "notifications.browser.mode": "When to send browser notifications. 'connectedOnly' fires while the hosted dashboard is open; 'push' enables background push notifications.",
  "notifications.events": "Which events trigger notifications.",
  "notifications.events.hookEvents": "Which hook events trigger notifications. All default to false (opt-in).",
  "notifications.events.hookEvents.error": "Notify when the harness reports a session-level error.",
  "notifications.events.hookEvents.notification": "Notify when the harness displays a notification, including prompts that may require user input.",
  "notifications.events.hookEvents.permissionRequest": "Notify when the AI requests permission to perform an action.",
  "notifications.events.hookEvents.postToolUse": "Notify after the AI receives the result of a tool call.",
  "notifications.events.hookEvents.preToolUse": "Notify before the AI invokes a tool.",
  "notifications.events.hookEvents.sessionStart": "Notify when a new AI session is created.",
  "notifications.events.hookEvents.stop": "Notify when the AI agent finishes responding.",
  "notifications.events.hookEvents.userPromptSubmit": "Notify when a user prompt is submitted to the AI.",
  "notifications.events.promptComplete": "When to notify on individual prompt completion.",
  "notifications.events.workflowComplete": "When to notify on workflow completion.",
  "notifications.includePromptName": "Include the prompt name in the notification message.",
  "notifications.includeWorkflowName": "Include the workflow name in the notification message.",
  "notifications.onlyWhenWindowUnfocused": "Suppress notifications while the VS Code window or hosted dashboard is focused.",
  "notifications.toastLevel": "Minimum severity for operational toast/feedback popups, such as action results (save failures and validation errors); separate from completion notifications.",
  "notifications.vscode": "VS Code notification settings.",
  "notifications.vscode.enabled": "Show VS Code notification popups for workflow and step completion and for hook events. Operational messages are controlled by `notifications.toastLevel` instead.",
  "onFail": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default).",
  "onPass": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately.",
  "operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "parallelGroups": "Normalized working-file topology for authored parallel groups.",
  "parallelGroups[]": "Normalized working-file topology for one authored parallel group.",
  "permissions": "Harness-specific path and sandbox permission settings.",
  "permissions.codexApprovalPolicy": "Approval policy for Codex CLI tool calls.",
  "permissions.codexSandboxMode": "Sandbox mode for Codex CLI.",
  "permissions.heuristicSecretRedactionEnabled": "Apply pattern-based heuristics (e.g. 'token=...', 'Bearer ...', private-key blocks) when redacting logs, transports, exports, and history, in addition to exact matches of resolved managed/env secret values. Exact-value redaction of secrets ctrlyoke actually resolved always stays on regardless of this setting. Disable this if the heuristics are over-matching and corrupting legitimate output, such as code samples or public identifiers that merely look like credentials.",
  "permissions.trustedExternalRoots": "Absolute directory paths outside the workspace that ctrlyoke may read for prompt attachments and open from file links. Workspace files are always allowed. User-scope entries are trusted immediately; workspace-scope entries require a one-time batch approval before they take effect.",
  "preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "priorContext.previous": "How many of the most recent earlier outputs to include",
  "priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "priorContext[]": "1-based prompt number",
  "prompt": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported.",
  "queue": "Queue management settings.",
  "queue.maxParallelSteps": "Maximum number of active members in a parallel step group.",
  "queue.maxSteps": "Maximum number of entries in the run's steps array, including disabled steps and each member of a parallel group. Checked before execution starts and after queue extensions; retries and final-step passes do not add entries. A workflow's own `maxSteps` replaces this value for that workflow, so a workflow `maxSteps: -1` lifts this cap. Dashboard appends, MCP `append_step`, and run continuation enforce the same resolved limit. `-1` disables the queue-size limit.",
  "queue.maxWorkflowExecutionTimeSec": "Maximum active execution time in seconds for a workflow. Checked at safe step, parallel-group, final-step, and retry boundaries; paused time is excluded. `-1` disables the workflow-time limit.",
  "resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "runs": "Execution run retention settings. History is always on.",
  "runs.historySearchCacheMb": "Approximate working-set budget in MB for caching parsed history-search documents from the most recent runs, evicted oldest-first when exceeded. Bounds real extension-host process memory (RSS), not a literal byte count — actual RSS runs above this number due to V8 overhead the estimate can't see, so the default is calibrated from measured RSS on a real index rather than the byte math alone. 0 disables the cache.",
  "runs.maxRuns": "Maximum runs kept per workflow. When a new run starts, that workflow's oldest runs are permanently deleted, definition and output together, without passing through Recently deleted. Running runs and runs another workflow uses as prior context are kept, so the count can briefly exceed the limit. `-1` means unlimited.",
  "schemaVersion": "Settings format version. Absent means format 1. ctrlyoke stamps this field when it writes settings; an older host reads newer settings best-effort but refuses to write them.",
  "script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "server": "ctrlyoke hosted server settings.",
  "server.autoStart": "Automatically start the hosted dashboard server when the VS Code extension activates.",
  "server.bindAddress": "Network interface to bind the server to. Use '127.0.0.1' for localhost only or '0.0.0.0' for all interfaces.",
  "server.fallbackPorts": "Ordered ports to try, in order, if 'port' is already in use, before falling back to an OS-assigned port. Useful for a stable, bookmarkable URL across restarts when 'port' is often taken by another running instance.",
  "server.iconBgColor": "Background color for the workspace icon (hex, e.g. '#1076ba'). Applies to the SVG favicon and PWA homescreen icon.",
  "server.iconFgColor": "Foreground (path/stroke) color for the workspace icon (hex, e.g. '#ffffff'). Applies to the SVG favicon and PWA homescreen icon.",
  "server.port": "Port for the ctrlyoke hosted server.",
  "server.theme": "Color theme for the hosted server UI.",
  "server.tls": "TLS configuration for the hosted server.",
  "server.tls.certPath": "Path to the TLS certificate file.",
  "server.tls.enabled": "Whether TLS is enabled.",
  "server.tls.keyPath": "Path to the TLS private key file.",
  "sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "startedAt": "Timestamp when workflow started (working files only)",
  "statusLine": "Machine-only settings for providers that install a global statusline command.",
  "statusLine.byHarness": "Statusline configuration keyed by ctrlyoke harness ID.",
  "statusLine.byHarness.antigravity-cli": "Statusline settings for Antigravity CLI.",
  "statusLine.byHarness.antigravity-cli.customCommand": "Command to run for the provider's statusline output.",
  "statusLine.byHarness.antigravity-cli.enabled": "Install ctrlyoke's statusline command for this harness.",
  "statusLine.byHarness.antigravity-cli.format": "Statusline format for this harness, used only while 'useDifferentFormatPerHarness' is true.",
  "statusLine.byHarness.antigravity-cli.useCtrlyokeStyle": "Show ctrlyoke's branded statusline instead of custom-command output.",
  "statusLine.byHarness.claude-cli": "Statusline settings for Claude CLI.",
  "statusLine.byHarness.claude-cli.customCommand": "Command to run for the provider's statusline output.",
  "statusLine.byHarness.claude-cli.enabled": "Install ctrlyoke's statusline command for this harness.",
  "statusLine.byHarness.claude-cli.format": "Statusline format for this harness, used only while 'useDifferentFormatPerHarness' is true.",
  "statusLine.byHarness.claude-cli.useCtrlyokeStyle": "Show ctrlyoke's branded statusline instead of custom-command output.",
  "statusLine.byHarness.copilot-cli": "Statusline settings for Copilot CLI.",
  "statusLine.byHarness.copilot-cli.customCommand": "Command to run for the provider's statusline output.",
  "statusLine.byHarness.copilot-cli.enabled": "Install ctrlyoke's statusline command for this harness.",
  "statusLine.byHarness.copilot-cli.format": "Statusline format for this harness, used only while 'useDifferentFormatPerHarness' is true.",
  "statusLine.byHarness.copilot-cli.useCtrlyokeStyle": "Show ctrlyoke's branded statusline instead of custom-command output.",
  "statusLine.byHarness.qwen-cli": "Statusline settings for Qwen Code.",
  "statusLine.byHarness.qwen-cli.customCommand": "Command to run for the provider's statusline output.",
  "statusLine.byHarness.qwen-cli.enabled": "Install ctrlyoke's statusline command for this harness.",
  "statusLine.byHarness.qwen-cli.format": "Statusline format for this harness, used only while 'useDifferentFormatPerHarness' is true.",
  "statusLine.byHarness.qwen-cli.useCtrlyokeStyle": "Show ctrlyoke's branded statusline instead of custom-command output.",
  "statusLine.sharedFormat": "Statusline format every harness renders while 'useDifferentFormatPerHarness' is false.",
  "statusLine.useDifferentFormatPerHarness": "Configure each harness's statusline format independently. When false (the default), every harness renders 'sharedFormat' and the per-harness 'format' values are left untouched but unused.",
  "steps": "The ordered step queue. Each item is a prompt step, a script step, or a parallel group.",
  "steps[]": "Shared execution configuration properties used across workflow-level defaults, prompt-level overrides, and runtime metadata",
  "steps[]._runtime": "Per-prompt runtime execution metadata (optional, added automatically during execution)",
  "steps[]._runtime.additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "steps[]._runtime.agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "steps[]._runtime.completedAt": "Timestamp when this prompt completed execution (set for all terminal states, not just successful completion)",
  "steps[]._runtime.contextWindowSize": "Context window size in tokens, captured from the last completed output",
  "steps[]._runtime.contextWindowUsed": "Context window tokens in use, captured from the last completed output",
  "steps[]._runtime.elapsed": "Completed prompt duration in seconds",
  "steps[]._runtime.endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "steps[]._runtime.endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[]._runtime.endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[]._runtime.endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[]._runtime.endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[]._runtime.endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "steps[]._runtime.endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "steps[]._runtime.endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "steps[]._runtime.endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[]._runtime.endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "steps[]._runtime.endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "steps[]._runtime.endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "steps[]._runtime.endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[]._runtime.endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[]._runtime.endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[]._runtime.endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[]._runtime.errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "steps[]._runtime.errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "steps[]._runtime.errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "steps[]._runtime.errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "steps[]._runtime.executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "steps[]._runtime.failureKind": "Structured classification of the last harness/session failure for this prompt.",
  "steps[]._runtime.failureMessage": "Human-readable message describing the last harness/session failure.",
  "steps[]._runtime.harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "steps[]._runtime.hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "steps[]._runtime.hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "steps[]._runtime.hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[]._runtime.hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "steps[]._runtime.hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "steps[]._runtime.mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "steps[]._runtime.mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "steps[]._runtime.mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "steps[]._runtime.mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "steps[]._runtime.mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "steps[]._runtime.mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "steps[]._runtime.mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "steps[]._runtime.mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "steps[]._runtime.mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "steps[]._runtime.mcpServers[].id": "Unique server identifier",
  "steps[]._runtime.mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "steps[]._runtime.mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "steps[]._runtime.model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "steps[]._runtime.preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "steps[]._runtime.preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[]._runtime.preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[]._runtime.preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[]._runtime.preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[]._runtime.preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "steps[]._runtime.preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "steps[]._runtime.preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[]._runtime.preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[]._runtime.preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[]._runtime.preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[]._runtime.preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[]._runtime.priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "steps[]._runtime.priorContext.previous": "How many of the most recent earlier outputs to include",
  "steps[]._runtime.priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "steps[]._runtime.priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "steps[]._runtime.priorContext[]": "1-based prompt number",
  "steps[]._runtime.resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "steps[]._runtime.retryCount": "Number of retry attempts for this prompt",
  "steps[]._runtime.secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "steps[]._runtime.sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "steps[]._runtime.skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "steps[]._runtime.startedAt": "Timestamp when the executor claimed this step for dispatch",
  "steps[]._runtime.stepId": "Stable internal identity for this queue step within its run",
  "steps[]._runtime.terminalFailure": "Whether a failed member remains terminal for its parallel group. False when a per-step continue policy resolved the failure.",
  "steps[]._runtime.terminalStatus": "Terminal state of this prompt. Absent or 'completed' means successful completion. Used to restore the correct visual status after a working file reload.",
  "steps[]._runtime.toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "steps[]._runtime.toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "steps[]._runtime.toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "steps[]._runtime.toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "steps[].additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "steps[].agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "steps[].color": "Optional authored identity colour for this step.",
  "steps[].compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].enabled": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution.",
  "steps[].endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "steps[].endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "steps[].endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "steps[].endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "steps[].endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "steps[].endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "steps[].endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "steps[].endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "steps[].errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "steps[].errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "steps[].errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "steps[].executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "steps[].expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].failFast": "Stop the remaining members as soon as one member fails. Default: true.",
  "steps[].harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "steps[].hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "steps[].hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "steps[].hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "steps[].hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "steps[].ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "steps[].mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "steps[].mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "steps[].mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "steps[].mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "steps[].mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "steps[].mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "steps[].mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "steps[].mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "steps[].mcpServers[].id": "Unique server identifier",
  "steps[].mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "steps[].mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "steps[].model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "steps[].name": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a truncated preview of the prompt text.",
  "steps[].onFail": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default).",
  "steps[].onPass": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately.",
  "steps[].operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].parallel": "The prompt or script steps that run concurrently. Groups cannot be nested.",
  "steps[].parallel[]": "Shared execution configuration properties used across workflow-level defaults, prompt-level overrides, and runtime metadata",
  "steps[].parallel[]._runtime": "Per-prompt runtime execution metadata (optional, added automatically during execution)",
  "steps[].parallel[]._runtime.additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "steps[].parallel[]._runtime.agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "steps[].parallel[]._runtime.completedAt": "Timestamp when this prompt completed execution (set for all terminal states, not just successful completion)",
  "steps[].parallel[]._runtime.contextWindowSize": "Context window size in tokens, captured from the last completed output",
  "steps[].parallel[]._runtime.contextWindowUsed": "Context window tokens in use, captured from the last completed output",
  "steps[].parallel[]._runtime.elapsed": "Completed prompt duration in seconds",
  "steps[].parallel[]._runtime.endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "steps[].parallel[]._runtime.endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].parallel[]._runtime.endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].parallel[]._runtime.endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].parallel[]._runtime.endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].parallel[]._runtime.endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "steps[].parallel[]._runtime.endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "steps[].parallel[]._runtime.endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "steps[].parallel[]._runtime.endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].parallel[]._runtime.endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "steps[].parallel[]._runtime.endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "steps[].parallel[]._runtime.endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "steps[].parallel[]._runtime.endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].parallel[]._runtime.endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].parallel[]._runtime.endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].parallel[]._runtime.endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].parallel[]._runtime.errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "steps[].parallel[]._runtime.errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "steps[].parallel[]._runtime.errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "steps[].parallel[]._runtime.errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "steps[].parallel[]._runtime.executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "steps[].parallel[]._runtime.failureKind": "Structured classification of the last harness/session failure for this prompt.",
  "steps[].parallel[]._runtime.failureMessage": "Human-readable message describing the last harness/session failure.",
  "steps[].parallel[]._runtime.harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "steps[].parallel[]._runtime.hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "steps[].parallel[]._runtime.hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "steps[].parallel[]._runtime.hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].parallel[]._runtime.hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "steps[].parallel[]._runtime.hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "steps[].parallel[]._runtime.mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "steps[].parallel[]._runtime.mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "steps[].parallel[]._runtime.mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "steps[].parallel[]._runtime.mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "steps[].parallel[]._runtime.mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "steps[].parallel[]._runtime.mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "steps[].parallel[]._runtime.mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "steps[].parallel[]._runtime.mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "steps[].parallel[]._runtime.mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "steps[].parallel[]._runtime.mcpServers[].id": "Unique server identifier",
  "steps[].parallel[]._runtime.mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "steps[].parallel[]._runtime.mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "steps[].parallel[]._runtime.model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "steps[].parallel[]._runtime.preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "steps[].parallel[]._runtime.preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].parallel[]._runtime.preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].parallel[]._runtime.preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].parallel[]._runtime.preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].parallel[]._runtime.preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "steps[].parallel[]._runtime.preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "steps[].parallel[]._runtime.preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].parallel[]._runtime.preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].parallel[]._runtime.preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].parallel[]._runtime.preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].parallel[]._runtime.preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].parallel[]._runtime.priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "steps[].parallel[]._runtime.priorContext.previous": "How many of the most recent earlier outputs to include",
  "steps[].parallel[]._runtime.priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "steps[].parallel[]._runtime.priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "steps[].parallel[]._runtime.priorContext[]": "1-based prompt number",
  "steps[].parallel[]._runtime.resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "steps[].parallel[]._runtime.retryCount": "Number of retry attempts for this prompt",
  "steps[].parallel[]._runtime.secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "steps[].parallel[]._runtime.sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "steps[].parallel[]._runtime.skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "steps[].parallel[]._runtime.startedAt": "Timestamp when the executor claimed this step for dispatch",
  "steps[].parallel[]._runtime.stepId": "Stable internal identity for this queue step within its run",
  "steps[].parallel[]._runtime.terminalFailure": "Whether a failed member remains terminal for its parallel group. False when a per-step continue policy resolved the failure.",
  "steps[].parallel[]._runtime.terminalStatus": "Terminal state of this prompt. Absent or 'completed' means successful completion. Used to restore the correct visual status after a working file reload.",
  "steps[].parallel[]._runtime.toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "steps[].parallel[]._runtime.toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "steps[].parallel[]._runtime.toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "steps[].parallel[]._runtime.toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "steps[].parallel[].additionalArgs": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\"",
  "steps[].parallel[].agent": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.",
  "steps[].parallel[].color": "Optional authored identity colour for this step.",
  "steps[].parallel[].compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].parallel[].enabled": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution.",
  "steps[].parallel[].endCondition": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).",
  "steps[].parallel[].endCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].parallel[].endCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].parallel[].endCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].parallel[].endCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].parallel[].endCondition.maxRetries": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.",
  "steps[].parallel[].endCondition.onFail": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.",
  "steps[].parallel[].endCondition.onPass": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.",
  "steps[].parallel[].endCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].parallel[].endCondition.passRetryPrompt": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.",
  "steps[].parallel[].endCondition.resumeSessionOnRetry": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.",
  "steps[].parallel[].endCondition.retryPrompt": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt.",
  "steps[].parallel[].endCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].parallel[].endCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].parallel[].endCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].parallel[].endCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].parallel[].env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].parallel[].errorBehavior": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.",
  "steps[].parallel[].errorBehavior.maxRetries": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed.",
  "steps[].parallel[].errorBehavior.onError": "What to do when a step phase cannot run or otherwise encounters an internal error.",
  "steps[].parallel[].errorBehavior.retryDelaySec": "Delay before retrying, in seconds.",
  "steps[].parallel[].executionMode": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.",
  "steps[].parallel[].expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].parallel[].harness": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.",
  "steps[].parallel[].hooks": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.",
  "steps[].parallel[].hooks[].command": "Command to execute. Resolved relative to workspace root if not absolute.",
  "steps[].parallel[].hooks[].env": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].parallel[].hooks[].event": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.",
  "steps[].parallel[].hooks[].timeoutSec": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts.",
  "steps[].parallel[].ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].parallel[].mcpServers": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.",
  "steps[].parallel[].mcpServers[]": "A well-known MCP server ID, a user-defined server configuration, or the built-in `ctrlyoke` server with optional deniedTools. For the built-in server, deniedTools lists bare tool names to disable (for example, [\"append_step\"]).",
  "steps[].parallel[].mcpServers[].args": "Arguments to pass to the command (stdio servers only)",
  "steps[].parallel[].mcpServers[].autoApprove": "Tools to auto-approve: true = all tools, string[] = specific tools",
  "steps[].parallel[].mcpServers[].command": "Command to run the MCP server process (stdio servers, e.g. \"npx\" or \"node\")",
  "steps[].parallel[].mcpServers[].deniedTools": "Tool names from this server to deny at execution time. Use bare tool names without the mcp__<serverid>__ prefix (e.g. [\"append_step\"]). Translated to mcp__<id>__<tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.",
  "steps[].parallel[].mcpServers[].description": "Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.",
  "steps[].parallel[].mcpServers[].env": "Environment variables for the server process (stdio servers only)",
  "steps[].parallel[].mcpServers[].headers": "HTTP headers to send with every request (remote servers only, e.g. { \"Authorization\": \"Bearer token\" }). Secret references are allowed as ${secret:NAME} values.",
  "steps[].parallel[].mcpServers[].id": "Unique server identifier",
  "steps[].parallel[].mcpServers[].transport": "Transport protocol for remote servers. Defaults to \"streamable-http\".",
  "steps[].parallel[].mcpServers[].url": "Remote endpoint URL for streamable-http or SSE servers (e.g. \"https://mcp.example.com\")",
  "steps[].parallel[].model": "AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.",
  "steps[].parallel[].name": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a truncated preview of the prompt text.",
  "steps[].parallel[].onFail": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default).",
  "steps[].parallel[].onPass": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately.",
  "steps[].parallel[].operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].parallel[].preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "steps[].parallel[].preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].parallel[].preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].parallel[].preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].parallel[].preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].parallel[].preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "steps[].parallel[].preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "steps[].parallel[].preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].parallel[].preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].parallel[].preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].parallel[].preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].parallel[].preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].parallel[].priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "steps[].parallel[].priorContext.previous": "How many of the most recent earlier outputs to include",
  "steps[].parallel[].priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "steps[].parallel[].priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "steps[].parallel[].priorContext[]": "1-based prompt number",
  "steps[].parallel[].prompt": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported.",
  "steps[].parallel[].resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "steps[].parallel[].returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].parallel[].script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].parallel[].secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "steps[].parallel[].sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "steps[].parallel[].shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].parallel[].skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "steps[].parallel[].timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].parallel[].toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "steps[].parallel[].toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "steps[].parallel[].toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "steps[].parallel[].toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "steps[].parallel[].type": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible).",
  "steps[].preCondition": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.",
  "steps[].preCondition.compareSource": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.",
  "steps[].preCondition.env": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.",
  "steps[].preCondition.expected": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.",
  "steps[].preCondition.ignoreCase": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.",
  "steps[].preCondition.onFail": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.",
  "steps[].preCondition.onPass": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.",
  "steps[].preCondition.operator": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.",
  "steps[].preCondition.returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].preCondition.script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].preCondition.shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].preCondition.timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].priorContext": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "steps[].priorContext.previous": "How many of the most recent earlier outputs to include",
  "steps[].priorContext.runRef": "Stable completed-run reference within workflowKey.",
  "steps[].priorContext.workflowKey": "Stable workflow lineage key within the current workspace.",
  "steps[].priorContext[]": "1-based prompt number",
  "steps[].prompt": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported.",
  "steps[].resumeSession": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.",
  "steps[].returns": "Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.",
  "steps[].script": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.",
  "steps[].secrets": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.",
  "steps[].sessionId": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.",
  "steps[].shell": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "steps[].skills": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.",
  "steps[].timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "steps[].toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "steps[].toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "steps[].toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "steps[].toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "steps[].type": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible).",
  "storage": "User-only storage location configuration.",
  "storage.runHistoryLocation": "Store run history under the user state home or beside the workspace. Recently deleted runs, observed usage, and the history search index move with it. User scope only. Takes effect after a window reload, and existing history is not moved: the other location appears as a separate history, and switching back restores it.",
  "storage.trashRetentionDays": "Days a deleted run or workflow stays in Recently deleted before it is permanently removed. Every history delete, including Clear all history, moves runs to Recently deleted, where they can be restored until then.",
  "terminal": "Embedded terminal settings.",
  "terminal.cursorBlink": "Blink the terminal cursor.",
  "terminal.cursorStyle": "Terminal cursor shape.",
  "terminal.fontSize": "Terminal font size in pixels.",
  "terminal.lineHeight": "Terminal line height multiplier.",
  "terminal.macOptionIsMeta": "Treat the macOS Option key as Meta.",
  "terminal.mobileBarLayout": "Which keys the mobile terminal control bar shows: 'bar' keys are always visible, 'popup' keys sit behind the More menu, and 'hidden' keys are not shown. Each entry is a key ID: `modifier:ctrl` (a one-shot Ctrl toggle); `key:esc`, `key:tab`, `key:up`, `key:down`, `key:left`, `key:right`, or `key:enter`; `shortcut:shift-tab`, `shortcut:ctrl-c`, `shortcut:ctrl-z`, `shortcut:ctrl-l`, `shortcut:ctrl-r`, or `shortcut:ctrl-a`; or the `id` of an entry in `terminal.mobileCustomShortcuts`. Unknown IDs are dropped, and a known key missing from all three lists is added to 'popup'.",
  "terminal.mobileBarLayout.bar": "Key IDs always visible on the bar, in order. `modifier:ctrl` is kept here unless it is hidden.",
  "terminal.mobileBarLayout.hidden": "Key IDs not shown anywhere.",
  "terminal.mobileBarLayout.popup": "Key IDs shown in the More menu, in order. The menu shows shortcuts only, and `modifier:ctrl` placed here moves to 'bar'.",
  "terminal.mobileControlBar": "When to show the mobile terminal control bar.",
  "terminal.mobileCustomShortcuts": "Custom shortcuts in the mobile terminal control bar More menu.",
  "terminal.replayBufferKb": "Output replayed on webview reconnect, in KB.",
  "terminal.scrollback": "Maximum scrollback lines retained in memory.",
  "terminal.shellExecutable": "Override the shell spawned for user terminal sessions and for inline script text. Empty means auto-detect. A workspace-scope value takes effect only after you approve that exact value on this machine, through the VS Code prompt or `ctrlyoke trust-workspace-settings`; until then the user value applies.",
  "terminal.wordSeparators": "Characters treated as word boundaries on double-click selection.",
  "timeoutSec": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.",
  "toolPermissions": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.",
  "toolPermissions.allowedTools": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.",
  "toolPermissions.deniedTools": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.",
  "toolPermissions.mode": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).",
  "trustedExternalRoots": "Restricts, extends, or disables this workflow's external-root access relative to the user/workspace defaults. Omit this field entirely to inherit the live union of approved user + workspace permissions.trustedExternalRoots (today's behavior, unchanged). When set, the array REPLACES that inherited union rather than adding to it — it may contain brand-new roots this workflow alone needs (widening, without growing the user/workspace list for every other workflow) and/or a deliberately narrowed subset of already-trusted roots (restricting a risky workflow to less than the everyday default); either way every root in the array still needs its own one-time approval unless already approved at a broader scope.",
  "type": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible).",
  "ui": "UI display settings.",
  "ui.atomicContextReferences": "In the prompt editor, treat @file/#symbol/~git/$context references as single units: arrow keys skip over them and Backspace/Delete removes the whole reference at once. In output, format clickable local references as compact chips. Clicking or tapping a chip opens it, and right-clicking or long-pressing it offers Go to Reference, Copy Reference, and Send as Plain Text; when off, editor references edit character by character and output uses ordinary text links.",
  "ui.autoExpandEditorWhenTyping": "Automatically grow the editor panel as you type past its current height, up to 60% of the available area. Shrinks back when text is deleted or the prompt is submitted.",
  "ui.autoFocusOutputOnExecution": "Automatically expand the output section and switch to the relevant output view when a prompt starts. Headless runs show Output; interactive and inject-mode runs show Terminal.",
  "ui.collapsedToolOutputLineCount": "Approximate number of wrapped lines shown for Bash and generic tool results before they collapse.",
  "ui.confirmContinuationDiscardOperations": "Show a confirmation dialog before discarding a continuation's edited suffix (Discard Continuation, Start New Run Instead).",
  "ui.confirmDeleteOperations": "Show a confirmation dialog before delete operations like removing prompts, deleting workflow history, or discarding untracked files.",
  "ui.confirmResetOperations": "Show a confirmation dialog before resetting workflow start position.",
  "ui.harnessColors": "Controls the per-harness identity colors used to correlate workflow steps across the dashboard.",
  "ui.harnessColors.byHarness": "Optional hex color overrides for each harness. Remove an override to follow the built-in theme-aware chart color.",
  "ui.harnessColors.script": "Hex color used for script steps.",
  "ui.hideGitIgnoredFiles": "Hide files and directories ignored by .gitignore in the workspace file explorer and workflow file picker.",
  "ui.offerTrustForUntrustedFileLinks": "Allow AI-generated file links outside trusted roots to offer a Trust Parent Folder action. Untrusted paths are always blocked unless their parent is explicitly trusted; this only controls whether the trust offer appears.",
  "ui.openPromptsInSecondGroup": "Open prompt files in a second editor group.",
  "ui.outputVirtualizationRowThreshold": "Minimum projected output row count before the Output panel uses virtualization. 0 means always virtualize. `-1` means never.",
  "ui.respectGitignoreForCompletions": "Filter file completions using .gitignore rules.",
  "ui.showCliCommand": "Show the CLI command being executed.",
  "ui.showCostEstimates": "Show token cost estimates in dashboard and CLI statistics.",
  "ui.showHeadlessPermissionWarning": "Show a warning when headless execution uses limited tool permissions.",
  "ui.stepColorMode": "Choose how workflow step identity colors are rendered: none uses status colors only, harness uses harness colors, and unique assigns a distinct color to each step.",
  "ui.useAbsolutePathReferences": "Send absolute file paths to the harness/model instead of relative paths. Stored workflow text stays relative regardless of this setting. Forced on in multi-root workspaces and by harnesses that require it (e.g. Antigravity).",
  "ui.wordWrap": "Wrap long lines in code views: the workspace file editor, script and condition editors, and diffs. When off, long lines extend past the view and scroll horizontally. The prompt editor always wraps.",
  "usageTracking": "Controls provider quota and observed-usage collection.",
  "usageTracking.enabled": "Enable usage collection for ctrlyoke-started harness sessions.",
  "usageTracking.percentDirection": "Whether quota percentages are displayed as used or remaining.",
  "usageTracking.persistObservedUsage": "Save observed usage and lifetime statistics with this project's run history, so they survive a restart. The location follows `storage.runHistoryLocation`. Requires `usageTracking.enabled`.",
  "usageTracking.providerRefreshEnabled": "Allow provider quota refreshes from configured collectors. Requires `usageTracking.enabled`.",
  "usageTracking.warningPercentUsed": "Quota usage percentage at which ctrlyoke starts warning that a provider limit is close.",
  "vars": "Default values for `{{varName}}` substitutions.",
  "worktree": "Run the workflow in the working checkout or in a Git worktree. When omitted, the `defaults.worktree` setting applies.",
  "worktree.base": "Optional Git ref resolved to a commit when the worktree is created.",
  "worktree.branch": "Local Git branch name for the named worktree.",
  "worktree.keep": "Keeps the managed worktree directory after the run instead of removing it. Without it, appending a follow-up prompt recreates the directory from the branch; ignored files such as node_modules are gone and the setup command runs again, so a long setup pays that cost on every append. Removing the directory also ends filesystem undo for that run.",
  "worktree.merge": "Merge the managed branch into the captured source checkout after the run.",
  "worktree.setup": "Optional setup command run after a new managed worktree is created. Setup is outside the step-scoped errorBehavior policy: it runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run re-runs it; a succeeded outcome is skipped.",
  "worktrees": "User-only worktree checkout placement configuration.",
  "worktrees.root": "Absolute or ~-prefixed directory where ctrlyoke creates worktrees."
};

export const SCHEMA_ENUMS: Readonly<Record<string, readonly (string | number | boolean | null)[]>> = {
  "_runtime.activeParallelGroup.admission": [
    "accepting",
    "closing"
  ],
  "_runtime.agent": [
    ""
  ],
  "_runtime.endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "_runtime.endCondition.maxRetries": [
    -1
  ],
  "_runtime.endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "_runtime.endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "_runtime.endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "_runtime.errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "_runtime.executionMode": [
    "interactive",
    "headless"
  ],
  "_runtime.executionState": [
    "idle",
    "running",
    "pausing",
    "paused",
    "stopped",
    "cancelling",
    "completed",
    "error"
  ],
  "_runtime.failureKind": [
    "userCancelled",
    "processExit",
    "harnessError",
    "harnessNotInstalled",
    "timeout",
    "unknown"
  ],
  "_runtime.finalStep.endCondition.action": [
    "continue",
    "stopWorkflow",
    "retry",
    "skipPrompt"
  ],
  "_runtime.finalStep.endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "_runtime.finalStep.failureKind": [
    "userCancelled",
    "processExit",
    "harnessError",
    "harnessNotInstalled",
    "timeout",
    "unknown"
  ],
  "_runtime.finalStep.phase": [
    "queue",
    "finalStep"
  ],
  "_runtime.finalStep.preCondition.action": [
    "continue",
    "stopWorkflow",
    "retry",
    "skipPrompt"
  ],
  "_runtime.finalStep.preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "_runtime.finalStep.status": [
    "pending",
    "sent",
    "running",
    "completed",
    "failed",
    "cancelled",
    "skipped"
  ],
  "_runtime.harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "_runtime.hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "_runtime.mcpServers[].id": [
    "ctrlyoke"
  ],
  "_runtime.mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "_runtime.preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "_runtime.preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "_runtime.preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "_runtime.preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "_runtime.priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "_runtime.stopReason.code": [
    "queue-size-limit",
    "workflow-time-limit",
    "prompt-timeout"
  ],
  "_runtime.stopReason.unit": [
    "steps",
    "seconds"
  ],
  "_runtime.terminalStatus": [
    "completed",
    "cancelled",
    "failed",
    "skipped"
  ],
  "_runtime.tokenTotals.byHarness.*.costSources[]": [
    "harness-reported",
    "price-table",
    "user-override"
  ],
  "_runtime.tokenTotals.byHarness.*.coverage": [
    "complete",
    "partial"
  ],
  "_runtime.tokenTotals.byLocalDay.*.*.costSources[]": [
    "harness-reported",
    "price-table",
    "user-override"
  ],
  "_runtime.tokenTotals.byLocalDay.*.*.coverage": [
    "complete",
    "partial"
  ],
  "_runtime.tokenTotals.costSources[]": [
    "harness-reported",
    "price-table",
    "user-override"
  ],
  "_runtime.tokenTotals.coverage": [
    "complete",
    "partial"
  ],
  "_runtime.toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "_runtime.worktree.branchState": [
    "present",
    "deleted",
    "missing"
  ],
  "_runtime.worktree.directoryState": [
    "present",
    "removed",
    "missing",
    "remove-failed"
  ],
  "_runtime.worktree.landingOutcome": [
    "landed",
    "no-changes",
    "blocked"
  ],
  "_runtime.worktree.lifecycleOwner": [
    "ctrlyoke",
    "user"
  ],
  "_runtime.worktree.lifecycleState": [
    "provisioning",
    "ready",
    "finalizing",
    "settled",
    "blocked",
    "orphaned"
  ],
  "_runtime.worktree.mergeOutcome": [
    "fast-forward",
    "merge-commit",
    "conflict",
    "blocked",
    "abort-failed"
  ],
  "_runtime.worktree.mode": [
    "managed",
    "named"
  ],
  "_runtime.worktree.origin": [
    "created",
    "discovered",
    "recovered"
  ],
  "_runtime.worktree.schemaVersion": [
    1
  ],
  "_runtime.worktree.setupOutcome": [
    "pending",
    "running",
    "succeeded",
    "failed"
  ],
  "_templateMeta.variables.*.type": [
    "text",
    "file",
    "directory",
    "select",
    "harness"
  ],
  "agent": [
    ""
  ],
  "commit.harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli",
    ""
  ],
  "compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "defaults.agent": [
    ""
  ],
  "defaults.endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "defaults.endCondition.maxRetries": [
    -1
  ],
  "defaults.endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "defaults.endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "defaults.endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "defaults.errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "defaults.executionMode": [
    "interactive",
    "headless"
  ],
  "defaults.harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli",
    ""
  ],
  "defaults.hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "defaults.mcpServers[].id": [
    "ctrlyoke"
  ],
  "defaults.mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "defaults.preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "defaults.preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "defaults.preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "defaults.preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "defaults.priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "defaults.toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "defaults.worktree": [
    false,
    true
  ],
  "defaults.worktree.mode": [
    "managed",
    "named"
  ],
  "endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "endCondition.maxRetries": [
    -1
  ],
  "endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "execution.contextResolutionFailure": [
    "warn",
    "fail"
  ],
  "execution.ctrlyokeMcpMode": [
    "native",
    "skill"
  ],
  "execution.maxPromptTimeoutSec": [
    -1
  ],
  "executionMode": [
    "interactive",
    "headless"
  ],
  "finalStep._runtime.agent": [
    ""
  ],
  "finalStep._runtime.endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "finalStep._runtime.endCondition.maxRetries": [
    -1
  ],
  "finalStep._runtime.endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "finalStep._runtime.endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "finalStep._runtime.endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "finalStep._runtime.errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "finalStep._runtime.executionMode": [
    "interactive",
    "headless"
  ],
  "finalStep._runtime.failureKind": [
    "userCancelled",
    "processExit",
    "harnessError",
    "harnessNotInstalled",
    "timeout",
    "unknown"
  ],
  "finalStep._runtime.harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "finalStep._runtime.hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "finalStep._runtime.mcpServers[].id": [
    "ctrlyoke"
  ],
  "finalStep._runtime.mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "finalStep._runtime.preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "finalStep._runtime.preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "finalStep._runtime.preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "finalStep._runtime.preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "finalStep._runtime.priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "finalStep._runtime.terminalStatus": [
    "completed",
    "cancelled",
    "failed",
    "skipped"
  ],
  "finalStep._runtime.toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "finalStep.agent": [
    ""
  ],
  "finalStep.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "finalStep.endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "finalStep.endCondition.maxRetries": [
    -1
  ],
  "finalStep.endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "finalStep.endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "finalStep.endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "finalStep.errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "finalStep.executionMode": [
    "interactive",
    "headless"
  ],
  "finalStep.harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "finalStep.hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "finalStep.mcpServers[].id": [
    "ctrlyoke"
  ],
  "finalStep.mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "finalStep.onFail": [
    "continue",
    "stopWorkflow"
  ],
  "finalStep.onPass": [
    "continue",
    "stopWorkflow"
  ],
  "finalStep.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "finalStep.preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "finalStep.preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "finalStep.preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "finalStep.preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "finalStep.priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "finalStep.toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "finalStep.type": [
    "prompt",
    "script"
  ],
  "general.defaultFormat": [
    "yaml",
    "json"
  ],
  "harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "languageServers.use.*": [
    false
  ],
  "maxSteps": [
    -1
  ],
  "mcpServers[].id": [
    "ctrlyoke"
  ],
  "mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "notifications.browser.mode": [
    "never",
    "connectedOnly",
    "push"
  ],
  "notifications.events.promptComplete": [
    "all",
    "failuresOnly",
    "none"
  ],
  "notifications.events.workflowComplete": [
    "all",
    "failuresOnly",
    "none"
  ],
  "notifications.toastLevel": [
    "all",
    "warningAndError",
    "errorOnly",
    "none"
  ],
  "onFail": [
    "continue",
    "stopWorkflow"
  ],
  "onPass": [
    "continue",
    "stopWorkflow"
  ],
  "operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "permissions.codexApprovalPolicy": [
    "untrusted",
    "on-request",
    "never"
  ],
  "permissions.codexSandboxMode": [
    "read-only",
    "workspace-write",
    "danger-full-access"
  ],
  "preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "queue.maxSteps": [
    -1
  ],
  "queue.maxWorkflowExecutionTimeSec": [
    -1
  ],
  "runs.maxRuns": [
    -1
  ],
  "server.theme": [
    "auto",
    "light",
    "dark"
  ],
  "statusLine.byHarness.antigravity-cli.format[].color": [
    "default",
    "red",
    "yellow",
    "green",
    "cyan",
    "blue",
    "magenta",
    "white",
    "gray"
  ],
  "statusLine.byHarness.antigravity-cli.format[].field": [
    "brand",
    "model",
    "context",
    "usage",
    "usage1",
    "usage2",
    "version",
    "cwd",
    "sessionId",
    "branch",
    "date",
    "time"
  ],
  "statusLine.byHarness.antigravity-cli.format[].type": [
    "field",
    "literal"
  ],
  "statusLine.byHarness.claude-cli.format[].color": [
    "default",
    "red",
    "yellow",
    "green",
    "cyan",
    "blue",
    "magenta",
    "white",
    "gray"
  ],
  "statusLine.byHarness.claude-cli.format[].field": [
    "brand",
    "model",
    "context",
    "usage",
    "usage1",
    "usage2",
    "version",
    "cwd",
    "sessionId",
    "branch",
    "date",
    "time"
  ],
  "statusLine.byHarness.claude-cli.format[].type": [
    "field",
    "literal"
  ],
  "statusLine.byHarness.copilot-cli.format[].color": [
    "default",
    "red",
    "yellow",
    "green",
    "cyan",
    "blue",
    "magenta",
    "white",
    "gray"
  ],
  "statusLine.byHarness.copilot-cli.format[].field": [
    "brand",
    "model",
    "context",
    "usage",
    "usage1",
    "usage2",
    "version",
    "cwd",
    "sessionId",
    "branch",
    "date",
    "time"
  ],
  "statusLine.byHarness.copilot-cli.format[].type": [
    "field",
    "literal"
  ],
  "statusLine.byHarness.qwen-cli.format[].color": [
    "default",
    "red",
    "yellow",
    "green",
    "cyan",
    "blue",
    "magenta",
    "white",
    "gray"
  ],
  "statusLine.byHarness.qwen-cli.format[].field": [
    "brand",
    "model",
    "context",
    "usage",
    "usage1",
    "usage2",
    "version",
    "cwd",
    "sessionId",
    "branch",
    "date",
    "time"
  ],
  "statusLine.byHarness.qwen-cli.format[].type": [
    "field",
    "literal"
  ],
  "statusLine.sharedFormat[].color": [
    "default",
    "red",
    "yellow",
    "green",
    "cyan",
    "blue",
    "magenta",
    "white",
    "gray"
  ],
  "statusLine.sharedFormat[].field": [
    "brand",
    "model",
    "context",
    "usage",
    "usage1",
    "usage2",
    "version",
    "cwd",
    "sessionId",
    "branch",
    "date",
    "time"
  ],
  "statusLine.sharedFormat[].type": [
    "field",
    "literal"
  ],
  "steps[]._runtime.agent": [
    ""
  ],
  "steps[]._runtime.endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[]._runtime.endCondition.maxRetries": [
    -1
  ],
  "steps[]._runtime.endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[]._runtime.endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[]._runtime.endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[]._runtime.errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "steps[]._runtime.executionMode": [
    "interactive",
    "headless"
  ],
  "steps[]._runtime.failureKind": [
    "userCancelled",
    "processExit",
    "harnessError",
    "harnessNotInstalled",
    "timeout",
    "unknown"
  ],
  "steps[]._runtime.harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "steps[]._runtime.hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "steps[]._runtime.mcpServers[].id": [
    "ctrlyoke"
  ],
  "steps[]._runtime.mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "steps[]._runtime.preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[]._runtime.preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[]._runtime.preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[]._runtime.preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[]._runtime.priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "steps[]._runtime.terminalStatus": [
    "completed",
    "cancelled",
    "failed",
    "skipped"
  ],
  "steps[]._runtime.toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "steps[].agent": [
    ""
  ],
  "steps[].compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].endCondition.maxRetries": [
    -1
  ],
  "steps[].endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[].endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[].endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "steps[].executionMode": [
    "interactive",
    "headless"
  ],
  "steps[].harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "steps[].hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "steps[].mcpServers[].id": [
    "ctrlyoke"
  ],
  "steps[].mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "steps[].onFail": [
    "continue",
    "stopWorkflow"
  ],
  "steps[].onPass": [
    "continue",
    "stopWorkflow"
  ],
  "steps[].operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].parallel[]._runtime.agent": [
    ""
  ],
  "steps[].parallel[]._runtime.endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].parallel[]._runtime.endCondition.maxRetries": [
    -1
  ],
  "steps[].parallel[]._runtime.endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[].parallel[]._runtime.endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[].parallel[]._runtime.endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].parallel[]._runtime.errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "steps[].parallel[]._runtime.executionMode": [
    "interactive",
    "headless"
  ],
  "steps[].parallel[]._runtime.failureKind": [
    "userCancelled",
    "processExit",
    "harnessError",
    "harnessNotInstalled",
    "timeout",
    "unknown"
  ],
  "steps[].parallel[]._runtime.harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "steps[].parallel[]._runtime.hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "steps[].parallel[]._runtime.mcpServers[].id": [
    "ctrlyoke"
  ],
  "steps[].parallel[]._runtime.mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "steps[].parallel[]._runtime.preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].parallel[]._runtime.preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[].parallel[]._runtime.preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[].parallel[]._runtime.preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].parallel[]._runtime.priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "steps[].parallel[]._runtime.terminalStatus": [
    "completed",
    "cancelled",
    "failed",
    "skipped"
  ],
  "steps[].parallel[]._runtime.toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "steps[].parallel[].agent": [
    ""
  ],
  "steps[].parallel[].compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].parallel[].endCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].parallel[].endCondition.maxRetries": [
    -1
  ],
  "steps[].parallel[].endCondition.onFail": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[].parallel[].endCondition.onPass": [
    "continue",
    "retry",
    "stopWorkflow"
  ],
  "steps[].parallel[].endCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].parallel[].errorBehavior.onError": [
    "stopWorkflow",
    "retry",
    "continue"
  ],
  "steps[].parallel[].executionMode": [
    "interactive",
    "headless"
  ],
  "steps[].parallel[].harness": [
    "copilot-cli",
    "claude-cli",
    "codex-cli",
    "opencode-cli",
    "qwen-cli",
    "antigravity-cli"
  ],
  "steps[].parallel[].hooks[].event": [
    "stop",
    "sessionStart",
    "preToolUse",
    "postToolUse",
    "userPromptSubmit",
    "permissionRequest",
    "notification",
    "error"
  ],
  "steps[].parallel[].mcpServers[].id": [
    "ctrlyoke"
  ],
  "steps[].parallel[].mcpServers[].transport": [
    "streamable-http",
    "sse"
  ],
  "steps[].parallel[].onFail": [
    "continue",
    "stopWorkflow"
  ],
  "steps[].parallel[].onPass": [
    "continue",
    "stopWorkflow"
  ],
  "steps[].parallel[].operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].parallel[].preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].parallel[].preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[].parallel[].preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[].parallel[].preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].parallel[].priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "steps[].parallel[].toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "steps[].parallel[].type": [
    "prompt",
    "script"
  ],
  "steps[].preCondition.compareSource": [
    "stdout",
    "stderr",
    "exitCode"
  ],
  "steps[].preCondition.onFail": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[].preCondition.onPass": [
    "continue",
    "skipPrompt",
    "stopWorkflow"
  ],
  "steps[].preCondition.operator": [
    "eq",
    "ne",
    "contains",
    "notContains",
    "gte",
    "gt",
    "lte",
    "lt",
    "matches",
    "isEmpty",
    "isNotEmpty"
  ],
  "steps[].priorContext": [
    "all",
    "previous",
    "none",
    "finalStepAll",
    "finalStepPrevious"
  ],
  "steps[].toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "steps[].type": [
    "prompt",
    "script"
  ],
  "storage.runHistoryLocation": [
    "user",
    "workspace"
  ],
  "terminal.cursorStyle": [
    "block",
    "underline",
    "bar"
  ],
  "terminal.mobileControlBar": [
    "auto",
    "always",
    "never"
  ],
  "toolPermissions.mode": [
    "dangerouslyAllowAll",
    "allowAll",
    "custom",
    "none"
  ],
  "type": [
    "prompt",
    "script"
  ],
  "ui.outputVirtualizationRowThreshold": [
    -1
  ],
  "ui.stepColorMode": [
    "none",
    "harness",
    "unique"
  ],
  "usageTracking.percentDirection": [
    "used",
    "remaining"
  ],
  "worktree": [
    false,
    true
  ],
  "worktree.mode": [
    "managed",
    "named"
  ]
};

/** Descriptions of oneOf/anyOf branches, keyed by property path, then by the literal that selects the branch. */
export const SCHEMA_VARIANT_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "_runtime.agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "_runtime.endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "_runtime.mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "defaults.agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "defaults.endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "defaults.mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "defaults.worktree": {
    "false": "No worktree: the workflow runs directly in the ordinary workspace checkout, sharing it with your own edits.",
    "true": "Managed-worktree shorthand.",
    "managed": "Managed creates a throw-away worktree and branch per run and removes the directory when the workflow completes, leaving the branch for review; pick it for isolated runs you will not follow up on.",
    "named": "Named targets a persistent worktree you own, which ctrlyoke never commits, merges, or removes; pick it for conversational workflows you will append to."
  },
  "endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "execution.maxPromptTimeoutSec": {
    "-1": "Unlimited."
  },
  "finalStep": {
    "script": "A workflow step that runs a shell script/command with no AI interaction."
  },
  "finalStep._runtime.agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "finalStep._runtime.endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "finalStep._runtime.mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "finalStep.agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "finalStep.endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "finalStep.mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "maxSteps": {
    "-1": "Unlimited."
  },
  "mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "queue.maxSteps": {
    "-1": "Unlimited."
  },
  "queue.maxWorkflowExecutionTimeSec": {
    "-1": "Unlimited."
  },
  "runs.maxRuns": {
    "-1": "Unlimited."
  },
  "steps[]": {
    "script": "A workflow step that runs a shell script/command with no AI interaction."
  },
  "steps[]._runtime.agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "steps[]._runtime.endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "steps[]._runtime.mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "steps[].agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "steps[].endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "steps[].mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "steps[].parallel[]": {
    "script": "A workflow step that runs a shell script/command with no AI interaction."
  },
  "steps[].parallel[]._runtime.agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "steps[].parallel[]._runtime.endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "steps[].parallel[]._runtime.mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "steps[].parallel[].agent": {
    "": "Empty string means no agent — the form the dashboard's \"None\" selection serializes to. Distinct from null, which explicitly disables an inherited agent."
  },
  "steps[].parallel[].endCondition.maxRetries": {
    "-1": "Unlimited."
  },
  "steps[].parallel[].mcpServers[]": {
    "ctrlyoke": "Configure the built-in ctrlyoke server. Omit deniedTools to enable all tools, or list bare tool names to disable selected tools."
  },
  "ui.outputVirtualizationRowThreshold": {
    "-1": "Unlimited."
  },
  "worktree": {
    "false": "No worktree: the workflow runs directly in the ordinary workspace checkout, sharing it with your own edits.",
    "true": "Managed-worktree shorthand.",
    "managed": "Managed creates a throw-away worktree and branch per run and removes the directory when the workflow completes, leaving the branch for review; pick it for isolated runs you will not follow up on.",
    "named": "Named targets a persistent worktree you own, which ctrlyoke never commits, merges, or removes; pick it for conversational workflows you will append to."
  }
};
