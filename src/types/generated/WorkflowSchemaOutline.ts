// AUTO-GENERATED from schemas/workflow-schema.json by scripts/generate-workflow-schema-outline.mjs. Do not edit by hand.

import type { WorkflowObjectKind } from "../DashboardConstants";

/** Value kinds a schema property can take; `oneOf` lists them in `alternatives`. */
export type WorkflowOutlineValueKind =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "oneOf";

export interface WorkflowOutlineProperty {
  readonly valueKind: WorkflowOutlineValueKind;
  /** The kinds accepted when `valueKind` is `oneOf`. */
  readonly alternatives?: readonly Exclude<WorkflowOutlineValueKind, "oneOf">[];
  /**
   * Literal values to suggest. Not always a closed set: with `oneOf` a literal
   * can sit beside a free-form kind (`maxSteps` is `-1` or any number), so
   * never validate against it.
   */
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: string | number | boolean | null;
  readonly description?: string;
  readonly deprecated?: true;
}

export interface WorkflowObjectOutline {
  /** Authorable keys, in schema order. Runtime-only fields are excluded. */
  readonly properties: Readonly<Record<string, WorkflowOutlineProperty>>;
  /** Keys the schema forbids in this object (e.g. `worktree` on a step). */
  readonly forbiddenKeys: readonly string[];
}

export const WORKFLOW_SCHEMA_OUTLINE: Readonly<
  Partial<Record<WorkflowObjectKind, WorkflowObjectOutline>>
> = {
  "workflowRoot": {
    "properties": {
      "$schema": {
        "valueKind": "string",
        "description": "Schema URL used by JSON-aware editors for validation and completion."
      },
      "schemaVersion": {
        "valueKind": "number",
        "description": "Workflow definition format version. Absent means format 1. ctrlyoke stamps this field when it writes workflow files; older ctrlyoke versions refuse to open a newer format. Not substituted: This structural field or identity value stays as authored."
      },
      "_templateMeta": {
        "valueKind": "object",
        "description": "Marks the file as a reusable template and describes its placeholders. Removed when the template is instantiated. Not substituted: This structural field or identity value stays as authored."
      },
      "harness": {
        "valueKind": "string",
        "enum": [
          "copilot-cli",
          "claude-cli",
          "codex-cli",
          "opencode-cli",
          "qwen-cli",
          "antigravity-cli"
        ],
        "description": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting."
      },
      "model": {
        "valueKind": "string",
        "description": "AI model to use for this prompt. Model IDs are harness-specific, so a workflow-level model applies only to steps that run on the workflow's harness; a step on another harness that omits model uses that harness's defaults.models setting. Some harnesses replace a model they don't support with their default and log a warning, while others pass it through and the harness CLI may reject it. 'none' (None (harness default) in the dashboard) passes no model flag, so the harness CLI uses its own configured default model; it is also the out-of-the-box defaults.models value for every harness. Use it as well when you pass the model yourself in additionalArgs (e.g. a custom Bedrock model string). Optional - defaults to the harness's defaults.models setting."
      },
      "executionMode": {
        "valueKind": "string",
        "enum": [
          "interactive",
          "headless"
        ],
        "description": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "agent": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "resumeSession": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Whether this step continues an earlier step's conversation instead of starting a new session. When omitted, a step inherits the workflow's value and a workflow inherits the `defaults.resumeSession` setting (default: true). Without a sessionId, a resuming step continues the most recent earlier step on the same harness, skipping steps that ran on other harnesses; the first step always starts a new session. Set false where each step must start fresh, such as orchestrated loops whose steps are self-contained. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "mcpServers": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to let the harness append steps through ctrlyoke's MCP server (a dynamic workflow). Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers. Not substituted: Entries launch programs and carry authored secret grants."
      },
      "hooks": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped."
      },
      "sessionId": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "skills": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "secrets": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants. Not substituted: Secret grant approval is keyed to authored grant names."
      },
      "endCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any)."
      },
      "preCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition."
      },
      "priorContext": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "array",
          "object"
        ],
        "enum": [
          "all",
          "previous",
          "none",
          "finalStepAll",
          "finalStepPrevious"
        ],
        "description": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior queue prompt outputs; 'previous' injects the immediately preceding queue prompt output; 'none' disables injection; 'finalStepAll' injects all previous final-step pass outputs; 'finalStepPrevious' injects the immediately preceding final-step pass output; { previous: N } injects the last N queue outputs before this prompt; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflow, run? } imports resolved output from a completed run of another workflow in this workspace. 'workflow' accepts the workflow's name, workflow key, or key without its timestamp suffix; 'run' is an optional run number or stable run reference. When 'run' is omitted, the workflow's latest completed run is used. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation). Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "priorContextDetail": {
        "valueKind": "string",
        "enum": [
          "full",
          "summary"
        ],
        "default": "full",
        "description": "How much prior output to include. 'full' includes the complete bounded transcript; 'summary' includes the authored prompt head, changed files, and text tail. Resolves prompt → workflow. Inline :summary references ($previous:summary, $step:summary:1,3) select summary for that reference. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "additionalArgs": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). Flags are harness-specific, so workflow-level additionalArgs apply only to steps that run on the workflow's harness; a step on another harness that omits additionalArgs uses that harness's defaults.additionalArgs setting. On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\""
      },
      "toolPermissions": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'. Not substituted: Permission posture must match the reviewed value."
      },
      "sandbox": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "null"
        ],
        "description": "Terminal-command containment, separate from tool approval. `true` turns the harness's sandbox on: terminal commands may write only what `sandboxMode` allows. `false` (the shipped `defaults.sandbox`) turns the harness's sandbox off, overriding a sandbox you enabled in the harness's own settings: Codex gets `-s danger-full-access`, Claude Code `sandbox.enabled: false`, Copilot CLI `--no-sandbox` and Qwen Code `--sandbox=false` with `QWEN_SANDBOX=false`; Antigravity CLI and OpenCode have nothing to turn off. An organization or managed policy that forces a sandbox still wins. `null` (None) passes no sandbox flags, so the harness's own settings apply; with `toolPermissions` mode `none` it hands both axes to the harness. When absent, inherits the workflow, then `defaults.sandbox`. Network access, harness file tools and MCP servers follow each harness's own sandbox policy. Only Codex CLI and Claude Code support `true`: on Copilot CLI, Antigravity CLI, Qwen Code and OpenCode a `true` written in the workflow or step fails the step at launch, while one inherited from `defaults.sandbox` is skipped with a warning and the harness's own settings apply. Not substituted: Permission posture must match the reviewed value."
      },
      "sandboxMode": {
        "valueKind": "string",
        "enum": [
          "workspace-write",
          "read-only"
        ],
        "description": "How strict `sandbox: true` is. `workspace-write` (the default) lets terminal commands write the workspace roots, approved external roots, temp directories and the harness's own caches. `read-only` lets them write none of the workspace: Codex runs `-s read-only` (which also covers its file edits), and Claude Code denies Bash writes to the workspace roots, while its built-in Write and Edit tools still follow tool permissions. Has no effect unless `sandbox` resolves to `true`. Resolves step → workflow → the `defaults.sandboxMode` setting. Not substituted: Permission posture must match the reviewed value."
      },
      "errorBehavior": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy."
      },
      "type": {
        "valueKind": "string",
        "enum": [
          "prompt",
          "script",
          "workflow"
        ],
        "description": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible). Not substituted: This structural field or identity value stays as authored."
      },
      "prompt": {
        "valueKind": "string",
        "description": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported."
      },
      "name": {
        "valueKind": "string",
        "description": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a preview of the step's prompt or script text. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "enabled": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Whether this step executes. A whole-value {{name}} placeholder is coerced to boolean and validated at run start."
      },
      "color": {
        "valueKind": "string",
        "description": "Optional authored identity colour for this step. Not substituted: This structural field or identity value stays as authored."
      },
      "maxSteps": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "enum": [
          -1
        ],
        "description": "Maximum number of entries in the run steps array. A whole-value {{name}} placeholder is coerced and validated at run start."
      },
      "worktree": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string",
          "object"
        ],
        "enum": [
          false,
          true
        ],
        "description": "Run the workflow in the working checkout or in a Git worktree. When omitted, the `defaults.worktree` setting applies."
      },
      "vars": {
        "valueKind": "object",
        "description": "Default values for `{{varName}}` substitutions. Not substituted: Variables are not recursively expanded."
      },
      "conditions": {
        "valueKind": "object",
        "description": "Named condition presets that MCP agents may attach to steps by name. Authors define every script; MCP agents can choose a preset but can never supply or override its scripts. Preset scripts that use declared params must quote each value (for example, `\"$BUG_FILE\"`) because values are passed through environment variables. A param name may not collide with a key in that preset's own `env`. Not substituted: Preset definitions and parameter names are author-only contracts."
      },
      "trustedExternalRoots": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Restricts, extends, or disables this workflow's external-root access relative to the user/workspace defaults. Omit this field entirely to inherit the live union of approved user + workspace permissions.trustedExternalRoots (today's behavior, unchanged). When set, the array REPLACES that inherited union rather than adding to it — it may contain brand-new roots this workflow alone needs (widening, without growing the user/workspace list for every other workflow) and/or a deliberately narrowed subset of already-trusted roots (restricting a risky workflow to less than the everyday default); either way every root in the array still needs its own one-time approval unless already approved at a broader scope. These roots bound where terminal commands can write only while `sandbox` resolves to true (they become the sandbox's extra writable roots, none under `sandboxMode: read-only`); with the sandbox off or None they limit the directories given to ctrlyoke and the harness's file tools, not what a shell command can reach. Not substituted: Approval is keyed to the authored value."
      },
      "script": {
        "valueKind": "string",
        "description": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`."
      },
      "env": {
        "valueKind": "object",
        "description": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values."
      },
      "compareSource": {
        "valueKind": "string",
        "enum": [
          "stdout",
          "stderr",
          "exitCode"
        ],
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "timeoutSec": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "onPass": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "continue",
        "description": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "stopWorkflow",
        "description": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default). A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "operator": {
        "valueKind": "string",
        "enum": [
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Every `matches` comparison runs in a worker bounded by `execution.regexTimeoutSec`; a timeout is an evaluation error handled by `errorBehavior`. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "ignoreCase": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "workflow": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "object"
        ],
        "description": "A workflow file path (not variable-substituted in v1), or an inline single prompt or script step."
      },
      "steps": {
        "valueKind": "array",
        "description": "The ordered step queue. Each item is a prompt step, a script step, or a parallel group."
      },
      "finalStep": {
        "valueKind": "object",
        "description": "A step that always runs after all queued prompts complete. Can be an AI prompt or a script step. If mcpServers includes \"ctrlyoke\" and the finalStep appends prompts, those prompts run before finalStep executes again. Working files store resolved harness/model/session metadata on finalStep._runtime; workflow phase/status remains in the root _runtime.finalStep block."
      }
    },
    "forbiddenKeys": [
      "returns"
    ]
  },
  "promptStep": {
    "properties": {
      "harness": {
        "valueKind": "string",
        "enum": [
          "copilot-cli",
          "claude-cli",
          "codex-cli",
          "opencode-cli",
          "qwen-cli",
          "antigravity-cli"
        ],
        "description": "Harness to use for this prompt. Determines which AI CLI executes the prompt. Optional - defaults to the `defaults.harness` setting."
      },
      "model": {
        "valueKind": "string",
        "description": "AI model to use for this prompt. Model IDs are harness-specific, so a workflow-level model applies only to steps that run on the workflow's harness; a step on another harness that omits model uses that harness's defaults.models setting. Some harnesses replace a model they don't support with their default and log a warning, while others pass it through and the harness CLI may reject it. 'none' (None (harness default) in the dashboard) passes no model flag, so the harness CLI uses its own configured default model; it is also the out-of-the-box defaults.models value for every harness. Use it as well when you pass the model yourself in additionalArgs (e.g. a custom Bedrock model string). Optional - defaults to the harness's defaults.models setting."
      },
      "executionMode": {
        "valueKind": "string",
        "enum": [
          "interactive",
          "headless"
        ],
        "description": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "agent": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. On a step, null (None in the step properties) disables the agent inherited from the workflow. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "resumeSession": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Whether this step continues an earlier step's conversation instead of starting a new session. When omitted, a step inherits the workflow's value and a workflow inherits the `defaults.resumeSession` setting (default: true). Without a sessionId, a resuming step continues the most recent earlier step on the same harness, skipping steps that ran on other harnesses; the first step always starts a new session. Set false where each step must start fresh, such as orchestrated loops whose steps are self-contained. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "mcpServers": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to let the harness append steps through ctrlyoke's MCP server (a dynamic workflow). Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers. Not substituted: Entries launch programs and carry authored secret grants."
      },
      "hooks": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "User-defined hooks run alongside ctrlyoke's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped."
      },
      "sessionId": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "skills": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). On a step, null (None in the step properties) disables inherited workflow skills; skills declared by the selected agent still attach. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "secrets": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants. Not substituted: Secret grant approval is keyed to authored grant names."
      },
      "endCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "End condition validation to run after this prompt completes. On a step, null (None in the step properties) disables the inherited workflow end condition, even if the workflow defines one. Omitting this field inherits the workflow-level end condition (if any)."
      },
      "preCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. On a step, null (None in the step properties) disables an inherited pre-condition."
      },
      "priorContext": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "array",
          "object"
        ],
        "enum": [
          "all",
          "previous",
          "none",
          "finalStepAll",
          "finalStepPrevious"
        ],
        "description": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior queue prompt outputs; 'previous' injects the immediately preceding queue prompt output; 'none' disables injection; 'finalStepAll' injects all previous final-step pass outputs; 'finalStepPrevious' injects the immediately preceding final-step pass output; { previous: N } injects the last N queue outputs before this prompt; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflow, run? } imports resolved output from a completed run of another workflow in this workspace. 'workflow' accepts the workflow's name, workflow key, or key without its timestamp suffix; 'run' is an optional run number or stable run reference. When 'run' is omitted, the workflow's latest completed run is used. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation). Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "priorContextDetail": {
        "valueKind": "string",
        "enum": [
          "full",
          "summary"
        ],
        "default": "full",
        "description": "How much prior output to include. 'full' includes the complete bounded transcript; 'summary' includes the authored prompt head, changed files, and text tail. Resolves prompt → workflow. Inline :summary references ($previous:summary, $step:summary:1,3) select summary for that reference. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "additionalArgs": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). Flags are harness-specific, so workflow-level additionalArgs apply only to steps that run on the workflow's harness; a step on another harness that omits additionalArgs uses that harness's defaults.additionalArgs setting. On a step, null (None in the step properties) disables additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\""
      },
      "toolPermissions": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'. Not substituted: Permission posture must match the reviewed value."
      },
      "sandbox": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "null"
        ],
        "description": "Terminal-command containment, separate from tool approval. `true` turns the harness's sandbox on: terminal commands may write only what `sandboxMode` allows. `false` (the shipped `defaults.sandbox`) turns the harness's sandbox off, overriding a sandbox you enabled in the harness's own settings: Codex gets `-s danger-full-access`, Claude Code `sandbox.enabled: false`, Copilot CLI `--no-sandbox` and Qwen Code `--sandbox=false` with `QWEN_SANDBOX=false`; Antigravity CLI and OpenCode have nothing to turn off. An organization or managed policy that forces a sandbox still wins. `null` (None) passes no sandbox flags, so the harness's own settings apply; with `toolPermissions` mode `none` it hands both axes to the harness. When absent, inherits the workflow, then `defaults.sandbox`. Network access, harness file tools and MCP servers follow each harness's own sandbox policy. Only Codex CLI and Claude Code support `true`: on Copilot CLI, Antigravity CLI, Qwen Code and OpenCode a `true` written in the workflow or step fails the step at launch, while one inherited from `defaults.sandbox` is skipped with a warning and the harness's own settings apply. Not substituted: Permission posture must match the reviewed value."
      },
      "sandboxMode": {
        "valueKind": "string",
        "enum": [
          "workspace-write",
          "read-only"
        ],
        "description": "How strict `sandbox: true` is. `workspace-write` (the default) lets terminal commands write the workspace roots, approved external roots, temp directories and the harness's own caches. `read-only` lets them write none of the workspace: Codex runs `-s read-only` (which also covers its file edits), and Claude Code denies Bash writes to the workspace roots, while its built-in Write and Edit tools still follow tool permissions. Has no effect unless `sandbox` resolves to `true`. Resolves step → workflow → the `defaults.sandboxMode` setting. Not substituted: Permission posture must match the reviewed value."
      },
      "errorBehavior": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Internal-error policy for every step phase: pre-conditions, prompts/harnesses, end-conditions, and script steps. Resolves prompt → workflow → the `defaults.errorBehavior` setting. Worktree setup is outside this policy: setup runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run is the recovery gesture. Use null to explicitly disable an inherited policy."
      },
      "type": {
        "valueKind": "string",
        "enum": [
          "prompt"
        ],
        "description": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible). Not substituted: This structural field or identity value stays as authored."
      },
      "prompt": {
        "valueKind": "string",
        "description": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported."
      },
      "name": {
        "valueKind": "string",
        "description": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a preview of the step's prompt or script text. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "enabled": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Whether this step executes. A whole-value {{name}} placeholder is coerced to boolean and validated at run start."
      },
      "color": {
        "valueKind": "string",
        "description": "Optional authored identity colour for this step. Not substituted: This structural field or identity value stays as authored."
      }
    },
    "forbiddenKeys": [
      "maxSteps",
      "script",
      "trustedExternalRoots",
      "worktree"
    ]
  },
  "scriptStep": {
    "properties": {
      "type": {
        "valueKind": "string",
        "enum": [
          "script"
        ],
        "description": "Step type discriminator. Required, and must be \"script\", for script steps. Not substituted: This structural field or identity value stays as authored."
      },
      "executionMode": {
        "valueKind": "string",
        "enum": [
          "interactive",
          "headless"
        ],
        "description": "Where this script step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow's executionMode, then the defaults.executionMode setting. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "script": {
        "valueKind": "string",
        "description": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`."
      },
      "env": {
        "valueKind": "object",
        "description": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values."
      },
      "compareSource": {
        "valueKind": "string",
        "enum": [
          "stdout",
          "stderr",
          "exitCode"
        ],
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "timeoutSec": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "errorBehavior": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Internal-error policy for this script step when it cannot run or evaluation breaks. Use null to explicitly disable an inherited workflow policy."
      },
      "secrets": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Secret environment-variable names granted to this script step. Use null to explicitly disable an inherited grant array. Not substituted: Secret grant approval is keyed to authored grant names."
      },
      "onPass": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "continue",
        "description": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "stopWorkflow",
        "description": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default). A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "operator": {
        "valueKind": "string",
        "enum": [
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Every `matches` comparison runs in a worker bounded by `execution.regexTimeoutSec`; a timeout is an evaluation error handled by `errorBehavior`. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "ignoreCase": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "name": {
        "valueKind": "string",
        "description": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a preview of the step's prompt or script text. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "enabled": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Whether this step executes. A whole-value {{name}} placeholder is coerced to boolean and validated at run start."
      },
      "color": {
        "valueKind": "string",
        "description": "Optional authored identity colour for this step. Not substituted: This structural field or identity value stays as authored."
      }
    },
    "forbiddenKeys": [
      "maxSteps",
      "returns",
      "trustedExternalRoots",
      "worktree"
    ]
  },
  "parallelGroup": {
    "properties": {
      "parallel": {
        "valueKind": "array",
        "description": "The prompt or script steps that run concurrently. Groups cannot be nested. Not substituted: This structural field or identity value stays as authored."
      },
      "failFast": {
        "valueKind": "boolean",
        "default": true,
        "description": "Stop the remaining members as soon as one member fails. Default: true. Not substituted: This structural field or identity value stays as authored."
      }
    },
    "forbiddenKeys": []
  },
  "endCondition": {
    "properties": {
      "mcpLiteralEnvKeys": {
        "valueKind": "array",
        "description": "Internal provenance for MCP supplied literal env values."
      },
      "script": {
        "valueKind": "string",
        "description": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`."
      },
      "env": {
        "valueKind": "object",
        "description": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values."
      },
      "compareSource": {
        "valueKind": "string",
        "enum": [
          "stdout",
          "stderr",
          "exitCode"
        ],
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "timeoutSec": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "operator": {
        "valueKind": "string",
        "enum": [
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Every `matches` comparison runs in a worker bounded by `execution.regexTimeoutSec`; a timeout is an evaluation error handled by `errorBehavior`. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "ignoreCase": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "maxRetries": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "enum": [
          -1
        ],
        "description": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "retryPrompt": {
        "valueKind": "string",
        "description": "Template for retry prompt. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource). $preCondition:* works in the step and retry prompts; $endCondition:* is only available in the retry prompt."
      },
      "passRetryPrompt": {
        "valueKind": "string",
        "description": "Template for the prompt sent after the end condition passes and onPass is 'retry'. Supports $preCondition:<field> and $endCondition:<field> for condition output fields (stdout, stderr, exitCode, actual, expected, compareSource); both prefixes are substituted on a pass retry. If omitted, the step's own prompt is re-sent."
      },
      "resumeSessionOnRetry": {
        "valueKind": "boolean",
        "description": "Whether retries continue in the same session. Default: true (retries resume the existing session for context continuity). Set to false to start a fresh session for each retry."
      },
      "onPass": {
        "valueKind": "string",
        "enum": [
          "continue",
          "retry",
          "stopWorkflow"
        ],
        "default": "continue",
        "description": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "retry",
          "stopWorkflow"
        ],
        "default": "stopWorkflow",
        "description": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      }
    },
    "forbiddenKeys": [
      "returns"
    ]
  },
  "preCondition": {
    "properties": {
      "mcpLiteralEnvKeys": {
        "valueKind": "array",
        "description": "Internal provenance for MCP supplied literal env values."
      },
      "script": {
        "valueKind": "string",
        "description": "Shell command or path to script. Relative paths are checked in this order: execution directory, workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`."
      },
      "env": {
        "valueKind": "object",
        "description": "Environment map consumed by the script process. Secret references are allowed only as ${secret:NAME} values."
      },
      "compareSource": {
        "valueKind": "string",
        "enum": [
          "stdout",
          "stderr",
          "exitCode"
        ],
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "timeoutSec": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "operator": {
        "valueKind": "string",
        "enum": [
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Every `matches` comparison runs in a worker bounded by `execution.regexTimeoutSec`; a timeout is an evaluation error handled by `errorBehavior`. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow. Variable substitution: step text accepts {{name}} and resolves at dispatch; unresolved placeholders fail before execution."
      },
      "ignoreCase": {
        "valueKind": "oneOf",
        "alternatives": [
          "boolean",
          "string"
        ],
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "onPass": {
        "valueKind": "string",
        "enum": [
          "continue",
          "skipPrompt",
          "stopWorkflow"
        ],
        "default": "continue",
        "description": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "skipPrompt",
          "stopWorkflow"
        ],
        "default": "skipPrompt",
        "description": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      }
    },
    "forbiddenKeys": [
      "returns"
    ]
  },
  "toolPermissions": {
    "properties": {
      "mode": {
        "valueKind": "string",
        "enum": [
          "dangerouslyAllowAll",
          "allowAll",
          "auto",
          "custom",
          "none"
        ],
        "description": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects the deny list. 'auto' lets the harness's own safety judge approve or block each request; the deny list always blocks, while the allow list pre-approves tools without limiting what runs. Unsupported harnesses run with custom tool permissions and report a warning. Codex auto review can approve sandbox escalations. 'custom' uses allowedTools + deniedTools. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config). Not substituted: This structural field or identity value stays as authored."
      },
      "allowedTools": {
        "valueKind": "array",
        "description": "Tool patterns to allow (used in custom mode). Supported by Copilot CLI, Claude CLI, Qwen Code, OpenCode, and Antigravity. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Antigravity cannot translate web search or subagent tools, or allow a command chain piecemeal. Codex has no allow list, so Allowed Tools are NOT ENFORCED there; its sandbox and approval modes decide what runs."
      },
      "deniedTools": {
        "valueKind": "array",
        "description": "Tool patterns to deny (takes precedence over allow list). Supported by Copilot CLI, Claude CLI, Qwen Code, OpenCode, and Antigravity. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Antigravity cannot translate web search, subagent, or list/search denials. Codex enforces only `mcp__<server>__<tool>` entries for MCP servers the workflow attaches, passed as that server's `disabled_tools`; it does NOT ENFORCE shell or other tool patterns."
      },
      "headlessApprovals": {
        "valueKind": "string",
        "enum": [
          "deny",
          "ask"
        ],
        "description": "How a headless step handles a tool approval request. `deny` answers immediately; `ask` publishes a request to connected dashboards and denies if no dashboard can answer. Applies to Claude Code `custom` requests and `auto` judge escalations, Qwen Code approval requests, Codex CLI 0.146.0+ command, file-change and permission requests, Copilot CLI 1.0.112+ ACP requests in `custom` mode, and OpenCode 2.3.0+ plugin requests when using its private standalone server. OpenCode 1 and OpenCode 2 versions before 2.3.0 continue to reject headless approval requests; an explicit `--server` also disables the per-process control channel. Copilot `auto` stays on its assisted-approval path and does not use this ACP channel. No allow-always option is offered."
      },
      "headlessApprovalTimeoutSec": {
        "valueKind": "number",
        "description": "Maximum time in seconds to wait for a dashboard response to a headless approval request. Qwen Code may impose a lower limit on older versions."
      }
    },
    "forbiddenKeys": []
  },
  "errorBehavior": {
    "properties": {
      "onError": {
        "valueKind": "string",
        "enum": [
          "stopWorkflow",
          "retry",
          "retryPhase",
          "continue"
        ],
        "description": "What to do when a step phase cannot run or otherwise encounters an internal error. 'stopWorkflow': fail the step and stop the workflow (default). 'retry': re-run the whole step from its pre-condition, starting a fresh harness session; a harness error while sending an end-condition retry prompt also restarts the whole step. 'retryPhase': re-run only the phase that errored — an errored end-condition re-runs just its script against the existing response without another AI call, and a failed prompt is re-sent in a fresh harness session without re-running the pre-condition; if an end-condition retry prompt send fails, that retry prompt is resent in the existing session when available, otherwise a fresh session. For pre-conditions and script steps, retryPhase behaves like retry. 'continue': proceed as if the phase had not errored and record a warning. Each phase keeps its own retry count. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "maxRetries": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "description": "Maximum retry attempts when onError is retry or retryPhase. When omitted, one retry is allowed. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      },
      "retryDelaySec": {
        "valueKind": "oneOf",
        "alternatives": [
          "number",
          "string"
        ],
        "description": "Delay before retrying, in seconds. A whole-value {{name}} placeholder is coerced and validated before dispatch."
      }
    },
    "forbiddenKeys": []
  },
  "hook": {
    "properties": {
      "event": {
        "valueKind": "string",
        "enum": [
          "stop",
          "sessionStart",
          "preToolUse",
          "postToolUse",
          "userPromptSubmit",
          "permissionRequest",
          "notification",
          "error"
        ],
        "description": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), Stop (Codex), agentStop (Copilot). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode."
      },
      "command": {
        "valueKind": "string",
        "description": "Command to execute. Resolved relative to workspace root if not absolute."
      },
      "env": {
        "valueKind": "object",
        "description": "Each hook receives only its own env values, merged over the harness environment when it runs. These values are not added to the harness process environment, but are written to a per-step temp file readable by the local user, so they are not hidden from a model with shell access. Secret references are allowed only as ${secret:NAME} values."
      },
      "timeoutSec": {
        "valueKind": "number",
        "description": "Maximum time a user hook may run, in seconds. Applied by Copilot, Claude Code, Codex, Qwen Code, Antigravity, and OpenCode; harnesses that do not support per-hook timeouts use their own limit."
      }
    },
    "forbiddenKeys": []
  },
  "worktree": {
    "properties": {
      "mode": {
        "valueKind": "string",
        "enum": [
          "managed",
          "named"
        ]
      },
      "merge": {
        "valueKind": "boolean",
        "description": "Merge the managed branch into the captured source checkout after the run. Not substituted: This structural field or identity value stays as authored."
      },
      "keep": {
        "valueKind": "boolean",
        "description": "Keeps the managed worktree directory after the run instead of removing it. Without it, appending a follow-up prompt recreates the directory from the branch; ignored files such as node_modules are gone and the setup command runs again, so a long setup pays that cost on every append. Removing the directory also ends filesystem undo for that run. Not substituted: This structural field or identity value stays as authored."
      },
      "base": {
        "valueKind": "string",
        "description": "Optional Git ref resolved to a commit when the worktree is created."
      },
      "setup": {
        "valueKind": "string",
        "description": "Optional setup command run after a new managed worktree is created. Setup is outside the step-scoped errorBehavior policy: it runs before any step is in flight, so a non-succeeded setup blocks the worktree and the next Run re-runs it; a succeeded outcome is skipped."
      },
      "branch": {
        "valueKind": "string",
        "description": "Local Git branch name for the named worktree."
      },
      "directory": {
        "valueKind": "string",
        "description": "Optional long-lived directory for this named worktree, so one directory can hold different branches over time. Use an absolute path, a ~-prefixed path, or a bare name with no slash or backslash; relative paths containing separators are rejected. A bare name reuses the registered linked worktree whose directory has that exact name (or the directory ctrlyoke derived for a branch of that name); otherwise ctrlyoke creates the directory as `<worktree root>/<name>`, with no hash suffix, or as `<worktrees.root>/<repository>-<hash>/<name>` when the shared `worktrees.root` setting is set. When `branch` differs from the branch the directory holds, ctrlyoke switches it only when it is clean and never switches it back. Omit to derive the directory from the branch."
      }
    },
    "forbiddenKeys": []
  },
  "templateMeta": {
    "properties": {
      "name": {
        "valueKind": "string",
        "description": "Display name shown in the template picker. Not substituted: This structural field or identity value stays as authored."
      },
      "description": {
        "valueKind": "string",
        "description": "Short explanation shown in the template picker."
      },
      "author": {
        "valueKind": "string",
        "description": "Who wrote the template, such as a GitHub handle. Shown in the community template gallery. Free text; ctrlyoke does not verify it."
      },
      "tags": {
        "valueKind": "array",
        "description": "Short keywords for filtering the community template gallery, such as `review` or `testing`."
      },
      "communityInstallFile": {
        "valueKind": "string",
        "description": "Internal filename recorded when ctrlyoke installs this template from the community library."
      },
      "variables": {
        "valueKind": "object",
        "description": "Metadata for placeholders used by this template, keyed by variable name."
      }
    },
    "forbiddenKeys": []
  },
  "promptFileFrontmatter": {
    "properties": {
      "schemaVersion": {
        "valueKind": "number",
        "description": "Workflow definition format version. Absent means format 1. An older ctrlyoke refuses to load a file with a newer version. Not substituted: This structural field or identity value stays as authored."
      },
      "name": {
        "valueKind": "string",
        "description": "Workflow display name used when the file runs on its own (cut to 100 characters). If omitted, the file name without `.prompt.md` is used. It is display metadata only and is never sent to the harness. Not substituted: This structural field or identity value stays as authored."
      },
      "description": {
        "valueKind": "string",
        "description": "Short summary of the prompt. When the file runs on its own, it becomes the step's `name` in the dashboard (cut to 100 characters). It is display metadata only and is never sent to the harness."
      }
    },
    "forbiddenKeys": []
  }
};
