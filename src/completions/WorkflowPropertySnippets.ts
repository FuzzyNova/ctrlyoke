import { PROMPT_PROPERTIES, STEP_TYPES } from "../types/DashboardConstants";

/**
 * Editorial completion polish for a workflow key. The generated
 * `WorkflowSchemaOutline` owns which keys exist and what they accept; this
 * only adds the short detail line, the long documentation and the insertion
 * snippet. A key with no entry here is still offered, with outline data.
 */
export interface WorkflowPropertySnippet {
  readonly detail?: string;
  readonly documentation?: string;
  /** VS Code snippet syntax, shared by both hosts. */
  readonly insertSnippet?: string;
}

export const WORKFLOW_PROPERTY_SNIPPETS: Readonly<
  Record<string, WorkflowPropertySnippet>
> = {
  [PROMPT_PROPERTIES.STEP_TYPE]: {
    detail: `Step type: "${STEP_TYPES.PROMPT}" | "${STEP_TYPES.SCRIPT}"`,
    documentation:
      "Discriminates the step type. Omit for an AI prompt step (backwards compatible). " +
      `Set to \`"${STEP_TYPES.SCRIPT}"\` for a shell script step with no AI interaction.`,
    insertSnippet: `${PROMPT_PROPERTIES.STEP_TYPE}: `,
  },
  [PROMPT_PROPERTIES.NAME]: {
    detail: "Display label (optional)",
    documentation:
      "Human-readable label shown in the ctrlyoke dashboard. " +
      "If omitted, the dashboard shows a truncated preview of the prompt or script.",
    insertSnippet: `${PROMPT_PROPERTIES.NAME}: `,
  },
  [PROMPT_PROPERTIES.PROMPT]: {
    detail: "Prompt text or path to .prompt.md (required)",
    documentation:
      "The prompt to send to the AI assistant. Supports inline text (with `@file` and `#selection:` references) or a path to a `.prompt.md`, `.md`, or `.txt` file.",
    insertSnippet: `${PROMPT_PROPERTIES.PROMPT}: |\n  `,
  },
  [PROMPT_PROPERTIES.HARNESS]: {
    detail: "Harness override for this step",
    documentation:
      "Overrides the workflow-level harness for this step (e.g., `claude-cli`, `copilot-cli`).",
    insertSnippet: `${PROMPT_PROPERTIES.HARNESS}: `,
  },
  [PROMPT_PROPERTIES.MODEL]: {
    detail: "Model override for this step",
    documentation:
      "Overrides the workflow-level model for this step (e.g., `claude-sonnet-4.5`).",
    insertSnippet: `${PROMPT_PROPERTIES.MODEL}: `,
  },
  [PROMPT_PROPERTIES.AGENT]: {
    detail: "Path to .agent.md custom agent file",
    documentation:
      "Path to a custom agent definition (`.agent.md`) used for this step.",
    insertSnippet: `${PROMPT_PROPERTIES.AGENT}: `,
  },
  [PROMPT_PROPERTIES.SKILLS]: {
    detail: "Skills to attach to this step",
    documentation: "List of skill identifiers to make available to this step.",
    insertSnippet: `${PROMPT_PROPERTIES.SKILLS}:\n  - `,
  },
  [PROMPT_PROPERTIES.RESUME_SESSION]: {
    detail: "Continue conversation from previous step (boolean)",
    documentation:
      "When `true`, resumes the AI session from the previous step rather than starting a new conversation.",
    insertSnippet: `${PROMPT_PROPERTIES.RESUME_SESSION}: true`,
  },
  [PROMPT_PROPERTIES.SESSION_ID]: {
    detail: "Session ID or prior step index to resume",
    documentation:
      "Resume a specific AI session by GUID/thread ID, or reference a prior prompt by step number (e.g., `1`).",
    insertSnippet: `${PROMPT_PROPERTIES.SESSION_ID}: `,
  },
  [PROMPT_PROPERTIES.MCP_SERVERS]: {
    detail: "MCP servers to attach",
    documentation:
      'List of MCP server identifiers to attach for this step (e.g., `["ctrlyoke"]`).',
    insertSnippet: `${PROMPT_PROPERTIES.MCP_SERVERS}:\n  - `,
  },
  [PROMPT_PROPERTIES.HOOKS]: {
    detail: "Pre/post execution hooks",
    documentation: "User-defined hooks executed before and after this step.",
    insertSnippet: `${PROMPT_PROPERTIES.HOOKS}:\n  `,
  },
  [PROMPT_PROPERTIES.END_CONDITION]: {
    detail: "Validation script run after AI response",
    documentation:
      "End condition evaluated after the AI responds. If the condition passes, `onPass: retry` re-runs the step with `passRetryPrompt` (or the step's own prompt); if it fails, the step retries with `retryPrompt`. `onPass` supports `continue | retry | stopWorkflow`; `onFail` supports `continue | retry | stopWorkflow`.",
    insertSnippet: `${PROMPT_PROPERTIES.END_CONDITION}:\n  script: `,
  },
  [PROMPT_PROPERTIES.PRE_CONDITION]: {
    detail: "Script gate evaluated before the AI prompt runs",
    documentation:
      "Pre-condition script that gates whether the prompt runs. `onPass` (default: continue) and `onFail` (default: skipPrompt) control the outcome. Actions: continue | skipPrompt | stopWorkflow.",
    insertSnippet: `${PROMPT_PROPERTIES.PRE_CONDITION}:\n  script: \n  onFail: skipPrompt`,
  },
  [PROMPT_PROPERTIES.ERROR_BEHAVIOR]: {
    detail: "Harness/session failure policy",
    documentation:
      "Controls what happens when the harness itself fails. `onError` supports `stopWorkflow`, `retry`, or `continue`. `maxRetries` and `retryDelaySec` apply when retry is selected.",
    insertSnippet: `${PROMPT_PROPERTIES.ERROR_BEHAVIOR}:\n  onError: stopWorkflow`,
  },
  [PROMPT_PROPERTIES.SCRIPT]: {
    detail: "Shell command or script path (required)",
    documentation:
      "Shell command or path to script file to execute. Resolved relative to workspace root or `.ctrlyoke/`.",
    insertSnippet: `${PROMPT_PROPERTIES.SCRIPT}: `,
  },
  [PROMPT_PROPERTIES.TIMEOUT]: {
    detail: "Timeout in seconds",
    documentation:
      "Timeout in seconds. Defaults to the `execution.scriptTimeoutSec` setting.",
    insertSnippet: `${PROMPT_PROPERTIES.TIMEOUT}: `,
  },
  [PROMPT_PROPERTIES.COMPARE_SOURCE]: {
    detail: "Which output the comparison reads",
    documentation:
      "Which output is compared against `expected`. `exitCode` (default): the numeric exit code. `stdout`/`stderr`: the trimmed text. A text comparison does not also require a clean exit.",
    insertSnippet: `${PROMPT_PROPERTIES.COMPARE_SOURCE}: `,
  },
  [PROMPT_PROPERTIES.OPERATOR]: {
    detail: "How the comparison is made",
    documentation:
      "How the compare source is compared against `expected`. `eq` (default) / `ne`, `contains` / `notContains`, `gte` / `gt` / `lte` / `lt` (numeric — both sides must be numbers), `matches` (unanchored regex), `isEmpty` / `isNotEmpty` (no value needed). Word tokens only: `>=` is a YAML parse error and `!=` silently parses as a YAML tag.",
    insertSnippet: `${PROMPT_PROPERTIES.OPERATOR}: `,
  },
  [PROMPT_PROPERTIES.EXPECTED]: {
    detail: "Value the compare source is checked against",
    documentation:
      "Value the compare source is compared against, as a string or number. Omit it entirely to pass when the script exits 0 — there is no boolean form, and `true`/`false` are not exit-code values.",
    insertSnippet: `${PROMPT_PROPERTIES.EXPECTED}: `,
  },
  [PROMPT_PROPERTIES.IGNORE_CASE]: {
    detail: "Compare text case-insensitively",
    documentation:
      "Compare text without regard to case. Applies only to the string operators (`eq`, `ne`, `contains`, `notContains`). Default: false.",
    insertSnippet: `${PROMPT_PROPERTIES.IGNORE_CASE}: `,
  },
  [PROMPT_PROPERTIES.ON_PASS]: {
    detail: "Action on script pass: continue | stopWorkflow",
    documentation:
      "What to do when the script passes. `continue`: advance the queue (default). `stopWorkflow`: halt execution.",
    insertSnippet: `${PROMPT_PROPERTIES.ON_PASS}: `,
  },
  [PROMPT_PROPERTIES.ON_FAIL]: {
    detail: "Action on script fail: continue | stopWorkflow",
    documentation:
      "What to do when the script fails. `stopWorkflow`: halt execution (default). `continue`: log a warning and advance the queue.",
    insertSnippet: `${PROMPT_PROPERTIES.ON_FAIL}: `,
  },
};
