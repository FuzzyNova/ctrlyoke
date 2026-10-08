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
        "description": "Workflow definition format version. Absent means format 1. ctrlyoke stamps this field when it writes workflow files; older ctrlyoke versions refuse to open a newer format."
      },
      "_templateMeta": {
        "valueKind": "object",
        "description": "Marks the file as a reusable template and describes its placeholders. Removed when the template is instantiated."
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
        "description": "AI model to use for this prompt. Use IntelliSense (Ctrl+Space) to see available models. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting."
      },
      "executionMode": {
        "valueKind": "string",
        "enum": [
          "interactive",
          "headless"
        ],
        "description": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default."
      },
      "agent": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. Use null to explicitly disable inherited agent selection."
      },
      "resumeSession": {
        "valueKind": "boolean",
        "description": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry."
      },
      "mcpServers": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers."
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
        "description": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution."
      },
      "skills": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). Use null to explicitly disable inherited workflow skills; skills declared by the selected agent still attach."
      },
      "secrets": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants."
      },
      "endCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "End condition validation to run after this prompt completes. Use null to explicitly disable end condition inheritance from the workflow level (even if the workflow defines one). Omitting this field inherits the workflow-level end condition (if any)."
      },
      "preCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. Use null to disable an inherited pre-condition for a specific prompt."
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
        "description": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation)."
      },
      "additionalArgs": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). Use null at prompt level to explicitly disable additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\""
      },
      "toolPermissions": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'."
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
          "script"
        ],
        "description": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible)."
      },
      "name": {
        "valueKind": "string",
        "description": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a truncated preview of the prompt text."
      },
      "enabled": {
        "valueKind": "boolean",
        "description": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution."
      },
      "color": {
        "valueKind": "string",
        "description": "Optional authored identity colour for this step."
      },
      "prompt": {
        "valueKind": "string",
        "description": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported."
      },
      "maxSteps": {
        "valueKind": "number",
        "enum": [
          -1
        ],
        "description": "Maximum number of entries in the run's `steps` array, regardless of who queued them, including parallel members and disabled steps. `finalStep` iterations and retries are not counted. Omit to inherit `queue.maxSteps`. `-1` means unlimited."
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
        "description": "Default values for `{{varName}}` substitutions."
      },
      "trustedExternalRoots": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Restricts, extends, or disables this workflow's external-root access relative to the user/workspace defaults. Omit this field entirely to inherit the live union of approved user + workspace permissions.trustedExternalRoots (today's behavior, unchanged). When set, the array REPLACES that inherited union rather than adding to it — it may contain brand-new roots this workflow alone needs (widening, without growing the user/workspace list for every other workflow) and/or a deliberately narrowed subset of already-trusted roots (restricting a risky workflow to less than the everyday default); either way every root in the array still needs its own one-time approval unless already approved at a broader scope."
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
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison."
      },
      "timeoutSec": {
        "valueKind": "number",
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted."
      },
      "onPass": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "continue",
        "description": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "stopWorkflow",
        "description": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default)."
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow."
      },
      "ignoreCase": {
        "valueKind": "boolean",
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false."
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
        "description": "AI model to use for this prompt. Use IntelliSense (Ctrl+Space) to see available models. Each harness supports different models — unsupported models fall back to the harness default with a warning. Use 'none' to skip the --model flag entirely (e.g. for custom Bedrock model strings passed via additionalArgs). Optional - defaults to the active harness model setting."
      },
      "executionMode": {
        "valueKind": "string",
        "enum": [
          "interactive",
          "headless"
        ],
        "description": "Where this step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow/global default."
      },
      "agent": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachment. Specify ONLY the agent name without file extensions (e.g., 'ctrlyoke-workflow-composer' for file 'ctrlyoke-workflow-composer.agent.md'). ctrlyoke attaches the agent's content to the prompt wrapped in <agentInstructions> tags, so it works the same on every harness. Native harness agent discovery is managed separately in the Agents & Skills settings page and does not determine workflow agent support. Use null to explicitly disable inherited agent selection."
      },
      "resumeSession": {
        "valueKind": "boolean",
        "description": "Whether to resume the existing chat session for this prompt. When omitted, defaults to the `defaults.resumeSession` setting (default: false). Set to true to continue in the existing session for context continuity. Retries continue in the same session by default; set endCondition.resumeSessionOnRetry=false to start a fresh session for each retry."
      },
      "mcpServers": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "MCP servers to attach to the harness for this prompt/workflow. Registry IDs resolve against ctrlyoke's managed MCP registry. Include \"ctrlyoke\" to enable dynamic queue extension via ctrlyoke's MCP server. Use /mcp:<server-id> in the prompt to force-attach a managed server; an inline reference wins over null, which otherwise explicitly disables inherited servers."
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
        "description": "Session ID for resuming CLI conversations. Can be: a string (exact CLI session ID to resume), a number (prompt reference: 1 = use session from first prompt), or the special value \"finalStep\" (resume the session established by the most recent final step execution — works on any prompt, not just the final step itself; on first pass when no final step session exists yet, a new session starts). When omitted and resumeSession=true, automatically resumes previous prompt's session. Working file runtime metadata stores the actual session ID used during execution."
      },
      "skills": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Portable ctrlyoke prompt attachments. For skills found inside a trusted root, ctrlyoke adds the skill name, path, and description to the prompt so the harness can read the SKILL.md file when it uses the skill; skill files outside trusted roots are read and embedded. This makes workflow skills available on every harness. The Agents & Skills settings page separately manages optional harness-native discovery directories whose behavior varies by harness; native discovery does not determine workflow skills support. Prompt-level skills replace workflow-level skills (no merging). Use null to explicitly disable inherited workflow skills; skills declared by the selected agent still attach."
      },
      "secrets": {
        "valueKind": "oneOf",
        "alternatives": [
          "array",
          "null"
        ],
        "description": "Secret environment-variable names granted to this prompt or workflow. Prompt-level secrets replace workflow-level secrets (no merging). Use null to explicitly disable an inherited grant array; inline !NAME references in prompt text remain authoritative grants."
      },
      "endCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "End condition validation to run after this prompt completes. Use null to explicitly disable end condition inheritance from the workflow level (even if the workflow defines one). Omitting this field inherits the workflow-level end condition (if any)."
      },
      "preCondition": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. Use null to disable an inherited pre-condition for a specific prompt."
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
        "description": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; { previous: N } injects the last N outputs before this prompt; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index; or { workflowKey, runRef } imports the complete terminal output from one run in this workspace. Addresses never contain local paths. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation)."
      },
      "additionalArgs": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "null"
        ],
        "description": "Additional CLI flags appended to ctrlyoke's standard argument set. ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally. Tokens are injected before the tool permission args. Applies to all harnesses (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli). Use null at prompt level to explicitly disable additional args even if the workflow or settings define some. Example: \"--effort high --max-turns 10\""
      },
      "toolPermissions": {
        "valueKind": "oneOf",
        "alternatives": [
          "object",
          "null"
        ],
        "description": "Tool permission overrides for this prompt/workflow. Resolves prompt → workflow → the `defaults.toolPermissions` setting. Set mode to 'none' to pass no permission flags and rely entirely on the harness's own local configuration; null behaves the same as mode 'none'."
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
        "description": "Optional step type discriminator. When omitted, the step is treated as an AI prompt (backwards compatible)."
      },
      "name": {
        "valueKind": "string",
        "description": "Optional human-readable display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows a truncated preview of the prompt text."
      },
      "enabled": {
        "valueKind": "boolean",
        "description": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution."
      },
      "color": {
        "valueKind": "string",
        "description": "Optional authored identity colour for this step."
      },
      "prompt": {
        "valueKind": "string",
        "description": "The prompt text to send to the AI. Can be either: (1) Final-form prompt text with context references expanded inline before sending — use @path/to/file or @path/to/dir/ for files/directories, and #selection:path:line-line or #sym.<kind>:path:symbol:line-line for file excerpts and symbols. ctrlyoke inserts the kinded #sym.<kind>: form; hand-authored #sym:path:symbol:line-line remains valid and generic. OR (2) A file path to a .prompt.md, .md, or .txt file containing the prompt. File paths are resolved relative to the prompt file's directory, then workspace root, then .ctrlyoke directory. Absolute paths are also supported."
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
        "description": "Step type discriminator. Required, and must be \"script\", for script steps."
      },
      "name": {
        "valueKind": "string",
        "description": "Optional display label shown in the ctrlyoke dashboard. If omitted, the dashboard shows the script text."
      },
      "enabled": {
        "valueKind": "boolean",
        "description": "Whether this step executes. When omitted, the step is enabled. Set to false to keep the step in the workflow but skip execution."
      },
      "color": {
        "valueKind": "string",
        "description": "Optional authored identity colour for this step."
      },
      "executionMode": {
        "valueKind": "string",
        "enum": [
          "interactive",
          "headless"
        ],
        "description": "Where this script step runs. 'interactive' uses a live PTY/TUI; 'headless' runs in the background with output in the Output panel. Pre/end-condition scripts always run headless. Omitting this field inherits the workflow's executionMode, then the defaults.executionMode setting."
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
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison."
      },
      "timeoutSec": {
        "valueKind": "number",
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted."
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
        "description": "Secret environment-variable names granted to this script step. Use null to explicitly disable an inherited grant array."
      },
      "onPass": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "continue",
        "description": "What to do when the script passes (exit 0 / returns matches). 'continue': advance the queue (default). 'stopWorkflow': halt execution immediately."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "stopWorkflow"
        ],
        "default": "stopWorkflow",
        "description": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default)."
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow."
      },
      "ignoreCase": {
        "valueKind": "boolean",
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false."
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
        "description": "The prompt or script steps that run concurrently. Groups cannot be nested."
      },
      "failFast": {
        "valueKind": "boolean",
        "default": true,
        "description": "Stop the remaining members as soon as one member fails. Default: true."
      }
    },
    "forbiddenKeys": []
  },
  "endCondition": {
    "properties": {
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
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison."
      },
      "timeoutSec": {
        "valueKind": "number",
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted."
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow."
      },
      "ignoreCase": {
        "valueKind": "boolean",
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false."
      },
      "maxRetries": {
        "valueKind": "number",
        "enum": [
          -1
        ],
        "description": "Maximum number of retry attempts. `-1` means unlimited. 0 means no retries by default, or 1-100 for a specific limit. When onPass or onFail is 'retry' and this field is omitted, one retry is allowed."
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
        "description": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the step's prompt while the condition keeps passing, up to maxRetries; exhausting the retries advances to the next step. A failure during the loop is handled by onFail. 'stopWorkflow': halt execution immediately."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "retry",
          "stopWorkflow"
        ],
        "default": "stopWorkflow",
        "description": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times); if retryPrompt is omitted, a fallback prompt includes the expected and actual values and script output. When maxRetries is omitted, one retry is allowed. 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default). A retryPrompt alone does not enable retries; set maxRetries above 0 on the condition or in defaults.endCondition.maxRetries, or use onFail: retry."
      }
    },
    "forbiddenKeys": [
      "returns"
    ]
  },
  "preCondition": {
    "properties": {
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
        "description": "Which output the comparison reads. Default: 'exitCode'. 'stdout'/'stderr' compare the trimmed text; 'exitCode' compares the numeric exit code. There is no implicit clean-exit requirement layered onto a text comparison."
      },
      "timeoutSec": {
        "valueKind": "number",
        "description": "Timeout in seconds. When omitted, the `execution.scriptTimeoutSec` setting applies."
      },
      "shell": {
        "valueKind": "string",
        "description": "Pin the shell that runs this script's inline text. Used only when `script` is inline text rather than a path to a script file with a known extension. Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the `terminal.shellExecutable` setting for this one script; falls back to it, then platform auto-detect, when omitted."
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
        "description": "How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. Inputs over 100,000 characters run in a worker with a 2 second timeout; a timeout fails the comparison. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors."
      },
      "expected": {
        "valueKind": "oneOf",
        "alternatives": [
          "string",
          "number"
        ],
        "description": "Value the compare source is compared against. Omit it to pass when the script exits 0 — there is no boolean form, and 'true'/'false' are not accepted as exit-code values. Omitting it while `compareSource` or `operator` states a comparison is allowed but ignores that comparison and still falls back to exit code 0; the dashboard flags this as a warning rather than refusing the workflow."
      },
      "ignoreCase": {
        "valueKind": "boolean",
        "description": "Compare text case-insensitively. Applies only to eq/ne/contains/notContains. Default: false."
      },
      "onPass": {
        "valueKind": "string",
        "enum": [
          "continue",
          "skipPrompt",
          "stopWorkflow"
        ],
        "default": "continue",
        "description": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution."
      },
      "onFail": {
        "valueKind": "string",
        "enum": [
          "continue",
          "skipPrompt",
          "stopWorkflow"
        ],
        "default": "skipPrompt",
        "description": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution."
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
          "custom",
          "none"
        ],
        "description": "Permission mode. 'dangerouslyAllowAll' bypasses all restrictions. 'allowAll' auto-grants all but respects deny list. 'custom' uses allowedTools + deniedTools only. 'none' passes no permission flags at all — it does not deny tools; the harness applies whatever permissions are configured in its own local settings (e.g. ~/.claude/settings.json, Copilot CLI config)."
      },
      "allowedTools": {
        "valueKind": "array",
        "description": "Tool patterns to allow (used in custom mode). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by those harnesses."
      },
      "deniedTools": {
        "valueKind": "array",
        "description": "Tool patterns to deny (takes precedence over allow list). Currently supported by Copilot CLI, Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular support. OpenCode delivers permissions through OPENCODE_CONFIG_CONTENT and writes no workspace opencode.json. Codex and Antigravity only support an overall permission mode, not individual tool patterns; Denied Tools are NOT ENFORCED by those harnesses."
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
          "continue"
        ],
        "description": "What to do when a step phase cannot run or otherwise encounters an internal error."
      },
      "maxRetries": {
        "valueKind": "number",
        "description": "Maximum retry attempts when onError is retry. When omitted, one retry is allowed."
      },
      "retryDelaySec": {
        "valueKind": "number",
        "description": "Delay before retrying, in seconds."
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
        "description": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen/Antigravity), agentStop (Copilot), notify (Codex). 'notification' maps to Notification (Claude/Qwen), notification (Copilot), and is n/a for Codex/Antigravity/OpenCode."
      },
      "command": {
        "valueKind": "string",
        "description": "Command to execute. Resolved relative to workspace root if not absolute."
      },
      "env": {
        "valueKind": "object",
        "description": "Environment map consumed by the hook process. Secret references are allowed only as ${secret:NAME} values."
      },
      "timeoutSec": {
        "valueKind": "number",
        "description": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts."
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
        "description": "Merge the managed branch into the captured source checkout after the run."
      },
      "keep": {
        "valueKind": "boolean",
        "description": "Keeps the managed worktree directory after the run instead of removing it. Without it, appending a follow-up prompt recreates the directory from the branch; ignored files such as node_modules are gone and the setup command runs again, so a long setup pays that cost on every append. Removing the directory also ends filesystem undo for that run."
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
      }
    },
    "forbiddenKeys": []
  },
  "templateMeta": {
    "properties": {
      "name": {
        "valueKind": "string",
        "description": "Display name shown in the template picker."
      },
      "description": {
        "valueKind": "string",
        "description": "Short explanation shown in the template picker."
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
        "description": "Workflow definition format version. Absent means format 1. An older ctrlyoke refuses to load a file with a newer version."
      },
      "description": {
        "valueKind": "string",
        "description": "Short summary of the prompt. When the file runs on its own, it becomes the step's `name` in the dashboard (cut to 100 characters). It is display metadata only and is never sent to the harness."
      }
    },
    "forbiddenKeys": []
  }
};
