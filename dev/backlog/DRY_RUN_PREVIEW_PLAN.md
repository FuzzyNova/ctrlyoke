# Dry Run / Execution Preview Plan

> **Status:** Proposed — needs the compatibility and redaction contracts
>
> **Priority:** P1

---

## Problem

Users cannot inspect the complete execution ctrlyoke is about to prepare:

- resolved variables and inherited properties;
- agent, skill, prior-context, and reference expansion;
- categorized prompt files and their delivery order;
- permission and MCP translation;
- workspace-scoped settings mutations;
- the executable and arguments passed to the harness;
- compatibility warnings or ignored fields.

Running the workflow and reading logs is too late, especially for denied tool
rules, secrets, remote execution, and unattended automation.

## Product Decision

Build one side-effect-free execution-plan service used by the dashboard,
standalone CLI, validation, and future automation API.

Preview must call the same resolvers, prompt builders, capability analyzer, and
provider preparation logic as real execution. It must not maintain a simplified
second command builder.

## Entry Points

### Dashboard

- Add **Preview** to a step and **Preview workflow** to workflow actions.
- Show the current editor content, including unsaved working-file changes.
- Recompute after harness, property, variable, or attachment changes.

### CLI

```text
ctrlyoke run workflow.ctrlyoke.yaml --dry-run
ctrlyoke run workflow.ctrlyoke.yaml --dry-run --var target=auth
ctrlyoke run workflow.ctrlyoke.yaml --dry-run --json
```

Exit without starting a harness, running scripts, or mutating harness settings.
Structured output uses stable diagnostic codes.

## Execution Plan Contract

```typescript
interface WorkflowExecutionPreview {
  workflow: WorkflowPreviewSummary;
  steps: StepExecutionPreview[];
  diagnostics: CompatibilityDiagnostic[];
}

interface StepExecutionPreview {
  stepIndex: number;
  stepId?: string;
  stepName?: string;
  type: "prompt" | "script";
  resolvedProperties: ResolvedPropertiesPreview;
  prompt?: CategorizedPromptPreview;
  command?: CommandPreview;
  permissionApplication?: PermissionApplicationPreview;
  mcpApplication?: McpApplicationPreview;
  workspaceMutations: WorkspaceMutationPreview[];
  variables: VariableResolutionPreview[];
  conditions: ConditionPreview;
  diagnostics: CompatibilityDiagnostic[];
}
```

Use preview-safe DTOs rather than returning runtime service objects or secrets.

## What Preview Shows

### Resolved properties

- harness and detected version;
- model;
- execution and continuation mode;
- session behavior without exposing sensitive session content;
- agent, skills, MCP servers, hooks, permissions, limits, and conditions;
- property source: prompt, workflow, or global default.

### Categorized payload

Show each payload category separately and in final delivery order:

- agent instructions;
- skill content;
- prompt text;
- prior context;
- inline-expanded references;
- provider-formatted file references;
- image metadata.

Show the content that would be written to each temporary prompt file without
creating that file. Do not rely on a prompt-length threshold or describe the
current categorized multi-file architecture as one generic temp file.

### Command

Show an argument array as the canonical value and a shell-escaped rendering for
copy/readability:

```typescript
interface CommandPreview {
  executable: string;
  args: string[];
  displayCommand: string;
  cwd: string;
  environmentKeys: string[];
}
```

Never construct `displayCommand` by joining unescaped arguments. Do not expose
environment values.

### Permissions and compatibility

Show:

- effective permission mode;
- every allowed/denied rule;
- provider-native translation;
- ignored, partial, unverified, or unsupported rules;
- the exact workspace config path and owned keys that would be changed;
- the workspace-wide side-effect warning;
- harness capability/version diagnostics from
  `HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`.

For security-sensitive settings, "ignored" is a warning by default and can be
promoted to an error by CLI policy.

### MCP, variables, limits, and conditions

- MCP server IDs, transports, tool filters, and injection method;
- variable values after centralized redaction;
- execution guardrails and already-detectable limit violations;
- pre/end-condition configuration without executing scripts;
- retry and error behavior.

## Side-Effect-Free Preparation

Provider preparation currently mixes pure argument construction with file
mutation in some harnesses. Split it into:

1. `plan` — resolve and return arguments, intended files/mutations, payloads, and
   diagnostics;
2. `apply` — perform the planned mutations immediately before process start;
3. `release` — remove owned mutations after the consuming process exits.

Real execution and preview both call `plan`; preview never calls `apply`.

This contract is shared with tool-permission workspace configuration and should
also replace misleading provider methods whose comments promise side effects
they do not perform.

## Redaction and Access

- Run all preview DTOs through the centralized secrets/redaction service before
  crossing a process, webview, hosted-server, log, or CLI-output boundary.
- Default to redacted values in the UI and CLI.
- A reveal action, if added, must be local-only, explicit, and separately
  authorized; it must not make hosted transport carry the original secret.
- Do not show authentication tokens, environment values, secret file contents,
  or sensitive session state.
- Copy actions copy the displayed/redacted representation unless the user has
  explicitly entered an approved local reveal flow.

## Dashboard UX

Use tabs only where they help:

- **Summary** — diagnostics, properties, limits, and workspace side effects.
- **Payload** — categorized content and token contribution.
- **Command** — executable, arguments, cwd, and environment key names.
- **Conditions** — scripts, expected results, retries, and error behavior.

Include copy actions for the redacted command and payload. There is no **Open temp
file** action because preview creates no temp files.

## CLI Behavior

- Human output groups diagnostics before step details.
- `--json` returns the full redacted preview contract.
- Add policy flags only if needed after the compatibility analyzer exists, for
  example `--fail-on lossy`.
- Exit nonzero for invalid workflow/provider combinations. Lossy and unverified
  behavior follow the selected validation policy.

## Testing

- Golden tests compare preview plans with the plan consumed by real execution.
- Assert preview performs no harness spawn, script execution, config write, temp
  file write, or session mutation.
- Cover categorized multi-file prompts and every provider.
- Cover redaction at DTO, webview-message, hosted-transport, log, and CLI output
  boundaries.
- Cover unsupported/partial permission rules and workspace mutation previews.
- Verify command display escaping independently on Windows and POSIX.

## Acceptance Criteria

- A user can see the complete redacted payload and command before execution.
- Preview and real execution consume the same immutable plan.
- Categorized prompt delivery is represented accurately.
- Every ignored/lossy provider translation is visible.
- Workspace-setting side effects are named before execution.
- Preview does not mutate the workspace or harness state.
- CLI and dashboard diagnostics use the same codes and severities.

## Non-goals

- Running pre/end-condition scripts.
- Resolving a "latest session" by opening or changing session state.
- Creating temporary prompt or harness config files.
- Guaranteeing that external workspace state will not change between preview and
  execution.
