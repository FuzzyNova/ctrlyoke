# Unified Context-Resolution Failure Mode Plan

> **Status:** Not started — design settled, plumbing mapped, no code written yet.
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
`ConfigurationUtils` is what every other global toggle already uses.

### Secrets: `preflightWorkflowSecrets` is three checks, not one

`preflightWorkflowSecrets(workflow, platform, workspaceRoot, environment)`
(`src/utils/SecretResolver.ts:258`) currently does three distinct things, and
**only one of them should become conditional**:

1. `assertNoSecretInterpolationInPrompt` — rejects `${secret:X}` in prompt
   text. This is always an authoring error; keep it an unconditional throw.
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
if (mode === "fail" && prepared.diagnostics.length > 0) {
  throw new Error(prepared.diagnostics.map((d) => d.message).join(" "));
}
session.preparePrompt(prepared.promptWithInstruction, ...);       // :989 — spawn commits here
```

Recommend gating on `mode === "fail"` alone, **ignoring the stored
`severity`** field rather than filtering to `severity === ERROR`. Confirmed
(grep across `CliIntegration.ts`) that nothing today reads `severity` for
control flow — it's purely informational — so keeping severity and the new
mode as two independent axes would just be confusing. The mode _is_ the
blocking decision; treat every diagnostic in this array as blocking when
`"fail"` is active.

**2. `WorkflowExecutor.ts:723`**, right after
`mcpNormalization.diagnostics` is computed and reported, before
`context.getIntegrationForPrompt(...)` at `:725`:

```ts
if (mode === "fail" && mcpNormalization.diagnostics.length > 0) {
  throw new Error(mcpNormalization.diagnostics.map((d) => d.message).join(" "));
}
```

MCP diagnostics are always WARNING today (no severity variation), so no
filtering needed there either.

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

- [ ] **Phase 1 — Schema + config accessor.** Add `strictContextResolution` to
      `schemas/settings-schema.json` under `execution`; regenerate
      `schemas/settings-schema.yaml` if applicable (check for a generation
      script, same caution as `RAW_PROMPT_MODE_PLAN`'s note about
      `prompt-schema.yaml`). Add `ConfigurationUtils.getContextResolutionFailureMode()`.
- [ ] **Phase 2 — Make secret resolvability conditional.** Add the
      `failOnMissing` option to `preflightWorkflowSecrets`; wire
      `WorkflowInstance.ts:1558` to pass the resolved mode; leave
      `SecretCommands.ts:199` unconditional. Decide (a) vs (b) from the open
      question above — default to (a) unless there's a concrete reason not
      to. Update `src/test/unit/SecretResolver.test.ts` for the new default
      behavior (missing secret + `"warn"` no longer throws) without breaking
      existing "throws on missing" coverage (that coverage should move to the
      `failOnMissing: true` / default-call-signature case).
- [ ] **Phase 3 — Close the git-ref diagnostic gap.** Change
      `expandGitChanges`'s return shape, thread `skipped` into
      `expandContextSplit`'s `skippedReferences`. Add a unit test asserting a
      bad `~<hash>` produces an `UNRESOLVED_REFERENCE`-equivalent entry in
      `skippedReferences` (mirroring the existing `@file` missing-ref test
      pattern already used for `skippedReferences`).
- [ ] **Phase 4 — Per-step "fail" gate, `CliIntegration.ts`.** Insert the
      blocking check after diagnostics are logged/reported and before
      `session.preparePrompt(...)` spawns. Add a test forcing an unknown
      `/skill:`, an unresolved `@file`, and a missing `!NAME` (via
      `CliPromptPreparer`'s path, not the whole-workflow preflight) each to
      confirm they throw only when the mode is `"fail"`.
- [ ] **Phase 5 — Per-step "fail" gate, `WorkflowExecutor.ts`.** Same pattern
      for `mcpNormalization.diagnostics`, right before
      `getIntegrationForPrompt`. Add a test forcing an unknown `/mcp:` to
      confirm the same fail/warn split.
- [ ] **Phase 6 — Manual verification of the warning-row pipeline.** Run a
      workflow with a deliberately-broken `~<hash>` reference in `"warn"`
      mode and confirm a warning row appears in the Output pane via the
      existing `StatusMessage` path — this should require no new UI code per
      the section above; if it does, that's a sign an assumption in this plan
      was wrong and needs revisiting before continuing.
- [ ] **Phase 7 — Docs.** Update `.github/instructions/utils.instructions.md`
      or `core.instructions.md` (whichever ends up owning the new gate logic)
      with a short note on the two-chokepoint design and the "mode ignores
      stored severity" decision, since that's exactly the kind of non-obvious
      cross-file coupling the knowledge-capture rules call out.

## Files Likely Changed

| File                                                                             | Change                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `schemas/settings-schema.json`                                                   | Add `execution.strictContextResolution`                                                 |
| `src/utils/ConfigurationUtils.ts`                                                | Add `getContextResolutionFailureMode()`                                                 |
| `src/utils/SecretResolver.ts`                                                    | Add `failOnMissing` option to `preflightWorkflowSecrets`                                |
| `src/core/WorkflowInstance.ts`                                                   | Pass resolved mode into `preflightWorkflowSecrets`                                      |
| `src/cli/SecretCommands.ts`                                                      | No change (confirm it still calls with default `failOnMissing: true`)                   |
| `src/utils/ContextExpander.ts`                                                   | `expandGitChanges` returns `{ attachments, skipped }`; thread into `expandContextSplit` |
| `src/core/harness/CliIntegration.ts`                                             | Insert per-step "fail" gate before `session.preparePrompt(...)`                         |
| `src/core/WorkflowExecutor.ts`                                                   | Insert per-step "fail" gate after MCP diagnostics, before integration lookup            |
| `src/test/unit/SecretResolver.test.ts`                                           | Cover conditional resolvability throw                                                   |
| `src/test/unit/ContextExpander*.test.ts` (or `src/test/contextExpander.test.ts`) | Cover git-ref → `skippedReferences`                                                     |
| `src/test/unit/CliIntegration.test.ts`                                           | Cover the new "fail" gate for skill/file/secret diagnostics                             |
| `src/test/unit/WorkflowExecutor*.test.ts`                                        | Cover the new "fail" gate for MCP diagnostics                                           |
| `.github/instructions/*.instructions.md`                                         | Document the two-chokepoint gate + "mode ignores severity" decision                     |

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
- Manual: confirm the Output pane shows a warning row for a bad `~<hash>` ref
  in `"warn"` mode (Phase 6).

## Open Questions

- (a) vs (b) from "keep the timing asymmetry, or unify it?" above — needs a
  decision before Phase 2, not just a default.
- Should `UNKNOWN_SECRET_REFERENCE`'s existing explicit `ERROR` severity be
  left as-is (now genuinely meaningful once something reads it), removed
  (redundant once the gate ignores severity entirely), or repurposed as the
  signal the gate _does_ filter on instead of a blanket `mode === "fail"`
  check? This plan recommends the blanket check for simplicity, but an
  implementer should double-check nothing else was relying on that field
  staying `ERROR`-but-inert before changing what reads it.
- Exact wording/format for the thrown error message when multiple diagnostics
  block a single step (the plan above just joins `.message` with spaces,
  matching `preflightWorkflowSecrets`'s existing multi-name join style —
  worth a second look for readability with a large diagnostic count).
