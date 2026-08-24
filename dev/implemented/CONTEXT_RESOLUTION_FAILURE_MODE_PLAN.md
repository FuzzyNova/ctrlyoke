# Unified Context-Resolution Failure Mode Plan

> **Status:** Implemented — Phases 1–8 complete and re-verified against the
> code (2026-08-19), including the review-pass removal of the prompt-text
> interpolation hard-fail (Phase 8).
> **Priority:** P2 — real gap (silent git-ref failures), but not urgent.
> **Origin:** Grew out of the `!DOCTYPE` backtick-masking bug fix. See the
> session that produced this plan for the full discussion; short version below.

## Problem

ctrlyoke has five categories of "declared reference that might not resolve":

1. `!NAME` inline secret grants
2. `/skill:name` inline skill force-attach
3. `/mcp:name` inline MCP server force-attach
4. `@file` / `#selection:` / `#sym:` context references
5. `~diff` / `~staged` / `~stash:N` / `~<hash>` git change references

Today these are handled **inconsistently**, and the inconsistency was never a
deliberate design — it's just how each feature happened to ship:

| Category     | Where checked                                                                                                  | Severity              | Blocks execution?                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| Secrets      | `preflightWorkflowSecrets` (whole-workflow, pre-spawn)                                                         | N/A — throws directly | **Yes** — hard stop before any step runs                                                 |
| Secrets      | `CliPromptPreparer`'s `UNKNOWN_SECRET_REFERENCE` (per-step, live)                                              | ERROR (explicit)      | **No** — dead code, rides the same report-only pipe as warnings                          |
| Skills       | `CliPromptPreparer`'s `UNKNOWN_SKILL_REFERENCE`                                                                | WARNING (default)     | No                                                                                       |
| MCP          | `McpServerNormalizer`'s `prompt.mcp.unknown`                                                                   | WARNING (hardcoded)   | No                                                                                       |
| `@`/`#` refs | `CliPromptPreparer`'s `UNRESOLVED_REFERENCE` (from `ContextExpander.expandContextSplit`'s `skippedReferences`) | WARNING (default)     | No                                                                                       |
| `~` git refs | **nothing** — `ContextExpander.expandGitChanges` catches the failure and only `Log.warn`s it                   | —                     | No — and it's the only category with **zero** user-visible signal, not even a diagnostic |

The bug that started this thread (`<!DOCTYPE>` hard-failing a commit-message
run) happened because secrets are the _only_ category with real teeth. But
the user's own counter-example is the stronger argument for fixing this
properly: **running an outdated worktree and referencing a commit that
doesn't exist there via `~<hash>` fails exactly as silently as any other
missing git ref — worse than the secrets case, because there isn't even a
warning row.** The "this could prevent the tool from doing its job" bar the
secrets hard-fail was built on applies equally to all five categories; only
secrets got the enforcement.

## Product Decision

Add **one new global-only setting**, not five, and not a per-workflow
property:

```json
"execution": {
  "properties": {
    "strictContextResolution": {
      "type": "string",
      "enum": ["warn", "fail"],
      "default": "warn",
      "description": "How to handle a declared reference that fails to resolve: a missing/invalid secret (!NAME), an unknown skill (/skill:) or MCP server (/mcp:), an unresolved @file/#selection/#sym reference, or an unresolved ~diff/~staged/~stash/~<hash> git reference. 'warn' (default) reports a diagnostic and lets the step run anyway. 'fail' stops the step before the harness spawns, naming the unresolved reference."
    }
  }
}
```

- **Default `"warn"`** — this is a deliberate loosening of today's secrets
  behavior, not just a tightening of everything else. A missing secret will
  no longer hard-fail the whole workflow by default; it'll warn and let the
  step run (the step's own attempt to use the credential will likely fail on
  its own, in its own turn, which is an acceptable, more forgiving default
  than blocking pre-spawn). Users who want the old strict guarantee — or want
  it extended to skills/mcp/file/git refs too — opt in with `"fail"`.
- **Global-only, not per-workflow.** This is a personal risk-tolerance
  setting, not a property of workflow correctness — it shouldn't travel with
  a shared workflow file the way `secrets`/`skills` do. No resolver
  precedence, no `null`-clearing semantics, no `defaults.*` schema entry. Read
  directly via `ConfigurationUtils`, same shape as
  `isHeuristicSecretRedactionEnabled()`.
- **`ctrlyoke secret check` stays unconditionally strict**, regardless of this
  setting. Its entire purpose is "would this fail" — a CI check that silently
  passes because the local machine's `execution.strictContextResolution` is
  `"warn"` would defeat the command.
- **The `~diff`/`~staged`/`~stash`/`~<hash>` diagnostic gap gets closed
  regardless of which mode is active.** Even in `"warn"` mode, a missing git
  ref should produce a visible warning row — today it produces _nothing_,
  which is strictly worse than every other category's current behavior and
  isn't something this setting should gate.

## Plumbing (mapped, not yet implemented)

### Reading the setting

`ConfigurationUtils` is the right layer — it wraps the platform-agnostic
`configService` singleton (`src/config/CtrlYokeConfigService.ts`, no `vscode`
import), which both `extension.ts` and `cli.ts` wire up at their respective
entrypoints before any config read happens. This is already proven CLI-safe
by the existing precedent:

```ts
// src/utils/ConfigurationUtils.ts:780-784 (existing precedent)
isHeuristicSecretRedactionEnabled(): boolean {
  return configService.get(CONFIG_KEYS.PERMISSIONS).heuristicSecretRedactionEnabled;
},
```

Add the mirror for the new setting under the already-existing
`CONFIG_KEYS.EXECUTION`:

```ts
getContextResolutionFailureMode(): "warn" | "fail" {
  return configService.get(CONFIG_KEYS.EXECUTION).strictContextResolution ?? "warn";
},
```

No new plumbing layer needed — `PlatformAdapter.getConfig?()` was considered
and rejected as the injection point; it's CLI-adapter-specific and
`ConfigurationUtils` is what every other global toggle already uses. Verified
that all three consuming files already import `ConfigurationUtils` today
(`WorkflowInstance.ts:1565`, `WorkflowExecutor.ts:51`, `CliIntegration.ts`),
so no new import risk and nothing to prove about CLI safety.

The schema is **not** the only declaration site. A settings key lives in three
places that must stay in sync, plus the dashboard:

- `schemas/settings-schema.json` — the `execution` block at `:496`.
- `src/types/CtrlYokeSettings.ts` — the `execution` interface member (`:136`)
  **and** the `CTRLYOKE_SETTINGS_DEFAULTS.execution` literal (`:379`), which is
  where `"warn"` actually becomes the default. The `?? "warn"` in the accessor
  is belt-and-braces; the defaults object is the real source.
- `src/ui/webview-react/components/settings/ExecutionSection.tsx` — every
  neighbouring `execution.*` key has a row here, so this one needs one too or
  the setting is unreachable outside hand-edited JSON.

Note this is the first **enum-valued** global setting in that section; the
existing rows are `SettingToggleRow` (boolean) and `SettingInputRow` (number
input passed as a child). There is no select-row component in
`components/settings/` today. Prefer rendering a plain `<select>` as a child of
`SettingInputRow` — that's the established escape hatch for non-toggle
controls — rather than inventing a `SettingSelectRow` for a single use.

### Secrets: `preflightWorkflowSecrets` is three checks, not one

`preflightWorkflowSecrets(workflow, platform, workspaceRoot, environment)`
(`src/utils/SecretResolver.ts:258`) currently does three distinct things, and
**only one of them should become conditional**:

1. `assertNoSecretInterpolationInPrompt` — rejects `${secret:X}` in prompt
   text. ~~This is always an authoring error; keep it an unconditional
   throw.~~ **Reversed during review — see Phase 8.** This was wrong: prompt
   text frequently _documents_ the syntax (this very plan does), and the check
   cannot tell an author who expects substitution from a prompt that merely
   quotes the token. It hard-failed several legitimate runs of this workflow.
   It is now a non-blocking advisory diagnostic.
2. Grant-consistency check on MCP/hook/script env maps (`${secret:NAME}`
   referenced but not granted to the step). Also always an authoring error;
   keep it an unconditional throw.
3. `findMissingSecretNames(grants)` → throws `MissingSecretError`. **This is
   the actual "did it resolve" check** — this is the one the new setting
   should govern.

Recommended shape: add an options parameter defaulting to today's behavior so
neither existing caller needs to change:

```ts
preflightWorkflowSecrets(
  workflow, platform, workspaceRoot, environment = process.env,
  { failOnMissing = true }: { failOnMissing?: boolean } = {}
)
```

- `WorkflowInstance.ts:1558` (the run path) passes
  `{ failOnMissing: mode === "fail" }`.
- `src/cli/SecretCommands.ts:199` (`secret check`) passes nothing, keeping
  `failOnMissing: true` always.
- When `failOnMissing` is `false` and names are missing, the function needs to
  report instead of throwing — either return the missing-names list for the
  caller to turn into a diagnostic, or accept a diagnostic-reporting callback.
  Exact shape is an implementation-time call; both are small.

### Open design question: keep the timing asymmetry, or unify it?

Secrets are the only category with a **whole-workflow, before-step-1** check
today (`preflightWorkflowSecrets`, called once from
`WorkflowInstance.executeLoadedPromptFile`). The other four categories are
only ever evaluated **live, per-step**, inline inside
`CliPromptPreparer`/`McpServerNormalizer` as each step's prompt is actually
being prepared for spawn — there is no whole-workflow upfront pass for them
today, and building one would mean duplicating resolution logic that
currently only exists inside those per-step live paths.

Two options:

- **(a) Keep the asymmetry (recommended).** Secrets keep their existing
  whole-workflow upfront check (now conditional on the setting); skills/mcp/
  file/git get a new **per-step** gate (see below). Outcome is the same
  (nothing runs without ctrlyoke naming what's missing before it matters),
  just at different granularity — secrets fail before step 1, others fail
  right before the specific step that needed them. Smallest diff, no
  duplicated resolution logic, doesn't touch `preflightWorkflowSecrets`'s
  existing test coverage shape.
- **(b) Full uniformity.** Strip the resolvability throw out of
  `preflightWorkflowSecrets`'s run-path usage entirely and let secrets flow
  through the same per-step gate as everything else. Slightly bigger diff,
  and a real (minor) regression: in `"fail"` mode, a secret only needed by
  step 3 would no longer abort before step 1 runs — you'd burn two step's
  worth of harness turns before finding out. `secret check` is unaffected
  either way (it doesn't run steps).

Recommend (a) unless a future implementer has a reason to prefer full
uniformity over the (small) inconsistency.

### The per-step "fail" gate: two chokepoints, not one

The four non-secret categories are computed at two different moments in two
different files, so the gate needs two small, symmetric insertions:

**1. `CliIntegration.ts:961-993` (`initializeExecutionSession`)** — covers
skills, `@`/`#`/`~` refs (once the git-ref gap below is closed), and
`CliPromptPreparer`'s secret diagnostic, since they're already unified into
one `prepared.diagnostics` array:

```ts
const prepared = await this.promptPreparer.preparePrompt(...);   // :965
// existing: log + report each diagnostic
const blocking = prepared.diagnostics.filter((d) =>
  isContextResolutionDiagnostic(d.code)
);
if (mode === "fail" && blocking.length > 0) {
  throw new Error(/* see message format below */);
}
session.preparePrompt(prepared.promptWithInstruction, ...);       // :989 — spawn commits here
```

**Filter on diagnostic `code`, not on severity and not on "any diagnostic".**
An earlier draft of this plan recommended blocking whenever
`prepared.diagnostics` was non-empty. That is wrong: `prepared.diagnostics` is
a **mixed** array. `CliPromptPreparer` defines eight codes
(`CliPromptPreparer.ts:58-66`) and only four of them describe a declared
reference that failed to resolve:

| Code                                            | Resolution failure?                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `prompt.skill.unknown`                          | yes                                                                    |
| `prompt.secret.unknown`                         | yes                                                                    |
| `prompt.reference.unresolved`                   | yes                                                                    |
| `prompt.mcp.unknown` (other file)               | yes                                                                    |
| `prompt.reference.implausibly-large`            | no — advisory                                                          |
| `prompt.content.over-inline-cap`                | no — content was truncated, not lost                                   |
| `prompt.reference.source-runtime-disclosure`    | no — advisory                                                          |
| `prompt.reference.condition-output-unavailable` | no — a prior step produced no output; not a declared-reference failure |

Blocking on the whole array would mean a user in `"fail"` mode gets their step
killed because an attachment was large enough to truncate — unrelated to this
feature and a clear over-reach.

Severity stays out of the decision: confirmed by grep that nothing in
`CliIntegration.ts` reads `severity` for control flow, and
`UNKNOWN_SECRET_REFERENCE` is the only code that sets a non-default severity.
Leave severity exactly as it is (informational, drives the Output-pane row
styling) and make **code** the single axis the gate switches on.

That means the code set must become a shared, exported single source rather
than the module-local `PROMPT_DIAGNOSTIC_CODES` const it is today, and
`McpServerNormalizer.ts:168`'s hardcoded `code: "prompt.mcp.unknown"` string
literal must come from that same source — otherwise the gate would be
switching on hardcoded strings, which the project's coding principles forbid.

**2. `WorkflowExecutor.ts:723`**, right after
`mcpNormalization.diagnostics` is computed and reported, before
`context.getIntegrationForPrompt(...)` at `:725`:

```ts
const blocking = mcpNormalization.diagnostics.filter((d) =>
  isContextResolutionDiagnostic(d.code)
);
if (mode === "fail" && blocking.length > 0) {
  throw new Error(/* same message format as the other chokepoint */);
}
```

`McpServerNormalizer` only emits `prompt.mcp.unknown` today, so the filter is
a no-op there right now — but use the same shared predicate anyway so a future
advisory MCP diagnostic doesn't silently start blocking steps.

### Error message format

Both chokepoints must format identically, so put the message construction in
one shared helper next to the predicate. Join with **newlines**, not spaces,
under a short lead line — a step with four unresolved references produces four
sentences, and space-joining them (the style
`preflightWorkflowSecrets` uses for its name list) is unreadable at that size:

```
Step blocked by execution.strictContextResolution="fail" — 2 references did not resolve:
  • Skill "foo" referenced by /skill:foo was not found among discovered skills.
  • Reference "~abc1234" could not be attached: <reason>
```

### Closing the silent git-ref gap (needed in both modes)

`ContextExpander.expandGitChanges` (`src/utils/ContextExpander.ts:750-820`)
currently returns `Promise<string[]>` and on failure only `Log.warn`s —
nothing propagates to a diagnostic. Its only caller with a
`skippedReferences` array already in scope is `expandContextSplit`
(`:489-490`).

Minimal fix — change the return shape and thread failures into the array that
already exists for this exact purpose:

```ts
// Before
private async expandGitChanges(refs): Promise<string[]>

// After
private async expandGitChanges(refs): Promise<{
  attachments: string[];
  skipped: SkippedReference[];
}>
```

Push a `{ ref, reason }` into `skipped` in the existing catch block instead of
only logging, and at the `expandContextSplit` call site:

```ts
const gitResult = await this.expandGitChanges(gitRefs);
excerptParts.push(...gitResult.attachments);
skippedReferences.push(...gitResult.skipped);
```

Because `skippedReferences` already flows untouched through `SplitContext` →
`CliPromptPreparer.ts:244-251`'s existing `unresolvedReferenceDiagnostics`
map, **this requires no new diagnostic code at all** — a failed git ref
automatically becomes a normal `UNRESOLVED_REFERENCE` WARNING, identical
treatment to a failed `@file` ref, and therefore automatically covered by the
per-step gate above once it's added. `expandContext`'s non-split call site
(`:242`) doesn't have a `skippedReferences` concept; it can discard the new
`skipped` field — `CliPromptPreparer` routes through `expandContextSplit`
exclusively (confirmed: `sections.skippedReferences` is read at
`CliPromptPreparer.ts:244`), so that path is the one that matters.

## OutputPane warning row — mostly already built

The user asked for a warning row in
`src/ui/webview-react/components/layout/output-section/OutputPane.tsx` "like
we do for other things." **Checked: this infrastructure already exists and is
already wired for four of the five categories.**

`CliPromptPreparer`'s and `McpServerNormalizer`'s diagnostics both already
flow through `reportCompatibilityDiagnostics(diagnostics)` →
`dashboardSink.updateStatusMessage(stepIndex, message, severity, ...)` → a
`rowKind: "status"` row → the existing `<StatusMessage>` component
(`src/ui/webview-react/components/output/StatusMessage.tsx`), which already
has `warning`/`error`/`info` severity styling. The exact same pipeline already
renders the worktree-fallback notice today
(`WorkflowInstance.ts:1960-1970`: `dashboardSink?.updateStatusMessage(stepIndex, worktreeNotice, STATUS_MESSAGE_SEVERITY.WARNING, ...)`).

So: **no new UI component work is expected.** Once the git-ref gap above is
closed, a missing `~<hash>` ref automatically gets a warning row for free,
through the same path an unknown `/skill:` or unresolved `@file` already use
today. The only verification task is confirming (manually, once the plumbing
above lands) that the new/gated diagnostics actually render as expected —
this is regression-testing existing plumbing, not building new plumbing.

If `"fail"` mode is active and a step is blocked, that's a different,
already-existing pattern — the thrown error surfaces the same way any other
step failure does today (not a warning row; an actual failure/error state).

## Implementation Phases

- [x] **Phase 1 — Schema + settings type + accessor + shared diagnostic codes.**
      Add `strictContextResolution` to `schemas/settings-schema.json` under
      `execution` (`:496`), to the `execution` interface and
      `CTRLYOKE_SETTINGS_DEFAULTS` in `src/types/CtrlYokeSettings.ts`, and as a
      row in `ExecutionSection.tsx`. Add
      `ConfigurationUtils.getContextResolutionFailureMode()`. Also promote the
      resolution-failure diagnostic codes to a shared exported source and point
      `CliPromptPreparer`/`McpServerNormalizer` at
      `src/types/DashboardConstants.ts`, with the
      `isContextResolutionDiagnostic` predicate + shared message formatter the
      two gates will use. (There is **no** `schemas/settings-schema.yaml` —
      only `workflow-schema.yaml` has a YAML twin. Nothing to regenerate.)
- [x] **Phase 2 — Make secret resolvability conditional.** Add the
      `failOnMissing` option to `preflightWorkflowSecrets`; wire
      `WorkflowInstance.ts:1558` to pass the resolved mode; leave
      `SecretCommands.ts:199` unconditional. **Decision: (a)** — keep the
      timing asymmetry (see Resolved Decisions below). Update `src/test/unit/SecretResolver.test.ts` for the new default
      behavior (missing secret + `"warn"` no longer throws) without breaking
      existing "throws on missing" coverage (that coverage remains covered by
      the default and explicit `failOnMissing: true` call signatures). In
      `"warn"` mode, the run path surfaces returned missing names through the
      dashboard warning-status pipeline; `secret check` remains strict.
- [x] **Phase 3 — Close the git-ref diagnostic gap.** Change
      `expandGitChanges`'s return shape, thread `skipped` into
      `expandContextSplit`'s `skippedReferences`. Add a unit test asserting a
      bad `~<hash>` produces an `UNRESOLVED_REFERENCE`-equivalent entry in
      `skippedReferences` (mirroring the existing `@file` missing-ref test
      pattern already used for `skippedReferences`).
- [x] **Phase 4 — Per-step "fail" gate, `CliIntegration.ts`.** Inserted the
      code-filtered blocking check after diagnostics are logged/reported and
      before `session.preparePrompt(...)` spawns. Tests force an unknown
      `/skill:`, an unresolved `@file`, and a missing `!NAME` through
      `CliPromptPreparer`'s diagnostic path (not the whole-workflow preflight),
      verify the fail/warn split and warn-mode reporting, and confirm a
      non-resolution diagnostic (`prompt.content.over-inline-cap`) does
      **not** block even in `"fail"` mode. The tests also verify that blocking
      occurs before session preparation.
- [x] **Phase 5 — Per-step "fail" gate, `WorkflowExecutor.ts`.** Applied the
      same code-filtered gate for `mcpNormalization.diagnostics`, immediately
      before `getIntegrationForPrompt`, with a shared assertion helper reused
      by retry prompts so retries cannot bypass strict mode. Tests force an
      unknown `/mcp:` and confirm the same fail/warn split, reporting, and
      no-integration lookup in fail mode.
- [x] **Phase 6 — Verify the warning-row pipeline.** Assert by test that a
      failed `~<hash>` ref reaches `reportCompatibilityDiagnostics` →
      `updateStatusMessage` with WARNING severity in `"warn"` mode, which is
      what the `StatusMessage` row renders from. Per the section above this
      should require no new UI code; if it does, an assumption in this plan was
      wrong and needs revisiting before continuing. Visual confirmation in a
      live VS Code window is left to the user — do not claim it was done.
- [x] **Phase 7 — Docs.** Updated
      `.github/instructions/harness-integrations.instructions.md` with the
      two-chokepoint design, code-based predicate, and separate secret-check
      behavior.

- [x] **Phase 8 — Remove the prompt-text interpolation hard-fail** (added
      during the review pass, from direct user feedback: this run itself failed
      repeatedly because orchestrator prompts quoted `${secret:X}` while
      describing the feature). `assertNoSecretInterpolationInPrompt` became
      `findSecretInterpolationsInPrompt`, which only detects and never throws.
      Its four `preflightWorkflowSecrets` call sites were removed outright; the
      two live `WorkflowExecutor` call sites (the step path and the retry path)
      now report a `prompt.secret.interpolation-ignored` WARNING through
      `reportCompatibilityDiagnostics`, so the author still learns the token is
      passed through verbatim. **The advisory is deliberately excluded from
      `isContextResolutionDiagnostic`, so it never blocks a step even in
      `"fail"` mode** — nothing failed to _resolve_ here; prompt bodies simply
      are not a resolution boundary. The env-map grant-consistency throw
      (check 2) is unchanged: those maps really do interpolate, so an ungranted
      name there remains a genuine error.

**Implementation note:** Phase 6 matched the design: the end-to-end test
confirmed that no new UI or diagnostic plumbing was needed. No feature design
deviations were found. The test verifies the extension-host warning dispatch;
visual confirmation in a live VS Code window remains a user task. During the
required full-suite gate, the extension-test runner's default timeout was
raised from 2 seconds to 10 seconds because cold Windows Git/CLI subprocesses
legitimately exceeded the old limit; this is test infrastructure only.

## Files Likely Changed

| File                                                                             | Change                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/settings-schema.json`                                                   | Add `execution.strictContextResolution`                                                                                                                 |
| `src/types/CtrlYokeSettings.ts`                                                  | Add the `execution` interface member + `CTRLYOKE_SETTINGS_DEFAULTS` entry (`"warn"`)                                                                    |
| `src/ui/webview-react/components/settings/ExecutionSection.tsx`                  | Add the settings row (enum `<select>` inside `SettingInputRow`)                                                                                         |
| `src/utils/ConfigurationUtils.ts`                                                | Add `getContextResolutionFailureMode()`                                                                                                                 |
| `src/types/DashboardConstants.ts`                                                | Shared prompt diagnostic codes, resolution predicate, and failure-message formatter                                                                     |
| `src/core/harness/shared/CliPromptPreparer.ts`                                   | Point prompt preparation at the shared diagnostic codes                                                                                                 |
| `src/utils/McpServerNormalizer.ts`                                               | Replace the hardcoded `"prompt.mcp.unknown"` literal with the shared constant                                                                           |
| `src/utils/SecretResolver.ts`                                                    | Add `failOnMissing` option to `preflightWorkflowSecrets`; replace the prompt-text interpolation throw with `findSecretInterpolationsInPrompt` (Phase 8) |
| `src/core/WorkflowInstance.ts`                                                   | Pass resolved mode into `preflightWorkflowSecrets`                                                                                                      |
| `src/cli/SecretCommands.ts`                                                      | No change (confirm it still calls with default `failOnMissing: true`)                                                                                   |
| `src/utils/ContextExpander.ts`                                                   | `expandGitChanges` returns `{ attachments, skipped }`; thread into `expandContextSplit`                                                                 |
| `src/core/harness/CliIntegration.ts`                                             | Insert per-step "fail" gate before `session.preparePrompt(...)`                                                                                         |
| `src/core/WorkflowExecutor.ts`                                                   | Insert per-step "fail" gate after MCP diagnostics, before integration lookup                                                                            |
| `src/test/unit/SecretResolver.test.ts`                                           | Cover conditional resolvability throw                                                                                                                   |
| `src/test/unit/ContextExpander*.test.ts` (or `src/test/contextExpander.test.ts`) | Cover git-ref → `skippedReferences`                                                                                                                     |
| `src/test/unit/CliIntegration.test.ts`                                           | Cover the new "fail" gate for skill/file/secret diagnostics                                                                                             |
| `src/test/unit/WorkflowExecutor*.test.ts`                                        | Cover the new "fail" gate for MCP diagnostics                                                                                                           |
| `.github/instructions/*.instructions.md`                                         | Document the two-chokepoint gate + "mode ignores severity" decision                                                                                     |

## Testing

- Unit: `preflightWorkflowSecrets` with `failOnMissing: false` reports instead
  of throwing; `failOnMissing: true` (default) throws exactly as today.
- Unit: `secret check` CLI command still throws on a missing secret
  regardless of the global setting (it never reads it).
- Unit: bad `~<hash>` ref lands in `skippedReferences` alongside bad `@file`
  refs.
- Unit: `CliIntegration`'s per-step gate throws in `"fail"` mode for each of
  skill/file/secret diagnostics, and does not throw in `"warn"` mode (today's
  behavior, unchanged).
- Unit: `WorkflowExecutor`'s per-step gate throws in `"fail"` mode for an
  unknown `/mcp:`, and does not throw in `"warn"` mode.
- Unit: an advisory diagnostic (`prompt.content.over-inline-cap`,
  `prompt.reference.condition-output-unavailable`) does **not** block a step
  even in `"fail"` mode — this is the regression the code filter exists to
  prevent.
- Unit: a prompt quoting `${secret:X}` runs to completion and reports a
  `prompt.secret.interpolation-ignored` advisory, in both modes; preflight
  returns no missing names for it (Phase 8).
- Manual: confirm the Output pane shows a warning row for a bad `~<hash>` ref
  in `"warn"` mode (Phase 6).

## Resolved Decisions

All three former open questions are settled; implementers should follow these
rather than re-opening them.

1. **(a) vs (b) — keep the timing asymmetry, option (a).** Secrets keep their
   whole-workflow pre-step-1 check (now conditional on the setting); the other
   four categories get the per-step gate. (b)'s only benefit is uniformity, and
   it costs a real regression: in `"fail"` mode a secret needed only by step 3
   would burn two steps' worth of harness turns before failing.
2. **The gate switches on diagnostic `code`, not severity, and not "any
   diagnostic present".** See the chokepoint section above for why — the
   blanket check would block on unrelated advisory diagnostics such as
   `prompt.content.over-inline-cap`. `UNKNOWN_SECRET_REFERENCE` keeps its
   `ERROR` severity unchanged; severity stays purely informational and keeps
   driving the Output-pane row styling.
3. **Error message format:** newline-joined bullets under a lead line naming
   the setting and the count — not the space-joined style
   `preflightWorkflowSecrets` uses. Both chokepoints share one formatter.
