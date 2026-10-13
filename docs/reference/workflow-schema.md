---
description: "Every field a ctrlyoke workflow file accepts, generated from schemas/workflow-schema.json."
editLink: false
---

<!-- AUTO-GENERATED from the JSON schemas — edit the schema descriptions or docs/reference/_partials/, then run `npm run generate-schema-docs` -->

# Workflow schema reference

A workflow file is YAML, JSON, or a `.prompt.md` file. It is checked against
`schemas/workflow-schema.json`. A multi-step workflow looks like this:

```yaml
harness: claude-cli
model: sonnet
steps:
  - name: Review
    prompt: Review @src/ for error-handling gaps.
  - type: script
    script: npm test
finalStep:
  prompt: Summarize what changed.
```

A file with a single step can drop `steps` and put the prompt step or script
step fields at the root.

### How values are inherited

Most fields are [execution properties](#execution-properties). You can set
them in three places. When a field appears in more than one place, the most
specific one wins:

1. A step's own value.
2. The workflow root.
3. The matching [`defaults.*` setting](/reference/settings#defaults).

On most fields, `null` means "turn off what would be inherited". Omitting a
field means "inherit it". Where `null` is allowed, the field's accepted forms
say what it does.

| Section | Purpose |
| --- | --- |
| [Workflow file](#workflow-file) | Root fields of a multi-step workflow file. |
| [Execution properties](#execution-properties) | Shared execution configuration properties used across workflow-level defaults, prompt-level overrides, and runtime metadata |
| [Prompt step](#prompt-step) | A step that sends a prompt to a harness. |
| [Script step](#script-step) | A workflow step that runs a shell script/command with no AI interaction. |
| [Parallel group](#parallel-group) | An authored group of prompt or script steps. |
| [Pre-condition](#pre-condition) | Script gate that runs before the prompt. |
| [End condition](#end-condition) | Validation that runs after the prompt completes. |
| [Shared script fields](#script-fields) | Shared script execution properties used by endCondition, preCondition, and scriptStep. |
| [Error behavior](#error-behavior) | Policy for internal errors in any step phase, including pre-conditions, prompts/harnesses, end-conditions, and script steps. |
| [Prompt Markdown frontmatter](#prompt-file-frontmatter) | The optional YAML frontmatter block at the top of a `.prompt.md` file. |
| [Worktree](#worktree) | Where the workflow runs: the working checkout or a Git worktree. |
| [Variables](#vars) | Workflow-level variable defaults for <code v-pre>{{varName}}</code> substitution. |
| [Hook entry](#hook-entry) | One user-defined hook in a `hooks` array. |
| [MCP server entry](#mcp-server-entry) | User-defined MCP server configuration. |
| [Run address](#run-address) | Identifies one completed run for `priorContext` imports. |
| [Harness IDs](#harness-ids) | The harnesses a workflow or step can select. |
| [Template metadata](#template-metadata) | Authoring metadata for a reusable workflow template. |
| [Template variable](#template-variable) | One entry in `_templateMeta.variables`. |
| [Template placeholder](#template-placeholder) | A template variable placeholder such as {harness}. |

## Workflow file {#workflow-file}

Properties authored only at the workflow root.

### `steps` {#workflow-file-steps}

- **Type:** array of ([Prompt step](#prompt-step) or [Script step](#script-step) or [Parallel group](#parallel-group))
- **Required:** yes

The ordered step queue. Each item is a prompt step, a script step, or a parallel group.

### `finalStep` {#workflow-file-finalstep}

- **Type:** [Prompt step](#prompt-step) or [Script step](#script-step)

A step that always runs after all queued prompts complete. Can be an AI prompt or a script step. If mcpServers includes "ctrlyoke" and the finalStep appends prompts, those prompts run before finalStep executes again. Working files store resolved harness/model/session metadata on finalStep.\_runtime; workflow phase/status remains in the root \_runtime.finalStep block.

### `maxSteps` {#workflow-file-maxsteps}

- **Type:** `-1` or `integer`

Maximum number of entries in the run's `steps` array, regardless of who queued them, including parallel members and disabled steps. `finalStep` iterations and retries are not counted. Omit to inherit `queue.maxSteps`. `-1` means unlimited.

### `worktree` {#workflow-file-worktree}

- **Type:** [Worktree](#worktree)
- **Settings default:** [`defaults.worktree`](/reference/settings#defaults-worktree)

Run the workflow in the working checkout or in a Git worktree. When omitted, the `defaults.worktree` setting applies.

### `vars` {#workflow-file-vars}

- **Type:** [Variables](#vars)

Default values for <code v-pre>{{varName}}</code> substitutions.

### `trustedExternalRoots` {#workflow-file-trustedexternalroots}

- **Type:** `string[]` or `null`

Restricts, extends, or disables this workflow's external-root access relative to the user/workspace defaults. Omit this field entirely to inherit the live union of approved user + workspace permissions.trustedExternalRoots (today's behavior, unchanged). When set, the array REPLACES that inherited union rather than adding to it — it may contain brand-new roots this workflow alone needs (widening, without growing the user/workspace list for every other workflow) and/or a deliberately narrowed subset of already-trusted roots (restricting a risky workflow to less than the everyday default); either way every root in the array still needs its own one-time approval unless already approved at a broader scope.

Accepted forms:

- `string[]` — Absolute external directory roots this workflow is restricted to. REPLACES (does not add to) the workspace's approved permissions.trustedExternalRoots for this workflow's runs — a root already approved at user or workspace scope needs no separate approval, but this array is the complete set; roots trusted broadly but omitted here are not accessible to this workflow. Declaring a new root here only registers a request — it never grants access by itself. Before this workflow first runs (or is loaded in VS Code) with a newly declared root, a one-time batch approval is required: a VS Code prompt, or `ctrlyoke trust-workflow-external-roots <file>` for the standalone CLI. Execution fails closed until every declared root has a recorded decision for this workflow file's identity.
- `null` — Explicitly disables all external-root access for this workflow, regardless of user/workspace-scope trusted roots. Only workspace files are accessible. Use this to run a specific workflow with no external directories at all.

### `_templateMeta` {#workflow-file-templatemeta}

- **Type:** [Template metadata](#template-metadata)

Marks the file as a reusable template and describes its placeholders. Removed when the template is instantiated.

## Execution properties {#execution-properties}

Shared execution configuration properties used across workflow-level defaults, prompt-level overrides, and runtime metadata

### `harness` {#execution-properties-harness}

- **Type:** [Harness IDs](#harness-ids) or [Template placeholder](#template-placeholder)
- **Settings default:** [`defaults.harness`](/reference/settings#defaults-harness)

Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting.

### `model` {#execution-properties-model}

- **Type:** `string`

AI model to use for this prompt. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' (the None option) to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting.

### `executionMode` {#execution-properties-executionmode}

- **Type:** `"interactive" | "headless"`
- **Settings default:** [`defaults.executionMode`](/reference/settings#defaults-executionmode)

Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default.

### `agent` {#execution-properties-agent}

- **Type:** `string` or `""` or `null`
- **Settings default:** [`defaults.agent`](/reference/settings#defaults-agent)

Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in &lt;agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow.

Accepted forms:

- `string` matching `^[a-zA-Z0-9-_]+$`
- `""` — Empty string means no agent — the form the dashboard's "None" selection serializes to. Distinct from null, which explicitly disables an inherited agent.
- `null`

### `resumeSession` {#execution-properties-resumesession}

- **Type:** `boolean`
- **Settings default:** [`defaults.resumeSession`](/reference/settings#defaults-resumesession)

Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry.

### `mcpServers` {#execution-properties-mcpservers}

- **Type:** array of (`string` or `{ id: "ctrlyoke", deniedTools? }` or [MCP server entry](#mcp-server-entry)) or `null`
- **Settings default:** [`defaults.mcpServers`](/reference/settings#defaults-mcpservers)

MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include "ctrlyoke" to let the harness append steps through ctrlyoke's MCP server (a dynamic workflow). Use /mcp:&lt;server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers.

Accepted forms:

- array of (`string` or `{ id: "ctrlyoke", deniedTools? }` or [MCP server entry](#mcp-server-entry)) — MCP servers to attach. Registry IDs resolve against ctrlyoke's managed MCP registry; include "ctrlyoke" to let the harness append steps (a dynamic workflow).
- `null` — Explicitly disable inherited MCP servers.

Fields:

- `deniedTools` · `string[]`

### `hooks` {#execution-properties-hooks}

- **Type:** array of [Hook entry](#hook-entry) or `null`
- **Settings default:** [`defaults.hooks`](/reference/settings#defaults-hooks)

User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped.

Accepted forms:

- array of [Hook entry](#hook-entry) — User-defined hooks. A step's hooks replace the workflow's hooks for each event it defines; other workflow events inherit. A workflow's hooks array replaces defaults.hooks from settings entirely.
- `null` — Explicitly disables all hooks for this prompt/workflow.

### `sessionId` {#execution-properties-sessionid}

- **Type:** `string` or `integer`

Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value "finalStep" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution.

### `skills` {#execution-properties-skills}

- **Type:** `string[]` or `null`
- **Settings default:** [`defaults.skills`](/reference/settings#defaults-skills)

Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach.

### `secrets` {#execution-properties-secrets}

- **Type:** `string[]` or `null`
- **Settings default:** [`defaults.secrets`](/reference/settings#defaults-secrets)

Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants.

### `endCondition` {#execution-properties-endcondition}

- **Type:** [End condition](#end-condition) or `null`
- **Settings default:** [`defaults.endCondition`](/reference/settings#defaults-endcondition)

End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any).

### `preCondition` {#execution-properties-precondition}

- **Type:** [Pre-condition](#pre-condition) or `null`
- **Settings default:** [`defaults.preCondition`](/reference/settings#defaults-precondition)

Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition.

### `priorContext` {#execution-properties-priorcontext}

- **Type:** `"all" | "previous" | "none" | "finalStepAll" | "finalStepPrevious"` or `integer[]` or `{ previous }` or [Run address](#run-address)
- **Settings default:** [`defaults.priorContext`](/reference/settings#defaults-priorcontext)

Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).

Accepted forms:

- `"all" | "previous" | "none" | "finalStepAll" | "finalStepPrevious"` — Keyword shorthand: 'all' = all prior queue prompt outputs, 'previous' = immediately preceding queue prompt output, 'none' = no injection, 'finalStepAll' = all previous final-step pass outputs, 'finalStepPrevious' = immediately preceding final-step pass output
- `integer[]` — Specific prior prompt numbers to include (1-based, e.g. [1, 3] includes prompts 1 and 3)
- `{ previous }` — The last N queue prompt outputs before this prompt, oldest first (e.g. { previous: 3 }). Counted relative to the prompt, so it stays correct when steps are inserted or reordered. Like 'previous', steps that produced no output are skipped rather than counted; { previous: 1 } is the same as 'previous'. Inline equivalent: $previous:N.
- [Run address](#run-address) — Import all resolved queue and final-step output from one completed run in this same workspace.

### `priorContext.previous` {#execution-properties-priorcontext-previous}

- **Type:** `integer`
- **Required:** yes
- **Constraints:** minimum 1

How many of the most recent earlier outputs to include

### `priorContextDetail` {#execution-properties-priorcontextdetail}

- **Type:** `"full" | "summary"`
- **Default:** `"full"`

How much prior output to include. 'full' includes the complete bounded transcript; 'summary' includes the authored prompt head, changed files, and text tail. Resolves prompt → workflow. Inline $summary: references select summary for that reference.

### `additionalArgs` {#execution-properties-additionalargs}

- **Type:** `string` or `null`
- **Settings default:** [`defaults.additionalArgs`](/reference/settings#defaults-additionalargs)

Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: "--effort high --max-turns 10"

### `toolPermissions` {#execution-properties-toolpermissions}

- **Type:** `{ mode?, allowedTools?, deniedTools? }` or `null`
- **Settings default:** [`defaults.toolPermissions`](/reference/settings#defaults-toolpermissions)

Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'.

Accepted forms:

- `{ mode?, allowedTools?, deniedTools? }` — Per-workflow/prompt tool permission overrides. Follows three-tier precedence: prompt > workflow > the `defaults.toolPermissions` setting.
- `null`

### `toolPermissions.mode` {#execution-properties-toolpermissions-mode}

- **Type:** `"dangerouslyAllowAll" | "allowAll" | "custom" | "none"`

Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config).

### `toolPermissions.allowedTools` {#execution-properties-toolpermissions-allowedtools}

- **Type:** `string[]`

Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE\_CONFIG\_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses.

### `toolPermissions.deniedTools` {#execution-properties-toolpermissions-deniedtools}

- **Type:** `string[]`

Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE\_CONFIG\_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses.

### `errorBehavior` {#execution-properties-errorbehavior}

- **Type:** [Error behavior](#error-behavior) or `null`
- **Settings default:** [`defaults.errorBehavior`](/reference/settings#defaults-errorbehavior)

Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy.

## Prompt step {#prompt-step}

A step that sends a prompt to a harness.

Also includes every field from [Execution properties](#execution-properties).

### `type` {#prompt-step-type}

- **Type:** `"prompt"`

Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible).

### `name` {#prompt-step-name}

- **Type:** `string`
- **Constraints:** at most 100 characters

Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a truncated preview of the prompt text.

### `enabled` {#prompt-step-enabled}

- **Type:** `boolean`

Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution.

### `color` {#prompt-step-color}

- **Type:** `string`
- **Constraints:** pattern `^#[0-9a-fA-F]{6}$`

Optional authored identity colour for this step.

### `prompt` {#prompt-step-prompt}

- **Type:** `string`
- **Required:** yes

The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.&lt;kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.&lt;kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported.

### `_runtime` {#prompt-step-runtime}

- **Type:** [Step runtime](/reference/run-files#step-runtime)

Per-prompt runtime execution metadata (optional, added automatically during execution)

## Script step {#script-step}

A workflow step that runs a shell script/command with no AI interaction.

### `type` {#script-step-type}

- **Type:** `"script"`
- **Required:** yes

Step type discriminator. Required, and must be "script", for script steps.

### `name` {#script-step-name}

- **Type:** `string`
- **Constraints:** at most 100 characters

Optional display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows the script text.

### `enabled` {#script-step-enabled}

- **Type:** `boolean`

Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution.

### `color` {#script-step-color}

- **Type:** `string`
- **Constraints:** pattern `^#[0-9a-fA-F]{6}$`

Optional authored identity colour for this step.

### `executionMode` {#script-step-executionmode}

- **Type:** `"interactive" | "headless"`

Where this script step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow's executionMode, then the defaults.executionMode setting.

### `script` {#script-step-script}

- **Type:** `string`
- **Required:** yes

Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.

### `env` {#script-step-env}

- **Type:** map of `string`

Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.

### `compareSource` {#script-step-comparesource}

- **Type:** `"stdout" | "stderr" | "exitCode"`

Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.

### `timeoutSec` {#script-step-timeoutsec}

- **Type:** `number`

Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.

### `shell` {#script-step-shell}

- **Type:** `string`

Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. "pwsh", "bash", "cmd". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.

### `errorBehavior` {#script-step-errorbehavior}

- **Type:** [Error behavior](#error-behavior) or `null`

Internal-error policy for this script step when it cannot run or evaluation breaks. Use null to explicitly disable an inherited workflow policy.

### `secrets` {#script-step-secrets}

- **Type:** `string[]` or `null`

Secret environment-variable names granted to this script step. Use null to explicitly disable an inherited grant array.

### `onPass` {#script-step-onpass}

- **Type:** `"continue" | "stopWorkflow"`
- **Default:** `"continue"`

What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately.

### `onFail` {#script-step-onfail}

- **Type:** `"continue" | "stopWorkflow"`
- **Default:** `"stopWorkflow"`

What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default).

### `_runtime` {#script-step-runtime}

- **Type:** [Step runtime](/reference/run-files#step-runtime)

Per-step runtime execution metadata (optional, added automatically during execution)

### `operator` {#script-step-operator}

- **Type:** `"eq" | "ne" | "contains" | "notContains" | "gte" | "gt" | "lte" | "lt" | "matches" | "isEmpty" | "isNotEmpty"`

How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.

### `expected` {#script-step-expected}

- **Type:** `string` or `number`

Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.

### `ignoreCase` {#script-step-ignorecase}

- **Type:** `boolean`

Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.

### `returns` {#script-step-returns}

- **Type:** removed

Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.

## Parallel group {#parallel-group}

An authored group of prompt or script steps. Groups are flattened into steps plus parallelGroups when loaded. Members share the workflow's workspace and its one managed or named worktree; ctrlyoke does not isolate members or merge their work, so give each member independent work. The `queue.maxParallelSteps` setting caps how many members run at once. Groups cannot be nested, and finalStep cannot be a group. A numeric priorContext or sessionId in a member cannot point at another member of the same group, and two members cannot resolve to the same harness session. Members may use the built-in ctrlyoke MCP server.

```yaml
steps:
  - parallel:
      - name: inspect-api
        prompt: Inspect the API surface.
      - name: inspect-ui
        prompt: Inspect the dashboard surface.
    failFast: true
```

See [Dynamic workflows: parallel groups](/workflows/dynamic-workflows#parallel-groups) for what a
member can do through the `ctrlyoke` MCP server.

### `parallel` {#parallel-group-parallel}

- **Type:** array of ([Prompt step](#prompt-step) or [Script step](#script-step))
- **Required:** yes
- **Constraints:** at least 2 item(s)

The prompt or script steps that run concurrently. Groups cannot be nested.

### `failFast` {#parallel-group-failfast}

- **Type:** `boolean`
- **Default:** `true`

Stop the remaining members as soon as one member fails. Default: true.

## Pre-condition {#pre-condition}

Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow.

Also includes every field from [Shared script fields](#script-fields).

### `script` {#pre-condition-script}

- **Type:** `string`
- **Required:** yes

Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.

### `env` {#pre-condition-env}

- **Type:** map of `string`

Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.

### `compareSource` {#pre-condition-comparesource}

- **Type:** `"stdout" | "stderr" | "exitCode"`

Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.

### `returns` {#pre-condition-returns}

- **Type:** removed

Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.

### `timeoutSec` {#pre-condition-timeoutsec}

- **Type:** `number`

Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.

### `shell` {#pre-condition-shell}

- **Type:** `string`

Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. "pwsh", "bash", "cmd". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.

### `operator` {#pre-condition-operator}

- **Type:** `"eq" | "ne" | "contains" | "notContains" | "gte" | "gt" | "lte" | "lt" | "matches" | "isEmpty" | "isNotEmpty"`

How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.

### `expected` {#pre-condition-expected}

- **Type:** `string` or `number`

Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.

### `ignoreCase` {#pre-condition-ignorecase}

- **Type:** `boolean`

Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.

### `onPass` {#pre-condition-onpass}

- **Type:** `"continue" | "skipPrompt" | "stopWorkflow"`
- **Default:** `"continue"`

What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution.

### `onFail` {#pre-condition-onfail}

- **Type:** `"continue" | "skipPrompt" | "stopWorkflow"`
- **Default:** `"skipPrompt"`

What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution.

## End condition {#end-condition}

Validation that runs after the prompt completes. Shares script/env/compareSource/operator/expected/timeoutSec with preCondition and scriptStep via scriptProperties.

Also includes every field from [Shared script fields](#script-fields).

### `script` {#end-condition-script}

- **Type:** `string`
- **Required:** yes

Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.

### `env` {#end-condition-env}

- **Type:** map of `string`

Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.

### `compareSource` {#end-condition-comparesource}

- **Type:** `"stdout" | "stderr" | "exitCode"`

Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.

### `returns` {#end-condition-returns}

- **Type:** removed

Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.

### `timeoutSec` {#end-condition-timeoutsec}

- **Type:** `number`

Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.

### `shell` {#end-condition-shell}

- **Type:** `string`

Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. "pwsh", "bash", "cmd". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.

### `operator` {#end-condition-operator}

- **Type:** `"eq" | "ne" | "contains" | "notContains" | "gte" | "gt" | "lte" | "lt" | "matches" | "isEmpty" | "isNotEmpty"`

How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.

### `expected` {#end-condition-expected}

- **Type:** `string` or `number`

Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.

### `ignoreCase` {#end-condition-ignorecase}

- **Type:** `boolean`

Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.

### `maxRetries` {#end-condition-maxretries}

- **Type:** `-1` or `integer`

Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed.

### `retryPrompt` {#end-condition-retryprompt}

- **Type:** `string`

Template for retry prompt. Supports $preCondition:&lt;field> and $endCondition:&lt;field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:\* works in the step and retry prompts; $endCondition:\* is only available in the retry prompt.

### `passRetryPrompt` {#end-condition-passretryprompt}

- **Type:** `string`

Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:&lt;field> and $endCondition:&lt;field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent.

### `resumeSessionOnRetry` {#end-condition-resumesessiononretry}

- **Type:** `boolean`

Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry.

### `onPass` {#end-condition-onpass}

- **Type:** `"continue" | "retry" | "stopWorkflow"`
- **Default:** `"continue"`

What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately.

### `onFail` {#end-condition-onfail}

- **Type:** `"continue" | "retry" | "stopWorkflow"`
- **Default:** `"stopWorkflow"`

What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry.

## Shared script fields {#script-fields}

Shared script execution properties used by endCondition, preCondition, and scriptStep.

### `script` {#script-fields-script}

- **Type:** `string`
- **Required:** yes

Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`.

### `env` {#script-fields-env}

- **Type:** map of `string`

Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values.

### `compareSource` {#script-fields-comparesource}

- **Type:** `"stdout" | "stderr" | "exitCode"`

Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison.

### `returns` {#script-fields-returns}

- **Type:** removed

Removed — renamed to `expected`, and 'true'/'false' are no longer mapped onto exit codes. Omit it entirely to pass on exit code 0.

### `timeoutSec` {#script-fields-timeoutsec}

- **Type:** `number`

Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies.

### `shell` {#script-fields-shell}

- **Type:** `string`

Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. "pwsh", "bash", "cmd". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted.

### `operator` {#script-fields-operator}

- **Type:** `"eq" | "ne" | "contains" | "notContains" | "gte" | "gt" | "lte" | "lt" | "matches" | "isEmpty" | "isNotEmpty"`

How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.

### `expected` {#script-fields-expected}

- **Type:** `string` or `number`

Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow.

### `ignoreCase` {#script-fields-ignorecase}

- **Type:** `boolean`

Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false.

## Error behavior {#error-behavior}

Policy for internal errors in any step phase, including pre-conditions, prompts/harnesses, end-conditions, and script steps. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture.

### `onError` {#error-behavior-onerror}

- **Type:** `"stopWorkflow" | "retry" | "continue"`
- **Required:** yes

What to do when a step phase cannot run or otherwise encounters an internal error.

### `maxRetries` {#error-behavior-maxretries}

- **Type:** `integer`
- **Constraints:** minimum 1

Maximum retry attempts when onError is retry. When omitted, one retry is allowed.

### `retryDelaySec` {#error-behavior-retrydelaysec}

- **Type:** `number`

Delay before retrying, in seconds.

## Prompt Markdown frontmatter {#prompt-file-frontmatter}

The optional YAML frontmatter block at the top of a `.prompt.md` file. ctrlyoke reads only the fields listed here and ignores any other key, so a prompt file written for another tool (for example a GitHub Copilot prompt file with `model`, `tools` or `agent`) still loads. The block is never sent to the harness, whether the file runs on its own or a step's `prompt` names it.

### `schemaVersion` {#prompt-file-frontmatter-schemaversion}

- **Type:** `integer`
- **Constraints:** minimum 1

Workflow definition format version. Absent means format 1. An older ctrlyoke refuses to load a file with a newer version.

### `description` {#prompt-file-frontmatter-description}

- **Type:** `string`

Short summary of the prompt. When the file runs on its own, it becomes the step's `name` in the dashboard (cut to 100 characters). It is display metadata only and is never sent to the harness.

## Worktree {#worktree}

Where the workflow runs: the working checkout or a Git worktree.

- **Type:** `false` or `true` or `string` or `{ mode: "managed", merge?, keep?, … }` or `{ mode: "named", branch, base?, … }`

Accepted forms:

- `false` — No worktree: the workflow runs directly in the ordinary workspace checkout, sharing it with your own edits.
- `true` — Managed-worktree shorthand.
- `string` — Named-worktree branch shorthand. The value must be a valid local Git branch name.
- `{ mode: "managed", merge?, keep?, … }` — Managed creates a throw-away worktree and branch per run and removes the directory when the workflow completes, leaving the branch for review; pick it for isolated runs you will not follow up on.
- `{ mode: "named", branch, base?, … }` — Named targets a persistent worktree you own, which ctrlyoke never commits, merges, or removes; pick it for conversational workflows you will append to.

**When `mode` is `"managed"`:**

### `worktree.merge` {#worktree-managed-merge}

- **Type:** `boolean`

Merge the managed branch into the captured source checkout after the run.

### `worktree.keep` {#worktree-managed-keep}

- **Type:** `boolean`

Keeps the managed worktree directory after the run instead of removing it. Without it, appending a follow-up prompt recreates the directory from the branch; ignored files such as node\_modules are gone and the setup command runs again, so a long setup pays that cost on every append. Removing the directory also ends filesystem undo for that run.

### `worktree.base` {#worktree-managed-base}

- **Type:** `string`
- **Constraints:** at least 1 character(s)

Optional Git ref resolved to a commit when the worktree is created.

### `worktree.setup` {#worktree-managed-setup}

- **Type:** `string`

Optional setup command run after a new managed worktree is created. Setup is outside the step-scoped errorBehavior policy: it runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run re-runs it; a succeeded outcome is skipped.

**When `mode` is `"named"`:**

### `worktree.branch` {#worktree-named-branch}

- **Type:** `string`
- **Required:** yes
- **Constraints:** at least 1 character(s)

Local Git branch name for the named worktree.

### `worktree.base` {#worktree-named-base}

- **Type:** `string`
- **Constraints:** at least 1 character(s)

Optional Git ref resolved to a commit when the worktree is created.

### `worktree.setup` {#worktree-named-setup}

- **Type:** `string`

Optional setup command run after a new named worktree is created. Setup is outside the step-scoped errorBehavior policy: it runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run re-runs it; a succeeded outcome is skipped.

## Variables {#vars}

Workflow-level variable defaults for <code v-pre>{{varName}}</code> substitution. CLI --var key=value flags override these at runtime. Substituted into: prompt text, model, additionalArgs, hook command/env, preCondition script/env, endCondition script/env/retryPrompt/passRetryPrompt, script-step script/env, and worktree setup commands. Every script and condition process also receives each var as a CTRLYOKE\_VAR\_&lt;KEY> environment variable regardless of <code v-pre>{{varName}}</code> usage. A value containing `${secret:` causes the step to fail before execution so vars cannot manufacture managed-secret references.

- **Type:** map of `string`

## Hook entry {#hook-entry}

One user-defined hook in a `hooks` array.

### `event` {#hook-entry-event}

- **Type:** `"stop" | "sessionStart" | "preToolUse" | "postToolUse" | "userPromptSubmit" | "permissionRequest" | "notification" | "error"`
- **Required:** yes

Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), Stop (Codex), agentStop (Copilot). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode.

### `command` {#hook-entry-command}

- **Type:** `string`
- **Required:** yes

Command to execute. Resolved relative to workspace root if not absolute.

### `env` {#hook-entry-env}

- **Type:** map of `string`

Each hook receives only its own env values, merged over the harness environment when it runs. These values are not added to the harness process environment, but are written to a per-step temp file readable by the local user, so they are not hidden from a model with shell access. Secret references are allowed only as ${secret:NAME} values.

### `timeoutSec` {#hook-entry-timeoutsec}

- **Type:** `integer`
- **Constraints:** minimum 1

Maximum time a user hook may run, in seconds. Applied by Copilot, Claude Code, Codex, Qwen Code, Antigravity, and OpenCode; harnesses that do not support per-hook timeouts use their own limit.

## MCP server entry {#mcp-server-entry}

User-defined MCP server configuration. Exactly one of `command` (stdio) or `url` (remote) must be set. The built-in `ctrlyoke` server is configured by its ID and can use `deniedTools` to disable selected built-in tools.

### `id` {#mcp-server-entry-id}

- **Type:** `string`
- **Required:** yes

Unique server identifier

### `description` {#mcp-server-entry-description}

- **Type:** `string`

Human-readable description shown in MCP Manager. ctrlyoke-only metadata — deliberately omitted by every harness export path so it never leaks an unrecognized key into an external tool's native config file.

### `command` {#mcp-server-entry-command}

- **Type:** `string`

Command to run the MCP server process (stdio servers, e.g. "npx" or "node")

### `args` {#mcp-server-entry-args}

- **Type:** `string[]`

Arguments to pass to the command (stdio servers only)

### `env` {#mcp-server-entry-env}

- **Type:** map of `string`

Environment variables for the server process (stdio servers only)

### `autoApprove` {#mcp-server-entry-autoapprove}

- **Type:** `boolean` or `string[]`

Tools to auto-approve: true = all tools, string[] = specific tools

### `url` {#mcp-server-entry-url}

- **Type:** `string`

Remote endpoint URL for streamable-http or SSE servers (e.g. "https://mcp.example.com")

### `transport` {#mcp-server-entry-transport}

- **Type:** `"streamable-http" | "sse"`

Transport protocol for remote servers. Defaults to "streamable-http".

### `headers` {#mcp-server-entry-headers}

- **Type:** map of `string`

HTTP headers to send with every request (remote servers only, e.g. { "Authorization": "Bearer token" }). Secret references are allowed as ${secret:NAME} values.

### `deniedTools` {#mcp-server-entry-deniedtools}

- **Type:** `string[]`

Tool names from this server to deny at execution time. Use bare tool names without the mcp\_\_&lt;serverid>\_\_ prefix (e.g. ["append\_step"]). Translated to mcp\_\_&lt;id>\_\_&lt;tool> deny patterns and merged into the harness permission args. Supported on harnesses that accept tool deny patterns.

## Run address {#run-address}

Identifies one completed run for `priorContext` imports.

### `workflowKey` {#run-address-workflowkey}

- **Type:** `string`
- **Required:** yes
- **Constraints:** at least 1 character(s) · pattern `^(?!\.{1,2}$)[^/\\]+$`

Stable workflow lineage key within the current workspace.

### `runRef` {#run-address-runref}

- **Type:** `string`
- **Required:** yes
- **Constraints:** pattern `^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$`

Stable completed-run reference within workflowKey.

## Harness IDs {#harness-ids}

The harnesses a workflow or step can select.

- **Type:** `"copilot-cli" | "claude-cli" | "codex-cli" | "opencode-cli" | "qwen-cli" | "antigravity-cli"`

## Template metadata {#template-metadata}

Authoring metadata for a reusable workflow template. Removed when the template is instantiated.

### `name` {#template-metadata-name}

- **Type:** `string`

Display name shown in the template picker.

### `description` {#template-metadata-description}

- **Type:** `string`

Short explanation shown in the template picker.

### `variables` {#template-metadata-variables}

- **Type:** map of [Template variable](#template-variable)

Metadata for placeholders used by this template, keyed by variable name.

## Template variable {#template-variable}

One entry in `_templateMeta.variables`.

### `type` {#template-variable-type}

- **Type:** `"text" | "file" | "directory" | "select" | "harness" | "model"`

Control used to collect this variable in the template dialog. A `model` variable shows the models of the harness variable named by `harness`, beside that harness picker.

### `harness` {#template-variable-harness}

- **Type:** `string`
- **Constraints:** pattern `^[a-z][a-zA-Z0-9]*$`

For a `model` variable: the name of the `harness` variable whose models it offers. Changing that harness resets this model to the harness's default model.

### `fileFilter` {#template-variable-filefilter}

- **Type:** `string[]`

File-picker glob patterns used by file variables.

### `options` {#template-variable-options}

- **Type:** `string[]`
- **Constraints:** at least 1 item(s)

Available values for a select variable.

### `autoFillFilename` {#template-variable-autofillfilename}

- **Type:** `boolean`

Use the selected file or directory basename as the initial workflow name.

### `description` {#template-variable-description}

- **Type:** `string`

Help text shown below the variable control.

### `default` {#template-variable-default}

- **Type:** `string`

Initial value used when the user leaves the variable unchanged.

### `multiline` {#template-variable-multiline}

- **Type:** `boolean`

Render a text variable as a multiline input.

### `required` {#template-variable-required}

- **Type:** `boolean`

Require a non-blank value for this variable before creating a workflow.

## Template placeholder {#template-placeholder}

A template variable placeholder such as {harness}. Only accepted in authoring files that declare \_templateMeta.

- **Type:** `string`
- **Constraints:** pattern `^\{[a-z][a-zA-Z0-9]*\}$`
