# Conditional Steps Plan

## Problem

A user running the same workflow against different targets often needs to skip certain
steps depending on context. Today this requires maintaining multiple workflow files with
slightly different step lists, or using a script to generate the YAML dynamically.

Simple step-level conditions — "only run this step if a var is set to a certain value" —
would eliminate the need for workflow variants in most cases.

---

## Design Principle: Simple, Not a Language

The goal is a lightweight skip mechanism, not an expression language. GitHub Actions
`if:` expressions, Ansible `when:` clauses, and Helm template conditionals are all
cautionary tales of YAML scripting that grows unmanageable.

The right scope: **boolean values and `{{var}}` string comparisons only.** Anything
more complex belongs in a `type: script` step that sets a var, or in external orchestration
using the CLI's `--var` flag.

---

## Schema: `enabled` Field on `PromptItem`

```yaml
prompts:
  - name: setup
    prompt: Read the codebase.

  - name: security-scan
    enabled: "{{runSecurity}}"   # skipped if --var runSecurity=false (or not set)
    prompt: Scan for vulnerabilities.

  - name: implement
    enabled: true                # explicit true — always runs (default)
    prompt: Implement the feature.

  - name: cleanup
    enabled: false               # explicitly disabled — useful for temporarily skipping
    prompt: Clean up temp files.
```

### Type and Resolution

```typescript
// In PromptItem
enabled?: boolean | string;  // default: true (undefined = enabled)
```

**Resolution rules (evaluated at step dispatch time):**

| `enabled` value         | Runs? |
|-------------------------|-------|
| `undefined` / `true`    | Yes   |
| `false`                 | No    |
| `"true"` / `"1"` / `"yes"` (case-insensitive) | Yes |
| `"false"` / `"0"` / `"no"` (case-insensitive) | No |
| `"{{var}}"` where var resolves to a truthy string | Yes |
| `"{{var}}"` where var resolves to a falsy string  | No |
| `"{{var}}"` where var is not set (no default)     | **Skip** (treat as false) |

String values go through `{{var}}` substitution first, then the truthy/falsy string
check. This means `enabled: "{{runSecurity}}"` is the idiomatic way to make a step
conditional on a CLI flag.

**No expression evaluation** — `enabled: "{{count}} > 0"` is not supported. The resolved
string is tested as a boolean string only, not evaluated as an expression.

---

## CLI Usage

```bash
# Run workflow, skipping the security scan step
flightpath run workflow.yaml --var "runSecurity=false"

# Run workflow, including the security scan
flightpath run workflow.yaml --var "runSecurity=true"

# Skip step explicitly in the YAML (no --var needed)
# enabled: false in the YAML file
```

---

## Skip Behavior

A skipped step:
- Does **not** execute the AI prompt
- Does **not** consume a session slot or affect `resumeSession` continuity for the *next* step
  (the next step that runs behaves as if the skipped step didn't exist)
- Shows as **Skipped** in the dashboard step list (distinct visual state from Completed/Error)
- Counts toward total step count in the status bar label but is not counted in "completed"
- Is included in `--json` output with `"status": "skipped"` and `"enabled": false`

### Session Continuity Note

`resumeSession: true` on the step *after* a skipped step resumes from the last
**executed** step's session, not the skipped step. `WorkflowExecutor` must track
"last executed session ID" separately from "last step index."

---

## Dashboard

Skipped steps in the prompt list show:
- A distinct visual treatment (muted/strikethrough or a skip icon)
- The evaluated condition result (e.g. `enabled: false` or `{{runSecurity}} → "false"`)
- No Run/Retry controls — skipped steps cannot be manually run from the dashboard
  (to run a skipped step, change `enabled` or pass a different `--var`)

The **Preview** button (from `DRY_RUN_PREVIEW_PLAN.md`) should indicate which steps would
be skipped given the current vars before running.

---

## Implementation

### `PropertyResolver` extension

`enabled` resolution follows the same `{{var}}` substitution pipeline as prompt text.
Add a `resolveEnabled(prompt: PromptItem): boolean` method to `PropertyResolver` that:
1. If `enabled` is `undefined` or `true` → return `true`
2. If `enabled` is `false` → return `false`
3. If `enabled` is a string → substitute `{{vars}}`, then evaluate as boolean string

### `WorkflowExecutor` skip logic

Before dispatching a step, call `resolveEnabled()`. If `false`, emit a
`STEP_STATUS.SKIPPED` state transition for that step and advance the queue index. This
must also update "last executed session" tracking for `resumeSession` continuity.

### Schema changes

- Add `enabled?: boolean | string` to `PromptItem` in `FlightPathTypes.ts`
- Add to `schemas/prompt-schema.json` with description and examples
- Run `npm run generate-schema` to regenerate YAML schema

### `STEP_STATUS.SKIPPED`

Add `SKIPPED: "skipped"` to `STEP_STATUS` in `DashboardConstants.ts`. Update the
dashboard `PromptCard` to render the skipped state.

---

## What NOT to build

- Expression evaluation (`{{count}} > 0`, `{{a}} === {{b}}`)
- Multi-condition logic (`enabled: "{{a}} && {{b}}"`)
- Dynamic re-evaluation mid-run (enabled is evaluated once at dispatch time)
- `disabled` alias (just use `enabled: false`)

These are all achievable with a `type: script` step that sets a var, combined with
`enabled: "{{resultVar}}"` on the dependent steps.

---

## Effort

~1 day. The `{{var}}` substitution pipeline already exists in `PropertyResolver`. The
main work is:
1. `resolveEnabled()` in `PropertyResolver`
2. Skip logic in `WorkflowExecutor` (including session continuity fix)
3. `STEP_STATUS.SKIPPED` constant + dashboard visual
4. Schema update
