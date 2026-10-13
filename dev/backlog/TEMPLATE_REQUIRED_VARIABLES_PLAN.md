# Template Required Variables + Feature-Driven Loop Plan

**Status:** In progress

> **2026-10-10 audit:** Nothing here has landed — `TemplateVariable` has no `required`, there is no
> `feature-driven-loop` template, and untouched optional variables without a default still leave a
> literal `{token}`. Refreshed every stale line reference. Substitution now runs per scalar value
> through `substituteVariablesInValues` (which calls `replaceVariables`) after `yaml.load`, not over
> raw template text; `parallel-research` is now a built-in; the `@`-reference regex moved.

> **2026-10-13 orchestrator review:** Line references refreshed again. Corrections:
> `spec-driven-loop` is **no longer final-step-only** — it now ships a visible `plan` step
> (`agent: workflow-orchestrator`, which stages the work via `append_step`) and a `review`
> `finalStep` that resumes it with `sessionId: 1`. Phase 3's shape is updated to match that
> pattern (write-plan → orchestrator plan → review). `TemplateModal.test.tsx` already exists
> (extend it, don't create it); the field label is rendered by `TemplateVariableField.tsx`, so
> the required marker goes there. `templates.instructions.md` already lists `parallel-research`,
> but its `spec-driven-loop` bullet still says `steps: []`, which is stale.
> Execution is staged as three steps: core (Phases 1+2), modal UI, then the template (Phase 3).
> Phase 4 stays deferred.

## Goal

Two related pieces of work:

1. Give template authors a **`required: true`** gate on `_templateMeta` variables, enforced in the
   creation UI and in `TemplateManager.createWorkflow`, so a template can declare which inputs a
   workflow cannot be created without.
2. Ship a second orchestrator template — **`feature-driven-loop`** — for the case where the user has
   an idea rather than a spec document. It starts with a real `plan` step (gated by an
   end-condition) followed by the same final-step orchestrator, and it is the first consumer of
   `required`.

## Why

`spec-driven-loop` takes an existing spec/design document. The common case of "I know
what I want but haven't written it down" has no home: forcing it into the same template would mean
two optional inputs where the user must supply exactly one, and a per-field `required` flag cannot
express "one of these two" — that needs `requiredAnyOf` group machinery in the engine, plus
conditional prompt sections to drop the unused input's text.

Two templates with **one required field each** avoids all of it. It also buys something a combined
template could not have: the planning stage becomes a first-class step with an `endCondition`
verifying the plan document was written, rather than an instruction the orchestrator is trusted to
queue first.

### Related defect this closes

Today an optional variable that the user never touches is **not substituted at all** — the literal
`{token}` survives into the generated workflow (`replaceVariables` at `src/core/TemplateManager.ts:577`
leaves any placeholder whose key is absent from the map; `createWorkflow` only adds declared
`default`s, and the modal only sends keys it has values for). This is
documented as current behavior in `docs/workflows/templates.md:171` ("Defaults and blank fields"), but it is a bug, not a feature:
the user sees `{constraints}` in their prompt text. Required-gating fixes it for mandatory inputs;
Phase 2 fixes it for genuinely optional ones.

## Non-goals

- **Cross-field constraints** (`requiredAnyOf`, "exactly one of"). Not needed once each template has
  a single required input. Revisit only if a real template needs it.
- **Conditional template sections** (`{?var}…{/var}`). Their only motivating use case was the
  combined spec-or-description template, which this plan replaces with two templates. Substituting a
  blank optional variable to an empty string (Phase 2) covers the remaining need.
- Any change to workflow execution, the queue, or the schema in `schemas/workflow-schema.json`.
  `_templateMeta` is stripped before validation (`TemplateManager.createWorkflow`, ~line 664), so nothing
  here touches the workflow contract.

---

## Phase 1 — `required` variable metadata

### Contract

```yaml
_templateMeta:
  variables:
    featureDescription:
      type: text
      multiline: true
      required: true
      description: What you want built.
```

- `required?: boolean` on `TemplateVariable`. Absent/`false` means optional (today's behavior).
- "Satisfied" means the resolved value — after the declared `default` is applied — is a non-empty
  string once trimmed. A required variable **with** a `default` is therefore always satisfiable; that
  combination is legal and useful (pre-filled but not erasable).
- Enforced in two places, because the modal is not the only caller:
  - **UI**: Create / Create & Run disabled, per-field error text on blur/submit.
  - **API**: `TemplateManager.createWorkflow` throws before substitution. `WorkflowSerializer.handleCreateWorkflow`
    (`src/ui/WorkflowSerializer.ts:986`) already catches and surfaces the message.

### Touchpoints

| File                                                                 | Change                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/core/TemplateManager.ts:78`                                     | Add `required?: boolean` to `TemplateVariable` + document it in the interface's `_templateMeta` example block (`:53`–`:76`)  |
| `src/core/TemplateManager.ts:207` (`parseTemplateMeta`)              | Accept `required` alongside the other per-field reads (`:236`–`:261`): `if (vm["required"] === true) entry.required = true;` |
| `src/core/TemplateManager.ts:276` (`mergeVariablesWithMeta`)         | Copy `required` onto the merged variable, same shape as `multiline`                                                          |
| `src/core/TemplateManager.ts:622` (`createWorkflow`)                 | After the `withDefaults` loop (`:642`–`:651`), reject blank required variables with a message naming every missing one       |
| `src/ui/webview-react/store/uiStore.ts:208`                          | Mirror `required?: boolean` (this interface is an explicit copy of the core one — keep them identical)                       |
| `src/ui/webview-react/components/workflow/TemplateModal.tsx`         | Required-field validation; see below                                                                                         |
| `src/ui/webview-react/components/workflow/TemplateVariableField.tsx` | Visual required marker in the `FieldLabelRow` (`:223`) + `aria-required` on the control                                      |
| `docs/workflows/templates.md:134`                                    | New row in the metadata table; update the "Defaults and blank fields" section (`:169`)                                       |

`WorkflowSerializer.toWireTemplates` (`src/ui/WorkflowSerializer.ts:921`) passes `variables` through
untouched, so no wire change is needed once both interfaces carry the field.

**Done:** Core/API contract implemented: `required` metadata is parsed and merged through defaults,
the webview variable type mirrors it, and `createWorkflow` rejects missing/blank required values.
The modal-specific touchpoints remain for the next step.

### Modal specifics

`TemplateModal.tsx` is the only surface that collects variable values — there is no Command Palette
equivalent (`ctrlyoke.createNewTemplate` scaffolds a template file, it does not instantiate one), so
this is the single UI to change.

- Label gets a required marker (`*` with `aria-required` on the input).
- Add `variableErrors: Record<string, string>` state beside the existing `filenameError` and validate
  in `handleSubmit` (`:526`) the same way `validateFilename` is called — return early, set errors.
  `handleKeyDown` (Enter / Ctrl+Enter) routes through `handleSubmit`, so it is covered too.
- Extend both Create buttons' `disabled` expressions (`:663`, `:670`) with a `hasUnsatisfiedRequired`
  memo. Note `seedVariableDefaults` (`:57`) already pre-seeds declared defaults, `select` first
  options, and the harness fallback, so those types satisfy the gate automatically.
- Switching templates must clear variable errors along with the values.

### Tests

- `src/test/unit/TemplateManager.test.ts`: `required: true` parses off `_templateMeta` and survives
  the merge; `createWorkflow` throws when a required variable is missing/blank/whitespace; a required
  variable with a `default` succeeds when the caller omits it entirely.
- Extend the existing `src/ui/webview-react/test/components/workflow/TemplateModal.test.tsx` (it
  already has `template()`/`openModal()` helpers): Create disabled until the required field is filled; error clears on input;
  optional fields never block.

---

## Phase 2 — blank optional variables substitute to empty

Change `createWorkflow` so **every declared variable** is substituted, not only the ones the caller
supplied: after applying defaults, fill any still-absent declared variable with `""`. A blank
optional input then leaves clean text instead of a literal `{token}`.

Keep the substitution itself in `replaceVariables` (`:577`, applied per scalar by
`substituteVariablesInValues`) unchanged — it already replaces all three token forms for whatever
keys it is given.

Consequence to accept and document: a blank optional `{file:x}` written as `@{file:x}` leaves a bare
`@`. That should be inert — the file-reference regex (`src/utils/FileReferenceParser.ts`, ~line 713,
built from `UNQUOTED_AT_REFERENCE_PATH`) needs a quoted or unquoted path after the `@`; re-verify when
implementing — but it is untidy, so
templates should keep optional file variables off an `@` prefix and let the agent open the path.
Neither new template does this.

**Verification:** `parseAtReferences("@")` returns no references; the parser's `@` expression
requires a quoted or unquoted path after the marker. No parser change is needed.

Update `docs/workflows/templates.md:171`, which currently documents the literal-`{token}` behavior.

Tests: `TemplateManager.test.ts` — an untouched optional variable with no default produces empty
text, not `{token}`; a declared default still wins over the blank fill.

**Done:** Missing declared variables are filled with empty text after default resolution, with
coverage for optional values, authored defaults, retry placeholders, and required-value validation.

---

## Phase 3 — the `feature-driven-loop` template

### Shape

Three steps, mirroring `spec-driven-loop` with one extra step in front: a real step that writes the
plan document, then the same orchestrator `plan` step and `review` finalStep that `spec-driven-loop`
ships. The generated plan document plays exactly the role `specFile` plays in `spec-driven-loop`.

```yaml
_templateMeta:
  name: Feature-Driven Loop
  description: "Describe a feature — it writes the plan, then orchestrates the work until it's built."
  variables:
    featureDescription:
      type: text
      multiline: true
      required: true
      description: What you want built. Include any constraints you care about.
    planDoc:
      type: text
      default: .ctrlyoke/plans/plan.md
      description: Where the plan is written. Rename it per feature so runs don't overwrite each other.

resumeSession: false
priorContext: none

steps:
  - name: write-plan # no agent (decided)
    prompt: |
      {featureDescription}

      Analyze the codebase and write an implementation plan to {planDoc} ...
    endCondition:
      script: <portable existence check — see below>
      returns: "true"
      maxRetries: 2
      retryPrompt: |
        {planDoc} was not created. Write the implementation plan to it.
  - name: plan # copy of spec-driven-loop's plan step, against @{planDoc}
    agent: workflow-orchestrator
    mcpServers: [ctrlyoke]
    prompt: |
      Be my ctrlyoke orchestrator for this specification:
      @{planDoc}
      ...

finalStep:
  name: review # copy of spec-driven-loop's review finalStep
  agent: workflow-orchestrator
  mcpServers: [ctrlyoke]
  resumeSession: true
  sessionId: 2 # resumes the orchestrator `plan` step (1-based), not write-plan
  prompt: |
    Resume your ctrlyoke orchestrator session for this specification:
    @{planDoc}
    ...
```

Reuse `spec-driven-loop`'s `plan`/`review` prompt text and comments nearly verbatim so the two
templates stay in lockstep. `@{planDoc}` is safe here: `planDoc` always has a default, so it is
never blank (see the Phase 2 note about blank `@` references).

### Portable end-condition — do not write `test -f`

`test` does not exist in cmd.exe, and end-condition scripts run through the platform shell, so
`test -f <path>` silently never passes on Windows. Copy the check `full-feature.ctrlyoke.yaml`
already uses — the path goes through `argv`, not into a JS string literal, so Windows paths with
backslashes survive:

```yaml
script: node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "{planDoc}"
returns: "true"
```

### Registration

Adding a built-in template requires all three, or it will not appear:

1. `src/templates/workflows/feature-driven-loop.ctrlyoke.yaml` (filename must be `<id>.ctrlyoke.yaml`)
2. `src/core/TemplateManager.ts:146` — add `"feature-driven-loop"` to `BUILT_IN_TEMPLATE_IDS`
3. `src/templates/workflows/manifest.json` — new entry (`id`, `label`, `description`, `file`, `tags`, `icon`)

### `spec-driven-loop` update

Mark `specFile` `required: true`. Its whole `plan` and `review` prompts are built around the spec
reference — creating it with a blank `specFile` produces a workflow that cannot work. No other
change; it stays the "I already have the doc" path.

### Agent

The orchestrator steps of both templates use `workflow-orchestrator`. Its instructions are written in
terms of "the plan" named by the prompt, which the generated plan document satisfies.
Re-read `src/templates/agents/workflow-orchestrator.agent.md` when implementing and adjust only if a
sentence reads as file-specific; do not fork a second agent.

**The `write-plan` step declares no agent** (decided). No bundled agent fits the "architect a plan doc"
role, and a well-written prompt is enough. Revisit only if plan quality disappoints in practice.

### Docs

- `docs/workflows/templates.md` — the built-in list in the intro paragraph.
- `.github/instructions/templates.instructions.md` — the `spec-driven-loop` bullet (`:20`) is stale
  (it still says the template ships `steps: []`; it now ships an orchestrator `plan` step resumed by
  the finalStep via `sessionId: 1`). Correct it and name `feature-driven-loop` as the plan-first
  variant of the same pattern (its finalStep resumes `sessionId: 2`). Keep it to one bullet. Add the
  id to that file's built-in list (`:17`).
- `src/templates/agents/ctrlyoke-workflow-composer.agent.md:81` — the "fixed workflow vs
  self-extending loop" section points users at Spec-Driven Loop; mention the description-first
  variant in the same sentence.

---

## Phase 4 (optional) — reserved `{workflowName}` token

`planDoc` defaulting to a fixed `.ctrlyoke/plans/plan.md` means two runs overwrite each other unless
the user edits the field. The modal already collects a **Workflow Name** immediately below the
variable inputs, and `autoFillFilename` already wires the file-variable → filename direction.

Closing the loop the other way — reserving `{workflowName}` as a built-in token substituted from the
filename field — would let `planDoc` default to `.ctrlyoke/plans/{workflowName}.md` and would be
useful to any template. Implementation is small: exclude it from `extractVariables` the way
`RETRY_PROMPT_PLACEHOLDERS` are excluded (`src/core/TemplateManager.ts:550`), and inject it into
`withDefaults` from the `filename` already passed to `handleCreateWorkflow`.

Deliberately separate: Phase 3 must not block on it, and the fixed default is acceptable in the
meantime.

---

## Decisions

- **Template id/label**: `feature-driven-loop` / "Feature-Driven Loop" — reads as a peer of
  "Spec-Driven Loop" and names the input the user actually has.
- **No agent on the `plan` step.** See Phase 3.
- **`full-feature` stays** — kept and reworked into the "Full Feature Pipeline" showcase (done
  ahead of this plan, see the template file). It is the only built-in demonstrating the fixed
  linear pipeline, per-step harness overrides, and a script step. The picker now reads as
  _fixed pipeline_ (`full-feature`) vs _self-extending loop_ (`feature-driven-loop` /
  `spec-driven-loop`), so `feature-driven-loop`'s manifest description must hold that line and not
  re-describe itself as "the full feature workflow".
- **`.ctrlyoke/plans/` is the convention for generated plan documents** in both templates. It is not
  gitignored (only specific `.ctrlyoke/` subdirectories are), so plans stay committable.

## Open questions

1. **Does `required` deserve schema/JSON-schema surfacing for custom templates?** Custom templates are
   plain JSON with no schema validation of `_templateMeta` today; malformed metadata is silently
   ignored by `parseTemplateMeta`. Staying consistent with that (ignore unknown/ill-typed `required`)
   is the low-risk answer for v1.
2. **Does `feature-driven-loop`'s `planDoc` want its own `required`?** It has a default, so the gate
   never fires. Left optional; revisit if users blank it and hit a workflow with no plan target.

## Verification

`npm run typecheck`, `npm run lint`, `npm test` (extension + UI). Do **not** run
`npm run test:harness` — it costs money and is banned by `test.instructions.md`.

Manual check that the automated tests cannot cover: open **New Workflow**, select Feature-Driven
Loop, confirm Create is blocked until the description is filled, create it, and confirm the generated
workflow has a `plan` step with its end-condition plus the orchestrating final step.
