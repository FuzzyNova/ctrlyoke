# `"unlimited"` Limit Values Plan

> **Status: REJECTED (2026-09-27).** The visible benefits of a word instead of `-1` (the UI
> saying "Unlimited" everywhere, and one label per concept) do not need the stored value to
> change. The shared Unlimited / Custom picker can write `-1`. That leaves only one benefit:
> people who edit JSON or YAML by hand would not need to remember `-1`, and schema hover text
> already tells them. The cost is permanent: every limit field becomes `number | "unlimited"` in
> TypeScript, so every reader has to narrow the type before comparing or doing arithmetic. The
> change would touch about 15 source files across six fields, plus the schema archive, the CLI
> flag and the tests.
>
> What survived, all stored as `-1`, moved into `dev/backlog/WORKFLOW_MAX_STEPS_PLAN.md`
> ("Limit presentation"):
> - the shared `LimitSelect` picker;
> - the §1.1 Unlimited vocabulary row and its test allowlist;
> - standardized "`-1` means unlimited" descriptions;
> - deleting the dead `errorBehavior.maxRetries === -1` branch.
>
> The inventory below is still accurate and is what that section works from.

## Goal

Replace every `-1` sentinel in the user-authored schemas with a word, **all in one change**, so
there is never a release where some limits say `-1` and others say `"unlimited"`:

- A limit with no bound becomes the literal **`"unlimited"`**.
- The one `-1` that means "never" (a threshold that is never reached) becomes **`"never"`**.

We are pre-release, so there are no shims. After this change, `-1` is a schema error on every
one of these fields.

## Why

`WORKFLOW_MAX_STEPS_PLAN.md` § "Writing unlimited" has the full argument. In short: the schema
offers the literal in autocompletion, so users have nothing to memorise; the UI option, the file,
the CLI flag, and the `workflow_status` output (which already prints `"unlimited"`) all use the
same word; and SCHEMA_UI_NAME_ALIGNMENT §1 rule 2 says one concept gets one spelling. A single
leftover `-1` would bring back the "remember the magic number" problem for that field.

## Inventory (verified 2026-09-27)

### `-1` → `"unlimited"`

| Field                                                                        | Today                                            | Code readers                                                                                                                         | UI                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| settings `execution.maxPromptTimeoutSec`                                     | `-1` unlimited, default `-1`                     | `ConfigurationUtils.ts`, `cli.ts`                                                                                                    | `ExecutionSection.tsx`                                                |
| CLI `-t, --timeout <seconds>`                                                | `-1` = unlimited (`CliRunCommandDefinitions.ts:164,215-218`) | same                                                                                                                                  | `docs/cli/ctrlyoke.md:80`                                             |
| settings `queue.maxWorkflowExecutionTimeSec`                                 | `-1` unlimited, default `-1`                     | `WorkflowExecutor.checkExecutionTimeLimit` (`:4708`), `ExecutionPreviewService.buildLimits` (`:1362`), `ConfigurationUtils.ts`        | `QueueSection.tsx` ("(seconds, -1 = unlimited)")                      |
| settings `runs.maxRuns`                                                      | `-1` keeps all runs, default `-1`                | `OutputHistoryManager.ts`, `RunSummaryCache.ts`, `ConfigurationUtils.ts`                                                             | `GeneralSection.tsx` ("Max runs to keep")                             |
| workflow `endCondition.maxRetries` (`scriptProperties`; also reached by `defaults.endCondition` through its `$ref`) | `-1` unlimited, `0` none, max 100 | `PromptQueue.ts:1362,1381`, `WorkflowExecutor.ts:3448,5025`, `ExecutionPreviewService.ts:1258`                                    | `ScriptConditionEditor.tsx` (also used by the Workflow Defaults page) |
| dry-run output `maxAttempts` (`ExecutionPreviewTypes.ts:242`)                | `-1` when retries are unlimited                  | `ExecutionPreviewService.ts:1258`                                                                                                    | CLI dry-run / preview JSON                                            |

### `-1` → `"never"`

| Field                                   | Today                                                  | Readers                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| settings `ui.outputVirtualizationRowThreshold` | `0` = always virtualize, `-1` = never virtualize | `useOutputVirtualization.ts`, `OutputSection.tsx`, `settingsStore.ts`, `WebviewSettingsSync.ts`, `ConfigurationUtils.ts`, `WebviewMessageTypes.ts`; UI in `GeneralSection.tsx` |

This field is not a limit. It answers "at how many rows does virtualization start?", and `-1`
answers "never". §1.1 already reserves **Never** for exactly this kind of answer. `0` stays: a
threshold of 0 rows already means "always", so it needs no special value.

### Dead code, removed in the same pass

`WorkflowExecutor.ts:391` checks `errorBehavior.maxRetries === -1`, but the schema declares
`errorBehavior.maxRetries` with `minimum: 1`. The branch can never run. Delete it rather than
converting it. If unlimited error retries are ever wanted, that is a schema decision.

### Out of scope, and why

- `runs.historySearchCacheMb`, where "0 disables the cache". A budget of 0 MB is a real value,
  not a sentinel.
- `CopilotUsageNormalization.ts:216`, where an entitlement of `-1` is Copilot's external API
  data, not our schema.
- Internal `-1` indexes (`finalStep` index, `indexOf` results). They are never authored by users.

## Design

### Schema (single source)

- `workflow-schema.json` `$defs.unlimited`: `{ "const": "unlimited", "description": "No limit." }`.
- `$defs.never`: the same shape for `"never"`.
- Each field becomes a `oneOf` of its existing integer branch (with the `-1` removed from the
  minimum, so seconds and runs get `minimum: 1` and `maxRetries` gets `minimum: 0`) and a
  `$ref` to `unlimited`. Settings fields reach it with sibling-schema `$ref`s
  (`workflow-schema.json#/$defs/unlimited`), following the §3b pattern.
- Descriptions say it directly, for example: "Seconds to wait for a prompt to complete, or
  `"unlimited"` for no limit."
- Settings defaults that are `-1` today become `"unlimited"`.
- **`schemas/archive/v1/` must be updated too.** `scripts/publish-schemas-to-landing.mjs`
  (`assertArchiveMatchesCurrent`) requires the archive to match `schemas/` byte-for-byte while v1
  is current. Copy the files into the archive after regenerating.

### Types and helpers (single source)

- `DashboardConstants.ts`: `LIMIT_SENTINELS = { UNLIMITED: "unlimited", NEVER: "never" } as const`.
  Reuse an existing `never` constant instead if one already exists for these enum values.
- `src/utils/LimitUtils.ts`: `type Limit = number | typeof LIMIT_SENTINELS.UNLIMITED`,
  `isUnlimited(limit)`, and `exceedsLimit(count, limit)`. Every reader listed above uses these
  helpers, and no reader compares against the literal or against `-1` itself.
  `WORKFLOW_MAX_STEPS_PLAN`'s `StepLimit` is this `Limit`.
- `CtrlYokeSettings.ts` field types become `Limit`, or `number | "never"` for the threshold, and
  their `// -1 = unlimited` comments are deleted.
- `ExecutionPreviewTypes.maxAttempts: Limit`.

### CLI

`--timeout` accepts a whole number of seconds ≥ 1, or `unlimited`. The error message and the help
text name the word.

### UI (single source)

`components/shared/LimitSelect.tsx` is a picker plus a number input, built from option metadata:

- **Unlimited / Custom**: for `maxPromptTimeoutSec`, `maxWorkflowExecutionTimeSec`, `maxRuns`,
  and `endCondition.maxRetries`.
- **Never / Custom**: for `outputVirtualizationRowThreshold`.
- An optional `inheritLabel` adds **Inherit (…)**, which `WORKFLOW_MAX_STEPS_PLAN` uses.

`MaxStepsSelect` from that plan is **this component**. Do not build a separate one.

The number input keeps each field's existing unit in its label ("seconds") and drops the
"-1 = …" suffixes. `ScriptConditionEditor` replaces its free-number `maxRetries` input with the
component, so the Workflow Defaults end-condition page picks it up automatically.

### Vocabulary test

In `SchemaUiMetadata.test.ts`, add a limit-path allowlist for the `unlimited` value, alongside
the existing timing allowlist for `never`. Add `ui.outputVirtualizationRowThreshold` to the
`never` allowlist. The allowlists keep "Unlimited" from spreading to non-limit enums.

## Steps (one change)

1. Schemas: `$defs.unlimited` / `$defs.never`, the field rewrites, descriptions, and defaults.
   Regenerate with `npm run generate-schema-docs`, `npm run generate-schema`, and
   `SchemaDescriptions.ts`, then mirror the result into `schemas/archive/v1/`.
2. `LIMIT_SENTINELS`, `LimitUtils.ts`, and the setting and preview types. Convert every reader in
   the inventory and delete the dead `errorBehavior.maxRetries === -1` branch.
3. CLI `--timeout`.
4. `LimitSelect` and the five UI sites.
5. Docs:
   - `docs/cli/ctrlyoke.md:80` and `docs/workflows/end-conditions.md:72`.
   - Every other hand-written `-1` mention (search `docs/`, `landing/` and `src/templates/`; the
     search for this plan found no templates that use `-1`).
   - `EXECUTION_GUARDRAILS_PLAN.md`'s "`-1` semantics" wording.
6. Tests:
   - A schema test that rejects `-1` and accepts `"unlimited"` or `"never"` on every inventoried
     field (`WorkflowSchema.test.ts` already covers these paths).
   - `LimitUtils` unit tests.
   - Reader tests that compare timeout, retry, and run pruning behaviour under `"unlimited"`
     with the old `-1` behaviour.
   - CLI `--timeout unlimited`, including the rejection of `-1`.
   - Vitest for `LimitSelect`, and the existing `ExecutionSection`, `useOutputVirtualization`,
     and `settingsStore` tests updated.

## Acceptance criteria

- No user-authored schema field accepts `-1` as a sentinel. `grep -- '"minimum": -1' schemas/`
  finds nothing.
- Every inventoried reader goes through `LimitUtils` or the `never` constant, with no remaining
  `=== -1` checks on these values.
- Every surface uses the same word: UI option, schema value, CLI flag, dry-run output, and
  `workflow_status`.
- `schemas/archive/v1/` matches `schemas/`, and `npm run check:docs` passes.
