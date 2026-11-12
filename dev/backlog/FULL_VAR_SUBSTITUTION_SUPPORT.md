# Full Variable Substitution Support

**Status:** Not started. Written 2026-11-12 against `0e5bd6ea0`.
**Priority:** P2
**Related:**
[NAMED_WORKTREE_CHECKOUT_SLOTS_PLAN.md](NAMED_WORKTREE_CHECKOUT_SLOTS_PLAN.md)
(wants `{{branch}}` in `worktree.branch`),
[TEMPLATE_AUTHORING_MODE_PLAN.md](TEMPLATE_AUTHORING_MODE_PLAN.md) (`emitAs:
var` needs the substituted field set from one source),
[COMPUTED_VARIABLES_PLAN.md](COMPUTED_VARIABLES_PLAN.md) (where values come
from; this plan is only about where they go),
[SCRIPT_GENERATED_STEPS_PLAN.md](SCRIPT_GENERATED_STEPS_PLAN.md) (`{{item}}`
filled at generation time).

## Problem

`{{name}}` placeholders work in only a few text fields: prompt text, `model`,
`additionalArgs`, hook `command`/`env`, condition and script-step
`script`/`env`, `retryPrompt`/`passRetryPrompt`, and worktree `setup`.
Everything else is used as written. A reusable workflow therefore cannot take
its branch, harness, timeout, agent or step label from `--var`. Users expect
it to (the slots plan's "bug-fix slot" workflow wants
`branch: "{{branch}}"`), and the boundary is not obvious from the docs: the
table in `docs/workflows/variables.md#where-substituted` is the only place it is
written down.

Goal: every workflow field that holds a user value accepts `{{name}}`, except a
short, documented list where substitution would make a reviewed or approved
value differ from the value that runs.

## How things work today

- **Substitution.** `VarSubstitutor` (`src/utils/VarSubstitutor.ts`):
  - `substitute()` replaces only names present in `vars` (own keys). Unknown
    names stay literal and are reported by `findUnresolvedVariables()` as the
    advisory `VARIABLE_SUBSTITUTION_IGNORED`.
  - A value containing `${secret:` throws. So does a substitution that produces
    more secret references than the authored text had.
  - Placeholders come from `findVariablePlaceholders`
    (`src/utils/VariablePlaceholders.ts`, `\{\{(\w+)\}\}`). Placeholders inside
    fenced code blocks are skipped **in every field**, scripts and env included.
  - There is no escape for a literal `{{x}}`.
- **Call sites.** All of them substitute at dispatch, on every attempt:
  - `applyToResolvedProperties` (model, additionalArgs, hooks, pre/end
    conditions) is called from `WorkflowExecutor` (pre-condition, main step,
    retry, next-harness label), `ParallelGroupPreflight` and
    `ExecutionPreviewService`.
  - Prompt text goes through `PromptTextResolver` / `resolveEffectivePrompt`.
  - Script steps go through `applyToScriptStep`.
  - Worktree setup is substituted in `WorktreeManager.runSetup`.
  - Each layer picks its own fields. Nothing lists them in one place.
- **Where vars come from.** The workflow's `vars` and the CLI's `--var`.
  `mergeCliVarsIntoWorkflow` (`src/cli.ts`) merges them before preflight and
  writes the result into the run file's `vars`, so a resumed run reuses the CLI
  values. The dashboard has no run-time variable input. MCP agents cannot set
  vars.
- **Validation runs on the authored text.** The startup pipeline
  (`WorkflowStartupPipeline`) checks secret grants, worktree mode/branch and
  harness compatibility before any substitution. So does continue
  (`WorkflowInstance` around line 2630). The JSON schema rejects `{{x}}` in
  every enum, number and boolean field.
- **Template placeholders** (`{name}`, `TemplateManager`) are a separate,
  one-time mechanism. They walk every scalar before parsing, so they can fill
  structural fields such as `harness`.

### Gaps found while checking

These are fixed as part of this plan:

1. Dry Run scans `!NAME` secret grants on the **substituted** prompt
   (`ExecutionPreviewService`), but a real run scans the **authored** prompt
   (`getEffectiveSecretGrants(prompt, …)` in `WorkflowExecutor`). A var that
   injects `!NAME` shows a grant in Dry Run that never applies.
2. Compatibility preflight sees the raw `additionalArgs`. Flag-collision checks
   in the permission and sandbox mappers see the substituted value.
3. With an empty `vars`, `reportUnresolvedVariables` (`WorkflowExecutor`) and
   the worktree-setup check return early, so `{{typo}}` gets no warning at all.
4. Condition-preset `params` supplied by an MCP agent end up in a condition's
   `env` and are substituted like authored text. Agent data should not expand
   the author's variables.
5. The `ctrlyoke run --var` help text (`CliRunCommandDefinitions.ts`) and the
   `VarSubstitutor` header comment list only some of the fields.
6. Dry Run does not show the worktree setup command at all.

## Threat model

Variable values come from the workflow author (`vars`) or the person running it
(`--var`, and later any dashboard run dialog). Both are already trusted to run
scripts. A variable is therefore not untrusted input. The risk is different:

- **Approval drift.** Several trust gates fingerprint the authored value. These
  are the external-root approval for `trustedExternalRoots`, secret grant
  approvals, and workspace-settings trust (`WorkspaceSensitiveSettings.ts`). If
  the gate approves `{{root}}` and the run substitutes `/`, approval means
  nothing.
- **Review drift.** The properties panel, Dry Run and the run view show
  permission posture (tool permissions, sandbox) from the definition. If a
  `--var` can quietly widen it, what was reviewed is not what runs.
- **Agent-supplied text.** MCP-appended prompts and preset params come from a
  model. They must not gain the ability to set a variable. They cannot today,
  and this plan keeps it that way.

## Proposal

### 1. One substitution policy table

Add `src/utils/VarSubstitutionPolicy.ts`. It is a typed, `const` table keyed by
the field's schema path (`steps[].timeoutSec`, `worktree.branch`, …). Each entry
holds:

- `phase`: `"run-start"` (resolved once, before preflight) or `"dispatch"`
  (resolved on each attempt, as today).
- `kind`:
  - `"text"`: placeholders may sit inside other text.
  - `"value"`: the whole value must be one placeholder (`{{name}}`), and the
    result is coerced and validated against the field's own schema.
- `fencedCodeProtected`: true only for prompt-text fields (prompt,
  `retryPrompt`, `passRetryPrompt`).
- `unresolved`: `"advisory"` (today's behavior, kept for the fields that have it
  now) or `"error"` (every newly added field).

`VarSubstitutor` gains one entry point,
`substituteWorkflowView(workflow | step, vars, phase)`. It walks the table and
returns a substituted copy. Every current call site switches to it, so the
field set lives in exactly one place. The table also drives:

- the `varsConfig` schema description (a unit test checks they agree);
- the "Where substituted" table in `docs/workflows/variables.md`, generated
  into a `_partials` block or checked by `check:docs`;
- the CLI help text;
- the field rewrite in `TEMPLATE_AUTHORING_MODE_PLAN.md`'s `emitAs: var`.

### 2. Which fields

**Already substituted (no change in behavior):** prompt text (including a
prompt-file path and the loaded file), `model`, `additionalArgs`, hook
`command` and `env` values, pre/end-condition `script` and `env` values,
`retryPrompt`, `passRetryPrompt`, script-step `script` and `env` values, and
worktree `setup`.

**Add as `text`:**

| Field                                       | Phase     | Notes                                                                                                                              |
| ------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| step `name`                                 | dispatch  | The run view renders it from the run file's `vars`. The authored text stays in the definition.                                     |
| `worktree.branch`, `.base`, `.checkout`     | run-start | Substituted before `normalizeDefault`/`validateBranchName`. Continue reuses the recorded branch and checkout (see the slots plan). |
| `expected`                                  | dispatch  | A string result is compared as text. A number stays a number.                                                                      |
| `shell`                                     | dispatch  | The workflow already chooses programs through `script`.                                                                            |
| `agent`                                     | dispatch  | Resolved by name after substitution, the same as today.                                                                            |
| `skills[]` entries                          | dispatch  | Each name is substituted separately.                                                                                               |
| `sessionId` (string form)                   | dispatch  | Lets a workflow resume a session passed in with `--var`. The person running already controls this.                                 |
| `priorContext.workflow`, `priorContext.run` | dispatch  | `run` must resolve to an integer or a run reference after substitution.                                                            |

**Add as `value`** (schema accepts a `{{name}}` string as well as the typed
value; the result is validated against the original type):

| Field                                                      | Phase     |
| ---------------------------------------------------------- | --------- |
| `harness` (workflow and step)                              | run-start |
| `executionMode`, `resumeSession`, `priorContextDetail`     | dispatch  |
| `timeoutSec`, `endCondition.maxRetries`                    | dispatch  |
| `enabled`                                                  | run-start |
| `compareSource`, `operator`, `ignoreCase`                  | dispatch  |
| condition `onPass`/`onFail`, script-step `onPass`/`onFail` | dispatch  |
| `errorBehavior.onError`, `.maxRetries`, `.retryDelaySec`   | dispatch  |
| `maxSteps`                                                 | run-start |

`harness` and `enabled` are run-start because startup preflight
(compatibility, session-resume chains, parallel-member harness sessions, step
counts) needs them before anything runs. They are still resolved once and not
per attempt, because vars only change while a run is paused.

**Excluded, with the reason in the schema description of each field:**

- `trustedExternalRoots`, `secrets` (grant names): approval is keyed to the
  authored value (approval drift).
- `toolPermissions`, `sandbox`, `sandboxMode`: reviewed permission posture
  (review drift).
- `mcpServers`: inline entries launch programs, and their secret grants are
  scanned from authored `env`/`headers`. Registry IDs could be added later, but
  that is not needed now.
- `conditions` preset definitions and `params` names: these are an
  author-only contract with MCP agents. A preset's `script`/`env`, once
  attached, is substituted like any condition, but agent-supplied param
  **values** are not (gap 4).
- Structure and identity: `type`, `parallel`, `failFast`, `worktree.mode`,
  `worktree.merge`, `worktree.keep`, `vars` itself (no recursion; computed vars
  are their own plan), map keys (`env` names, `conditions` names), the workflow
  root `name` (shown in lists and history before any run exists), `color`,
  `$schema`, `schemaVersion`, `_templateMeta`, and every `_runtime` and
  bookkeeping field.

### 3. Schema

- Add `$defs.varPlaceholder`: `{ type: string, pattern: "^\\{\\{\\w+\\}\\}$" }`,
  with a description that links to the variables page.
- Wrap each `value` field as `oneOf: [<existing>, { $ref: varPlaceholder }]`.
  `harness` already has `oneOf: [harnessId, templatePlaceholder]`. Also update
  the root `allOf` / `if not _templateMeta` block that narrows `harness` back to
  `harnessId`, or a non-template file will still reject `{{harness}}`.
- `text` fields are already strings and need no schema change, only
  description updates.
- **No schema bump.** Every change widens a type. An older ctrlyoke rejects
  `{{x}}` in a typed field with a schema error and never misreads it, which
  fits the no-bump rule in `CONTRIBUTING.md`. Run `npm run schema:update`.
- `promptRuntimeMetadata` shares `executionProperties`, so it would also accept
  placeholders. `_runtime` must keep recording the **substituted** values the
  step ran with. Add a test so a placeholder never reaches `_runtime`.

### 4. Validation after substitution

- `value` fields: coerce the string (`"30"` → number, `"true"`/`"false"` →
  boolean), then validate it with the field's original sub-schema. Compile that
  sub-schema from `workflow-schema.json` by JSON pointer, on the same Ajv
  instance `PromptFileParser` uses, so the rules are never copied by hand.
- A failed result, or an unresolved placeholder in a field marked `error`,
  stops before any side effect, with the field path, the variable and the
  value: `steps[2].timeoutSec: variable "timeout" is "soon", expected a number
greater than 0.` A run-start field fails the run start. A dispatch field fails
  the step under its `errorBehavior`, and a substituted `errorBehavior` falls
  back to the inherited policy.
- Run-start substitution happens in `WorkflowStartupPipeline` before
  `preflightSecrets`, `resolveWorktree` and `preflightCompatibility`, which then
  see substituted values. This fixes gap 2. Secret-grant preflight still scans
  only authored text for `!NAME`, and Dry Run is changed to do the same
  (gap 1).
- The advisory for unresolved placeholders fires even when `vars` is empty
  (gap 3).
- Fenced-code masking applies only to the prompt-text fields. Today it also
  masks script and env text, so a heredoc containing a triple backtick leaves
  its placeholders unsubstituted. This is a user-visible fix and goes under
  **Changed**.

### 5. Dashboard and editor

- `dropdownValidation.ts` (`modelWarning`, agent and skills warnings) does not
  warn on a whole-value placeholder.
- Enum fields in `WorkflowPropertiesPanel.tsx` (harness, execution mode, error
  behavior, operator, …) show a placeholder value as a read-only
  `{{name}} → <current value>` chip, using the workflow's `vars`, with a
  **Clear** action that goes back to the picker. Number and text inputs accept
  the text as typed. The dashboard never writes a placeholder into a typed
  field by itself.
- CodeMirror highlighting and lint (`codemirrorWorkflowVariables.ts`) and the
  `VARIABLE_UNDEFINED` diagnostic (`PromptDiagnosticRules.ts`) cover every
  table field. They read the policy table instead of a hard-coded list.
- Dry Run shows substituted values next to each field it already lists, the
  worktree branch, base, checkout and setup (gap 6), and validation failures
  as blockers.
- Out of scope: a dashboard "Run with variables…" dialog. It would feed the
  same merge as `--var` and is worth its own small plan.

### 6. CLI

- Update the `--var` help text from the policy table (gap 5).
- `ctrlyoke run --dry-run --var …` validates `value` fields and reports
  failures with exit code 2, the same as other invalid input before a run.
- Warn on stderr (do not fail) when a `--var` name is used in no field, which
  catches typos.

## Compatibility

- Workflow schema: widened types only. No bump; `npm run schema:update`.
- Settings schema: `defaults.*` values `$ref` the same definitions, so they
  accept placeholders too and are substituted with the running workflow's
  vars, as `defaults.worktree.setup` already is. The workspace-trust predicate
  for `defaults.worktree` counts a `checkout` that contains a placeholder as
  sensitive, because it cannot be proven to be a bare name (see the slots
  plan's trust section).
- Run files: no new fields, so no format bump. `_runtime` keeps recording
  resolved values.
- `CHANGELOG.md` **Added**: substitution in the new fields. **Changed**:
  script and env text is no longer protected by code fences; unresolved
  placeholders now warn even when a workflow has no `vars`; agent-supplied
  preset param values are no longer substituted; Dry Run secret grants match
  the real run.
- Docs: rewrite "Where substituted" in `docs/workflows/variables.md` from the
  table (substituted fields, the `value` rule, the excluded list with reasons),
  and add a `{{branch}}` example to `docs/workflows/worktrees.md`.

## Phasing

1. Policy table and `substituteWorkflowView`, moving the existing call sites
   over with no behavior change, plus gaps 1–6.
2. `text` fields, including `worktree.branch`/`base`/`checkout`, which unblocks
   the slots workflow.
3. `value` fields, the schema `varPlaceholder`, post-substitution validation
   and the dashboard chips.

Each phase ships on its own.

## Tests

- `VarSubstitutor.test.ts` / new `VarSubstitutionPolicy.test.ts`: every table
  entry is substituted in its phase. Excluded fields stay literal. A
  whole-value placeholder in a `value` field is coerced and validated, and a
  partial one is rejected. Fence masking applies only to prompt-text fields.
- Schema agreement: the `varsConfig` description and the docs table name every
  table entry, and the `value` entries are exactly the fields whose schema
  accepts `varPlaceholder`.
- `promptFileParser.test.ts`: `{{harness}}` validates without `_templateMeta`,
  and `{{x}}` is still rejected in excluded typed fields (`sandboxMode`).
- `WorkflowStartupPipeline` / `WorkflowInstance`: run-start fields are
  substituted before preflight, and a bad value fails the start with no
  worktree created. Continue reuses the run file's merged vars.
- `WorktreeManager.test.ts`: `branch: "{{b}}"` resolves, and an unresolved one
  fails before any Git mutation.
- `ExecutionPreviewService.test.ts`: Dry Run grants match the real run, the
  setup command is shown, and substituted values and blockers are shown.
- MCP: an appended condition with a param value of `{{secretish}}` reaches the
  script literally.
- Integration (`cli-dry-run`, `cli-run-commands`): `--var timeout=soon` exits 2,
  and an unused `--var` warns.
- Webview: placeholder chips, and no "model not available" warning for
  `{{model}}`.
