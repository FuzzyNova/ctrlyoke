# Prompt Diagnostics Plan

**Status (2026-10-08):** Phase 1 done (shared rules extracted and pinned with tests). Phases 2 and 3 are proposed.

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
- [`vscode-prompt-references-active-inside-code`](../bugs/backlog/vscode-prompt-references-active-inside-code.md):
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
     `findUnknownConditionOutputFields`, `findContextReferenceMatches` (`utils/atomicReferences.ts`).
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

A pure module that the webview can import: no `vscode`, no `fs`.

- `getPromptDiagnostics(text, context): PromptDiagnostic[]` runs the synchronous rules (prior
  context, condition output) over the **whole** text.
- `getReferenceDiagnostics(text, context, resolve): Promise<PromptDiagnostic[]>` runs the
  reference rules. `resolve` is injected:
  - the webview passes the `VALIDATE_CONTEXT_REFS` round trip
  - VS Code passes `PromptEditorSupportService.validateContextReference`
- `context` is `{ stepIndex, stepCount, hasFinalStep, hasPreCondition, hasEndCondition,
field }`, where `field` is `PROMPT` or `RETRY_PROMPT`.
- `PromptDiagnostic` is `{ from, to, severity, code, message, detail? }`.
  - `code` is a constant in `PROMPT_DIAGNOSTIC_CODES` (`DashboardConstants.ts`), e.g.
    `REFERENCE_UNRESOLVED`, `EXPANSION_SUPPRESSED_IN_CODE`, `PRIOR_CONTEXT_STEP_MISSING`,
    `CONDITION_FIELD_UNKNOWN`. Both hosts can then filter, test and map severity by code
    instead of by message text.
  - `detail` carries the reference text that the CodeMirror adapter renders on its own line
    today.
- Messages move into the module **verbatim**, so the dashboard's output doesn't change.
- Code ranges come from `findCodeRanges` inside the module, never from the caller. That keeps
  one definition of literal text (the markdown plan's parity rule).

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
  - `.prompt.md`: the body after frontmatter.
  - `.ctrlyoke.yaml`/`.yml`/`.json`: every `PROMPT_TEXT` range from `getWorkflowLocation`,
    with offsets mapped back through the decoded value. Block scalars are dedented and JSON
    strings decoded, the same mapping the bug fix needs. Put it in one shared helper.
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

2. **Phase 2: VS Code provider for `.prompt.md`, then workflow prompt values.**
   - The provider, its triggers and severity mapping, registered in `extension.ts` on the same
     file predicate (`getCtrlYokeFileKind`) as the completion and link providers.
   - Start with `.prompt.md`, which needs only the frontmatter split. Workflow-file prompt
     ranges follow once the file support plan's Phase 1 (`getWorkflowLocation`) exists.
   - Tests: unit tests with a stubbed resolver. Add an extension-host integration test that
     opens a fixture with a missing file, a backticked existing file and `$step:9`, and checks
     the collection's diagnostics.

3. **Phase 3: Workflow-aware context and schema diagnostics in VS Code.**
   - Exact `stepIndex`, `hasFinalStep` and condition context from `getWorkflowLocation`.
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
- Linting now scans the whole document rather than the visible ranges.
- Tests: characterization tests in `CodeMirrorEditor.test.tsx` (passed unchanged across the
  extraction) and `src/test/unit/PromptDiagnosticRules.test.ts`.

## Open questions

1. **Quick fixes.** A code action "Remove backticks" for `EXPANSION_SUPPRESSED_IN_CODE` and
   "Change to $step:N" for out-of-range steps are cheap once codes exist, and CodeMirror's lint
   `actions` could share them. They're not in scope here; revisit after Phase 2.
2. **The ctrlyoke settings file.** `.ctrlyoke/settings.json` is JSON and already validated by
   VS Code. Nothing to do unless the file support plan's settings follow-up adds YAML-side
   needs.
