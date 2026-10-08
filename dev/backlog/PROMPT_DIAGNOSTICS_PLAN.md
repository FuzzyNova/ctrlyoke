# Prompt Diagnostics Plan

**Status (2026-10-08):** Phases 1 and 2 done (shared rules extracted; VS Code provider live for `.prompt.md` and workflow prompt values). Phase 3 is proposed, and its workflow-context half already landed in Phase 2.

**Priority:** P2. The rules already exist and work in the dashboard. This plan makes them
shareable and brings them to VS Code, where today a broken or literal reference gives no
signal at all.

**Sequencing:**
[`EDITOR_INTELLIGENCE_STAGING_PLAN.md`](EDITOR_INTELLIGENCE_STAGING_PLAN.md) orders this plan
against the ctrlyoke file support and markdown highlighting plans.

**Related plans and bugs:**

- [`WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md`](WORKSPACE_EDITOR_CTRLYOKE_FILE_SUPPORT_PLAN.md):
  its `getWorkflowLocation` supplies exact rule context and prompt ranges for workflow files.
  Its Phase 5 uses this plan's rules in the workspace editor and adds the schema validation
  this plan reuses in Phase 3.
- [`PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md`](PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md):
  its Phase 2 precedence rule keeps these diagnostics above markdown styling.
- [`vscode-prompt-references-active-inside-code`](../bugs/implemented/vscode-prompt-references-active-inside-code.md):
  fixes VS Code links and completions inside code. Its warning follow-up is this plan's
  Phase 2.

## Problem

The dashboard prompt editor (`CodeMirrorEditor.tsx`) runs three families of prompt-text lint
rules. VS Code's native editor runs none of them.

**Context references** (`createContextReferenceLintExtension`):

- A reference that doesn't resolve: missing file or directory, symbol, git ref, and so on. The
  message comes from the host, and the reference text is shown on its own line.
- **Warning** "Context expansion suppressed — this reference won't be expanded inside code",
  for a reference inside a code range whose target exists.

**Prior context** (`createPriorContextLintExtension`):

- `$previous`/`$all` with no earlier steps.
- `$previous:N` asking for more steps than exist. This is **info** level: still resolvable,
  just capped.
- `$finalStep`/`$allFinalStep` with no final step configured.
- `$step:N` pointing at a step that doesn't exist.

**Condition output** (`createConditionOutputLintExtension`):

- `$preCondition:` on a step with no pre-condition.
- `$endCondition:` outside the retry prompt.
- An unknown field for either phase.

In VS Code, a prompt with `$step:9` in a three-step workflow, or `` `@src/real.ts` `` in
backticks, looks fine until it runs.

Spelling is **out of scope**. VS Code users have the Code Spell Checker extension, and a second
spell-check provider would only duplicate squiggles.

## Key facts that shape the design

These were verified against `src/` on 2026-10-08.

1. **The rule logic lives inside a React component.** All three families are `linter(...)`
   factories in `CodeMirrorEditor.tsx`. They take React `RefObject`s (`stepCountRef`,
   `hasFinalStepRef`, `hasPreConditionRef`, `modeRef`) and write chip validity into a
   `referenceValidity` map as a side effect. VS Code can't import any of it.

2. **The building blocks underneath are already shared and pure.**
   - Token scanners: `findInlinePriorContextRefs`, `findConditionOutputRefs`,
     `findUnknownConditionOutputFields`, `findContextReferenceMatches` (were in the webview's
     `utils/atomicReferences.ts`; Phase 1 moved them to `src/utils/PromptReferenceScanner.ts`).
   - The literal rule: `findCodeRanges` in `src/utils/FileReferenceParser.ts`.
   - Some of these are webview utilities over shared `src/utils/` parsers. The extraction
     moves the rule logic onto the shared side so both hosts call it.

3. **Reference resolution is host-side and already reachable from VS Code.** The webview posts
   `VALIDATE_CONTEXT_REFS`. `WebviewMessageRouter.ts:1324` routes it to
   `PromptEditorSupportService.handleContextRefsValidation`, which calls
   `validateContextReference` for each reference. That service runs in the extension host, so a
   VS Code provider can call it directly, with no message round trip.

4. **VS Code has no prompt diagnostics infrastructure.** There is no `createDiagnosticCollection`
   anywhere in `src/`. Schema checking in VS Code is uneven:
   - `.ctrlyoke.json` gets VS Code's built-in JSON validation through `jsonValidation`.
   - `.ctrlyoke.yaml` gets validated only if the user installed Red Hat YAML. `yamlValidation`
     is declared, but the extension isn't an `extensionDependencies` entry.

5. **Rule context is guessed in the dashboard and exact in a file.**
   - The dashboard editor gets step count, final step and conditions from props.
   - In a workflow file, the same facts are in the document.
   - `getWorkflowLocation` from the file support plan gives the enclosing step index, whether
     `finalStep` exists, whether that step has `preCondition`/`endCondition`, and whether the
     cursor is in `prompt` or `retryPrompt`.
   - A `.prompt.md` file is one step: no prior steps, no final step, no conditions.

## Decision

### Shared rules: `src/utils/PromptDiagnosticRules.ts`

A pure module that the webview can import: no `vscode`, no `fs`. (It is built; see "Phase 1
as built" for the exact exports.)

- `getPromptDiagnostics(text, context): PromptDiagnostic[]` runs the synchronous rules (prior
  context, condition output) over the **whole** text.
- `getReferenceDiagnostics(text, resolve): Promise<PromptDiagnostic[]>` runs the reference
  rules. They don't depend on workflow position, so they take no context. `resolve` is
  injected:
  - the webview passes the `VALIDATE_CONTEXT_REFS` round trip
  - VS Code passes `PromptEditorSupportService.validateContextReference`
- `context` (`PromptDiagnosticContext`) is `{ stepIndex, stepCount, hasFinalStep,
hasPreCondition, hasEndCondition, field }`, where `field` is a `PROMPT_DIAGNOSTIC_FIELDS`
  value (`PROMPT` or `RETRY_PROMPT`). No rule reads `stepIndex` or `hasEndCondition` yet.
- `PromptDiagnostic` is `{ from, to, severity, code, message, detail?, replacements? }`.
  - `code` is a constant in `PROMPT_DIAGNOSTIC_CODES` (`DashboardConstants.ts`), e.g.
    `UNRESOLVED_REFERENCE` or `prompt.prior-context.step-missing`. Both hosts can then filter,
    test and map severity by code instead of by message text.
  - `detail` carries the reference text that the CodeMirror adapter renders on its own line.
  - `replacements` carries quick-fix text ("Change to ...").
- Messages moved into the module **verbatim**, so the dashboard's output didn't change.
- Code ranges come from `findCodeRanges` (through `PromptReferenceScanner.getCodeRanges`)
  inside the module, never from the caller. That keeps one definition of literal text (the
  markdown plan's parity rule).

### CodeMirror adapter

The three `linter` factories become thin wrappers. They read the context refs, call the shared
functions, map `PromptDiagnostic` to `Diagnostic` (`renderMessage` for `detail`), and keep the
`referenceValidity` and `symbolIconCache` side effects. Those side effects are chip-rendering
concerns, not rules. Their delays and `needsRefresh` settings don't change.

### VS Code provider: `PromptDiagnosticsProvider`

- **Collection:** one `vscode.languages.createDiagnosticCollection("ctrlyoke")`. Each diagnostic
  sets `source: "ctrlyoke"` and its `code`, so users can tell where it comes from and filter it
  in the Problems panel.
- **When it runs:**
  - on open, and on change (debounced about 300 ms, matching the webview lint delays)
  - on save
  - cleared on close
  - on workspace file create, delete or rename, open prompt documents are re-checked, so
    "missing file" clears when the file appears
- **Where it runs:**
  - Every prompt value from `getWorkflowTextSpans(text, kind)`
    (`src/completions/WorkflowPromptRanges.ts`, built in the file support plan's Phase 1b):
    the `.prompt.md` body after frontmatter, and in `.ctrlyoke.yaml`/`.yml`/`.json` every
    `prompt`, `retryPrompt` and `passRetryPrompt`. Run the rules on each span's decoded
    `text` (block scalars dedented, JSON strings unescaped) and map each diagnostic's
    `from`/`to` back with `span.toSourceOffset`. The bug fix uses the same spans.
- **Field mapping:** `prompt` maps to `PROMPT_DIAGNOSTIC_FIELDS.PROMPT`; both `retryPrompt`
  and `passRetryPrompt` map to `RETRY_PROMPT`. The schema allows `$endCondition:` in
  `passRetryPrompt` too, and `PROMPT_DIAGNOSTIC_FIELDS` has no separate value for it, so
  mapping it to `PROMPT` would wrongly flag every `$endCondition:` there.
- **Severity:** error → Error, warning → Warning, info → Information. The `$previous:N` cap
  stays Information.
- **Trust:** `validateContextReference` applies trust and containment policy. A reference
  outside approved roots reports what the dashboard reports, so the two hosts agree.

### Schema diagnostics in VS Code (Phase 3)

- `.ctrlyoke.json`: **no** ctrlyoke schema diagnostics. VS Code's built-in JSON validation
  already reports them, and a second set would duplicate every error.
- `.ctrlyoke.yaml`: report schema errors from the file support plan's side-effect-free
  `PromptFileParser` validate, mapped with `findRangeForPath`, **only when Red Hat YAML is not
  active** (`vscode.extensions.getExtension("redhat.vscode-yaml")?.isActive`). Re-check when
  extensions change. This closes fact 4's gap without double-reporting for users who have Red
  Hat YAML.

## Implementation phases

1. **Phase 1: Extract the rules into the shared module and pin them with tests. (Done 2026-10-08)**
   - First, add characterization tests in `CodeMirrorEditor.test.tsx` for every rule as it
     behaves today: messages, severities, ranges and code-range suppression. That includes the
     **suppressed-expansion warning**, for an existing file inline and in a fence, and its
     absence for a missing file. No test checks it today, and the 2026-10-06 coverage report
     shows the branch uncovered.
   - Then move the logic into `PromptDiagnosticRules.ts`, with codes. The characterization
     tests must pass unchanged.
   - Add pure Mocha tests in `src/test/unit/PromptDiagnosticRules.test.ts`, covering each code
     and context combination.

2. **Phase 2: VS Code provider for `.prompt.md`, then workflow prompt values. (Done 2026-10-08)**
   - The provider, its triggers and severity mapping, registered in `extension.ts` on the same
     file predicate (`getCtrlYokeFileKind`) as the completion and link providers.
   - `getWorkflowTextSpans` covers `.prompt.md` and workflow files alike, so both can land
     together. Each span's `path` and `field` also give the context `getPromptDiagnostics`
     needs: the step index, and whether the field is a retry prompt.
   - Tests: unit tests with a stubbed resolver. Add an extension-host integration test that
     opens a fixture with a missing file, a backticked existing file and `$step:9`, and checks
     the collection's diagnostics.

3. **Phase 3: Schema diagnostics in VS Code.**
   - ~~Exact `stepIndex`, `hasFinalStep` and condition context~~ Done in Phase 2 (see "Phase 2 as built"); only the `$preCondition:` caveat remains.
   - YAML schema diagnostics gated on Red Hat YAML being absent. This needs the file support
     plan's Phase 5 validate entry point.
   - Tests: `$finalStep` in a workflow with and without `finalStep`, `$endCondition:` in
     `prompt` vs `retryPrompt`, and Red Hat present vs absent (stubbed).

### Phase 1 as built

- `src/utils/PromptDiagnosticRules.ts` holds the rules. The scanners they need
  (`findContextReferenceMatches`, `findConditionOutputRefs`,
  `findUnknownConditionOutputFields`, `findInlinePriorContextRefs`, `getCodeRanges`,
  `isInCodeRange`) moved out of the webview-only `atomicReferences.ts` into
  `src/utils/PromptReferenceScanner.ts`; `atomicReferences.ts` re-exports them.
- `getReferenceDiagnostics(text, resolve)` takes no `context`: the reference rules don't
  depend on workflow position. The CodeMirror adapter uses the finer-grained
  `resolvePromptReferences` + `diagnoseResolvedReferences` pair because it also feeds the chip
  validity and symbol-icon caches from the resolved references, and `checkPriorContextRefs` for
  per-reference validity.
- `PromptDiagnostic` also carries `replacements?` (quick-fix text), which the CodeMirror
  adapter turns into "Change to ..." actions.
- The new codes joined the existing `PROMPT_DIAGNOSTIC_CODES` in `DashboardConstants.ts` (the
  runtime context-preparation codes) and use its dotted style, e.g.
  `prompt.prior-context.step-missing`. The unresolved-reference rule reuses
  `UNRESOLVED_REFERENCE`. `PROMPT_DIAGNOSTIC_FIELDS` and `PROMPT_DIAGNOSTIC_SEVERITIES` are new.
- Other exports: `getPriorContextDiagnostics`, `getConditionOutputDiagnostics` (the two halves
  of `getPromptDiagnostics`), `ContextReferenceResolver`, `ContextReferenceValidationResult`
  (moved here; `CodeMirrorEditor.tsx` re-exports it), `IdentifiedContextReference`,
  `ResolvedPromptReference` and `PriorContextRefCheck`.
- The CodeMirror adapter drops `code` when mapping to a CodeMirror `Diagnostic`.
- Linting now scans the whole document rather than the visible ranges, so every reference
  goes to the host on each lint pass.
- **Cleanups left for D2** (it is the next consumer, so tidy these as it lands):
  - `PROMPT_DIAGNOSTIC_SEVERITIES` has the same values as `COMPATIBILITY_DIAGNOSTIC_SEVERITIES`,
    which the runtime's `CliPromptPreparer` already uses with the same codes. Fold the new one
    into the existing one.
  - `PROMPT_DIAGNOSTIC_FIELDS` repeats `"prompt"`/`"retryPrompt"` literals instead of reusing
    `PROMPT_PROPERTIES.PROMPT` and `END_CONDITION_PROPERTIES.RETRY_PROMPT`.
  - `getCodeRanges` is a pass-through over `findCodeRanges`.
- Tests: characterization tests in `CodeMirrorEditor.test.tsx` (verified to pass against the
  pre-extraction code too) and `src/test/unit/PromptDiagnosticRules.test.ts`, which covers
  every code. Not covered: the tooltip's `detail` line and the "Change to" actions.

### Phase 2 as built

- `src/completions/WorkflowPromptDiagnostics.ts` (pure) runs the shared rules on every
  `getWorkflowTextSpans` span and maps results back with `toSourceOffset`.
  `src/completions/PromptDiagnosticsProvider.ts` is the VS Code half: one `ctrlyoke`
  collection, refresh on open, save, create/delete/rename of files, and a 300 ms debounce on
  change (`PROMPT_DIAGNOSTICS_SOURCE`, `PROMPT_DIAGNOSTIC_DEBOUNCE_MS`). A pass that finishes
  after the document changed is dropped.
- Reference resolution reuses `PromptEditorSupportService`: its new public
  `validateContextReferences` shares one path with the dashboard's `handleContextRefsValidation`
  (`./` references anchor to the document). It reaches the provider through
  `WebviewMessageRouter` and `CtrlYokeWebviewProvider.validateContextReferences`.
- **Workflow context landed here, not in Phase 3.** Running with guessed defaults would flag
  `$finalStep` or `$step:3` wrongly, so the provider reads the parsed document: `stepCount` is
  the flat steps before the prompt (a parallel group's members share the group's start; the
  final step sees all), `hasFinalStep` is `finalStep` being present, and `retryPrompt` and
  `passRetryPrompt` both map to `RETRY_PROMPT`.
- **`hasPreCondition` is always true**, so `$preCondition:` is never flagged in VS Code. A step
  can inherit its pre-condition from the workflow or the global default, and the file can't say
  which. The dashboard knows; the file doesn't. Fixing it needs the workflow-level and settings
  defaults threaded in.
- Quick fixes (`replacements`) are not offered as code actions yet (open question 1).
- D1's cleanups are done: severities folded into `COMPATIBILITY_DIAGNOSTIC_SEVERITIES`,
  `PROMPT_DIAGNOSTIC_FIELDS` reuses `PROMPT_PROPERTIES.PROMPT` and
  `END_CONDITION_PROPERTIES.RETRY_PROMPT` (so it moved below them in `DashboardConstants.ts`),
  and the `getCodeRanges` pass-through is gone (`findCodeRanges` is re-exported instead).
- Tests: `src/test/unit/WorkflowPromptDiagnostics.test.ts` (pure, stubbed resolver) and
  `src/test/unit/PromptDiagnosticsProvider.test.ts` (extension host). No test closes a
  document: VS Code delays `onDidCloseTextDocument` after an editor closes, so it can't be
  asserted deterministically.

## Open questions

1. **Quick fixes.** A code action "Remove backticks" for `EXPANSION_SUPPRESSED_IN_CODE` and
   "Change to $step:N" for out-of-range steps are cheap once codes exist, and CodeMirror's lint
   `actions` could share them. They're not in scope here; revisit after Phase 2.
2. **The ctrlyoke settings file.** `.ctrlyoke/settings.json` is JSON and already validated by
   VS Code. Nothing to do unless the file support plan's settings follow-up adds YAML-side
   needs.
