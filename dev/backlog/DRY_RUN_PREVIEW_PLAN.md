# Dry Run / Preview Plan

## Problem

Users have no way to inspect what FlightPath will actually send to the AI before running a
workflow. This makes debugging prompt construction opaque:

- What does the prompt look like after `{{var}}` substitution?
- What agent content gets injected?
- What `#file:` references got expanded?
- What CLI command is actually invoked, including flags and temp file paths?
- What does the temp file content look like?

Without this, users have to run the workflow and read logs to understand what happened.
Preview mode surfaces all of this before any AI is invoked.

---

## Two Entry Points

### 1. Dashboard — Preview Button Per Step

A **Preview** button on each prompt card in the dashboard. Opens a modal/panel showing
the fully resolved prompt and command for that step, given the current workflow properties
and any runtime vars.

This is the primary UX — most users author workflows in VS Code and want to verify them
interactively before running.

### 2. CLI — `--dry-run` Flag

```bash
flightpath run workflow.yaml --dry-run
flightpath run workflow.yaml --dry-run --var "target=auth"
```

Outputs the resolved command and prompt for each step to stdout (formatted or `--json`).
Exits 0 without spawning any AI process. Useful for CI validation and scripted inspection.

---

## What the Preview Shows

For each prompt step, the preview reveals the full picture of what `WorkflowExecutor`
would do if it ran that step right now:

### Resolved Properties

```
Harness:  claude-cli
Model:    claude-sonnet-4-5
Session:  (new session)
Agent:    .flightpath/agents/senior-dev.agent.md
```

### Full CLI Command

The exact string that would be passed to `spawn()`, including:

- The binary path (e.g. `claude`)
- All flags (`--model`, `--dangerously-skip-permissions`, `--resume`, etc.)
- The prompt argument or `--prompt-file` path
- Any `extraArgs`

```
claude --model claude-sonnet-4-5 --dangerously-skip-permissions \
  --prompt-file /tmp/flightpath-abc123.md
```

### Temp File Content

If a temp file would be created (prompts > 300 chars), show its full resolved content:

```markdown
<agentInstructions>
You are a senior TypeScript developer...
</agentInstructions>

Refactor the authentication module in src/auth/ to use the repository pattern.

<fileContent path="src/auth/AuthService.ts">
... (expanded file content) ...
</fileContent>
```

For short prompts that go inline (≤ 300 chars), show the inline argument value instead.

### Variables Applied

```
{{target}}  →  "auth"
{{model}}   →  (not set, using workflow default)
```

### End Condition (if set)

```
Script:      .flightpath/scripts/tests-pass.js
Returns:     "true"
Max retries: 3
```

---

## Implementation

### Core: `dryRunStep()`

The key insight is that prompt preparation (`CliPromptPreparer.preparePrompt`) and command
building (`ICliProvider.buildCommand`) are already separate from execution
(`CliExecutionRunner`). A dry run calls the first two but not the third.

Add a `dryRunStep(promptIndex: number): Promise<StepPreview>` method to
`CliIntegration` (or a new `CliDryRunCoordinator`):

```typescript
interface StepPreview {
  stepIndex: number;
  stepName: string | undefined;
  resolvedProperties: ResolvedProperties;
  command: string; // full CLI command string
  promptMode: "inline" | "tempFile";
  promptText: string; // resolved prompt (inline arg value or temp file content)
  tempFilePath: string | undefined;
  vars: Record<string, string>;
  endCondition: EndConditionPreview | undefined;
}
```

The temp files for a dry run should be written to a separate temp path (so content can be
inspected) but flagged for immediate cleanup after the preview is dismissed. Alternatively,
don't write temp files at all — just return the content that _would_ be written.

### Dashboard Integration

**Preview button** on each `PromptCard` component (alongside the existing Run / Skip / etc.
controls). Only visible when workflow is in idle/paused state (not while running).

Clicking Preview sends a `PREVIEW_STEP` message to the extension host, which calls
`dryRunStep()` on the active workflow's `CliIntegration`, and returns a `StepPreview`
payload. The dashboard renders it in a modal or expandable drawer below the prompt card.

The preview modal has:

- Tabs: **Command** | **Prompt** | **Properties**
- A **Copy command** button
- A **Copy prompt** button
- An **Open temp file** button (if temp file path is available)

### CLI Integration

In `src/cli.ts`, add `--dry-run` flag to the `run` command:

```typescript
.option("--dry-run", "Preview what commands would be run without executing")
```

When `--dry-run` is set, iterate each prompt step, call `dryRunStep()`, and print the
preview. With `--json`, output the full `StepPreview[]` array. Without `--json`, print a
formatted summary.

---

## What NOT to preview

- End condition script execution — don't run the script during preview
- Session ID resolution for `resumeSession: true` — show `(will resume latest session)`
  rather than resolving the actual session ID, which requires file system state at runtime
- Actual temp file creation — return content only, don't write to disk

---

## Effort

~2–3 days. `CliPromptPreparer` and `ICliProvider.buildCommand` already exist and are
testable in isolation. The main work is:

1. `dryRunStep()` method wiring the two stages together without executing
2. Dashboard message handler + preview modal component
3. CLI `--dry-run` flag + formatted output
