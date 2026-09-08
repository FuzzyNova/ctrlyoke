# Key/Value Row Editor Plan (Variables + Environment)

> Replaces `KeyValueMapEditor.tsx`'s freeform `KEY=value` textarea with a
> structured two-column row editor plus per-key-kind validation. Covers all
> five call sites: workflow **Variables**, script/pre-/end-condition **env**,
> hook **env**, and MCP server **env** / **headers**.

## Problem

`KeyValueMapEditor` renders a `<textarea>` whose text is parsed back into
`Record<string, string>` on blur. The data model is structured; the editing
surface is not. Three concrete consequences:

**1. Malformed input is silently discarded, not rejected.**
`keyValueMapStringToObject` (`KeyValueMapEditor.tsx:29-49`) drops any line
whose first `=` is at index `< 1` (`separatorIndex < 1` → `continue`). Typing
the nonsense in the second screenshot produces no warning, no border, no
diagnostic — the field simply empties itself on blur and the user's text is
gone. The reported complaint ("basically no validation") is really _silent
data loss_, which is worse than no validation.

**2. The text projection is lossy in ways the `Record` is not.**

| Authored text                | Stored value                                                                                                  | Feedback |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| `  KEY = value  `            | `{"KEY": " value"}` — key trimmed, value keeps its leading space, trailing space lost to the per-line `trim()` | none     |
| `KEY=a` then `KEY=b`         | `{"KEY": "b"}` — the first entry vanishes                                                                     | none     |
| a value containing a newline | impossible to author                                                                                          | n/a      |
| `malformed`                  | dropped                                                                                                       | none     |

**3. The affordances bolted onto the textarea are field-scoped, not
entry-scoped.** The credential heuristic renders one paragraph naming keys
below the whole control, and the "Insert secret reference…" `<select>`
_appends a whole new line_ `NAME=${secret:NAME}` — it guesses the key from
the secret name rather than filling the row the user is editing.

There is also a live false positive: `findLiteralCredentialEnvKeys` tests
values against an **anchored** `^\$\{secret:...\}$` pattern
(`KeyValueMapEditor.tsx:51`), but `SecretResolver`'s
`SECRET_INTERPOLATION_PATTERN` (`src/utils/SecretResolver.ts:26`) is global
and unanchored — `${secret:NAME}` resolves anywhere inside a value. So the
perfectly correct `Authorization=Bearer ${secret:TOKEN}` is flagged as
"looks like a pasted credential" today.

## Recommendation: a structured row editor, not a CodeMirror editor

`ALLOW_DENY_LIST_EDITOR_PLAN.md`'s Follow-Up #1 proposed turning this field
into a multiline CodeMirror editor with lint diagnostics and `${secret:`
completions. **Recommend against that**, and against
`SingleLineCompletionEditor` generally, for this field:

- A CodeMirror linter would put squiggles _on the same lossy text model_. The
  duplicate-key and dropped-line problems are properties of text↔`Record`
  round-tripping, not of the absence of squiggles. A structured editor removes
  the round trip instead of annotating it.
- Allow/deny lists are genuinely one-dimensional (a list of pattern strings
  with real internal syntax — `shell(git:*)`); CodeMirror earns its keep
  there. `Record<string, string>` is two-dimensional and has _no_ internal
  syntax beyond "the first `=` splits" — an invented text grammar the user has
  to learn and get right.
- Secret-name completion needs no extension-host round trip here: the names
  are already in `useSecretRegistryStore`, which this component already
  subscribes to. A per-row picker is strictly simpler than a completion
  source.
- The codebase already has the right precedent three times over —
  `TrustedRootsListEditor.tsx`, `PortListEditor.tsx`, and
  `ModelPricingEditor.tsx` are all structured row editors with inline
  per-entry validation. This field should join them, not the CodeMirror
  family.

Keep a **bulk-edit escape hatch** (see §5) so pasting a `.env` blob and
mass-deleting stay one action, which is the one thing the textarea is
genuinely better at.

---

## Design

### 1. New component: `KeyValueRowsEditor.tsx`

`src/ui/webview-react/components/shared/KeyValueRowsEditor.tsx`, replacing
`KeyValueMapEditor.tsx`. Same outward contract plus a `keyKind`:

```ts
export interface KeyValueRowsEditorProps {
  label: string;
  id?: string;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  /** Selects the key validation vocabulary. See §3. */
  keyKind: KeyValueKeyKind;
  /** Column heading + add-button noun, e.g. "variable", "header". */
  entryNoun?: string;
  ariaLabel?: string;
  disabled?: boolean;
  allowSecretReferences?: boolean;
}
```

`rows` is dropped — height is now row-count-driven.

**Internal editing model.** `Record<string, string>` cannot represent a
half-typed row (empty key), a duplicate key, or a stable identity across a key
rename, so the component holds:

```ts
interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}
```

Three rules that this model exists to enforce, each of which is a real bug if
broken:

- **The React `key` prop is the generated `id`, never the key text.** Keying on
  the text remounts the input on every keystroke and drops focus after one
  character.
- **Renaming rebuilds the record in row order.** Object spread with a changed
  key would move the entry to the end. (Caveat: JS hoists integer-like keys — a
  variable literally named `1` will sort ahead of everything on the next
  `Object.entries` regardless. It is valid per `\w+`; not worth defending
  against beyond a note.)
- **Incoming `value` re-syncs only when it differs from what the current rows
  serialize to.** A blind `useEffect(() => setRows(fromRecord(value)), [value])`
  clobbers an in-progress edit with the parent's echo of a previous commit —
  the same class of controlled-round-trip bug `ALLOW_DENY_LIST_EDITOR_PLAN.md`
  documents for `PermissionListEditor`'s `onChange`.

### 2. Commit semantics — blur, not keystroke

**Load-bearing, do not "simplify".** `WorkflowPropertiesPanel`'s
`handleVarsChange` (`WorkflowPropertiesPanel.tsx:1005`) posts an
`UPDATE_WORKFLOW_PROPERTY` mutation _and_ calls
`syncWorkflowPropertiesForUndo()` on every `onChange`. Committing per keystroke
would write one workflow mutation and one undo entry per character. The
textarea's blur commit is what keeps that sane today; the row editor must keep
it.

Concretely: keystrokes update local row state only; `onChange` fires on a row
field's `blur`, on row add/remove, and on exiting bulk-edit mode. Rows with an
empty key are kept visible but excluded from the committed record. On a
duplicate key, last-wins is preserved (matching today's behavior) and both rows
are flagged — the commit result must never change silently under a user who is
only being warned.

### 3. Key validation is per-kind, and must be single-sourced

The five call sites use three genuinely different vocabularies. Today they
share one component with zero validation, which is why the field can't say
anything useful. New dependency-free module
**`src/utils/KeyValueKeyKinds.ts`** (no `vscode`, no Node imports — importable
from both the webview bundle and the extension host, exactly like
`src/utils/ToolPatternSyntax.ts`):

```ts
export const KEY_VALUE_KEY_KINDS = {
  VARIABLE: "variable",
  ENV: "env",
  HEADER: "header",
} as const;

export type KeyValueKeyKind =
  (typeof KEY_VALUE_KEY_KINDS)[keyof typeof KEY_VALUE_KEY_KINDS];
```

The module also owns the rule evaluation itself, not just the constants: a
pure `validateKeyValueKey(kind, key, allKeys)` returning `FieldDiagnostic`-shaped
`{ severity, message }` entries, so the component renders diagnostics and does
not author them. That is what makes the "reuse extension-side in
`PromptFileParser`" future extension possible without a second copy of the
rules.

Rules, by kind:

```text
variable  (WorkflowPropertiesPanel.tsx:2104)
  error    name must match ^\w+$
  warning  two names differing only in case

env       (ScriptConditionEditor.tsx:367, HooksEditor.tsx:244,
           McpServerForm.tsx:271)
  error    name must match ^[A-Za-z_][A-Za-z0-9_]*$
  warning  name is not all-uppercase (convention only)

header    (McpServerForm.tsx:304)
  error    name must be an RFC 7230 token
  error    duplicate ignoring case (HTTP header names are case-insensitive)

all kinds
  error    exact duplicate key
  warning  empty key with a non-empty value ("this row will not be saved")
```

Two of these rules are not style opinions — they are existing runtime behavior
the UI currently hides:

- **`^\w+$` for variables** comes from `VarSubstitutor.PLACEHOLDER_RE`
  (`src/utils/VarSubstitutor.ts:38`), which is `/\{\{(\w+)\}\}/g`. A variable
  named `my-var` is accepted by `schemas/workflow-schema.json`'s `varsConfig`
  (`additionalProperties: { "type": "string" }`, no key pattern) and stored
  happily, but `{{my-var}}` can never match it. The variable is unreferenceable
  and the user is told nothing.
  **Single-source it:** export the name pattern's source string from
  `KeyValueKeyKinds.ts` and have `VarSubstitutor` build `PLACEHOLDER_RE` from
  it, rather than copying `\w+` into a second file where it can drift.
- **The case-collision warning** comes from `ScriptProcessRunner.ts:80`, which
  exports every variable as `CTRLYOKE_VAR_${key.toUpperCase()}`. Vars `region`
  and `REGION` therefore collide into one environment variable, and which one
  wins depends on `Object.entries` order. That is worth a warning and is
  invisible today.

**Worked example of why the variable rule earns its keep.** A hyphenated name
like `latest-log` is the natural thing to type, is accepted by the schema, and
is silently unreferenceable: `{{latest-log}}` cannot match
`/\{\{(\w+)\}\}/`, so the placeholder survives into the dispatched prompt as
literal text and the workflow runs with `{{latest-log}}` in it. Today the only
feedback is an after-the-fact unresolved-placeholder advisory from
`VarSubstitutor.findUnresolvedVariables` at run time. This editor should catch
it at the moment it is typed and say what to use instead (`latest_log`).

**Optional third `env` rule — variable shadowing.** `ScriptProcessRunner.ts:85`
applies step `env` _after_ the `CTRLYOKE_VAR_*` block
(`Object.assign(cleanEnv, options.env)`), so an env key literally named
`CTRLYOKE_VAR_FOO` silently overrides workflow variable `foo` for that script.
Worth a **warning** on `env` rows whose key starts with `CTRLYOKE_VAR_`. Cheap
and self-contained; include it if the row-diagnostic slot is already built,
skip it without regret if v1 is running long.

**Secret references are not enabled on the Variables field, and stay that
way.** `WorkflowPropertiesPanel.tsx:2104` is the one call site that omits
`allowSecretReferences`; the other four pass it. So the per-row secret picker,
the credential heuristic, and the unknown-reference warning are all inert on
Variables by design. Do not "fix" that as part of this work — enabling secret
references for workflow variables is a separate decision about whether
`${secret:}` resolves in `vars:`, which it does not today.

Validation runs synchronously in the webview against the current rows — no
message plumbing, no extension-host round trip, nothing new in
`WebviewMessageRouter`/`PromptEditorSupportService`.

### 4. Value column

Free text, one `<input>` per row. Two diagnostics, both value-scoped:

- **Credential heuristic**, refactored from
  `findLiteralCredentialEnvKeys(record): string[]` to a per-entry predicate
  `looksLikeLiteralCredential(key, value): boolean`, with the plural helper
  kept as a thin wrapper over it — `McpServersEditor.tsx:287` uses the plural
  form for a server-row badge and must keep working. Fix the anchored-pattern
  false positive at the same time: test with the _unanchored_ interpolation
  pattern (a value containing `${secret:NAME}` anywhere is a reference, not a
  pasted credential), matching `SecretResolver.ts:26`.
- **Unknown secret reference** (only when `allowSecretReferences`): a
  `${secret:NAME}` whose `NAME` is absent from `useSecretRegistryStore`'s
  user+workspace entries → **warning**. The registry is already loaded by this
  component; this is free.

**Per-row secret picker** replaces the field-level `<select>`: a small key icon
button at the end of the value input opens the existing secret list and sets
_that row's_ value to `${secret:NAME}`. Drops the current "append a whole new
`NAME=${secret:NAME}` line" behavior, which invents a key name the user didn't
ask for.

### 5. Bulk edit + paste

Two paths, both required — a row editor that can't absorb a pasted `.env` blob
is a downgrade for the people who use this field most.

- **Paste into a key field**: if the pasted text contains a newline or an `=`,
  run it through the existing `keyValueMapStringToObject` grammar and expand it
  into rows starting at the current one. **Lines that fail to parse become a
  row carrying the raw text in the key column with an error diagnostic** —
  visible and fixable, instead of the silent drop that produced the second
  screenshot.
- **Bulk edit toggle**: a small "Bulk edit" link swaps the rows for the
  existing textarea, seeded via `keyValueMapObjectToString`; leaving bulk mode
  parses back through `keyValueMapStringToObject` and commits. Both helpers
  stay exported for exactly this. This is the fast path for reordering, mass
  delete, and diff-paste from another workflow.

### 6. Layout

Grid with explicit tracks, not flex negotiation (per
`webview-react-components.instructions.md`):
`grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]` — key, value, row actions.
Below the panel's narrow breakpoint the row stacks (key above value) with the
delete button pinned to the key line; `WorkflowPropertiesPanel` and
`PropertiesDrawer` are both narrow surfaces and `McpServerForm` renders inside
a modal, so the stacked tier is the common case, not the exception.

Empty state and add affordance follow `TrustedRootsListEditor`/`PortListEditor`
copy: a bordered `No variables configured.` placeholder and an
`+ Add variable` button (noun from `entryNoun`). Enter in the last row's value
field appends a row.

### 7. Accessibility

- The control is a `role="group"` labelled by the existing label element; `id`
  (currently on the textarea) moves to that group. No call site currently wires
  a `<label htmlFor>` to it — `WorkflowPropertiesPanel`'s Variables `FormField`
  omits `htmlFor`, and the other four render the component's own label — so
  nothing breaks.
- Every input carries its own `aria-label` — `${entryNoun} name` /
  `${entryNoun} value`, disambiguated by the row's key once it has one
  (`Value for API_TOKEN`) so a screen reader isn't reading "value, value,
  value".
- Per-row diagnostics render through the shared `FieldDiagnostic` component and
  are wired to the offending input with `aria-describedby` + `aria-invalid`,
  matching how `WorkflowPropertiesPanel` already surfaces field validation.
- Delete buttons get an `aria-label` naming the row's key (or "empty row"),
  matching `TrustedRootsListEditor`'s per-row labelling.

---

## Affected files

| File                                                                | Action  | Purpose                                                                                                                                    |
| ------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/utils/KeyValueKeyKinds.ts`                                     | Create  | Dependency-free key kinds, name patterns, and diagnostic rules                                                                             |
| `src/utils/VarSubstitutor.ts`                                       | Modify  | Build `PLACEHOLDER_RE` from the shared variable-name pattern                                                                               |
| `src/ui/webview-react/components/shared/KeyValueRowsEditor.tsx`     | Create  | The row editor, bulk-edit mode, per-row secret picker                                                                                      |
| `src/ui/webview-react/components/shared/KeyValueMapHelpers.ts`      | Create  | Retain `keyValueMapObjectToString`/`keyValueMapStringToObject` + the credential heuristic (now `looksLikeLiteralCredential` + wrapper) in a helpers-only module |
| `src/ui/webview-react/components/shared/index.ts`                   | Modify  | Export the new component/types and helpers; drop `KeyValueMapEditor`                                                                       |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Modify | Variables field → `keyKind="variable"`                                                                                                     |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`  | Modify  | env field → `keyKind="env"`                                                                                                                 |
| `src/ui/webview-react/components/editor/HooksEditor.tsx`            | Modify  | hook env → `keyKind="env"`                                                                                                                  |
| `src/ui/webview-react/components/shared/McpServerForm.tsx`          | Modify  | stdio env → `keyKind="env"`; remote headers → `keyKind="header"`; it also re-exports `findLiteralCredentialEnvKeys` (line 7) — keep that chain intact |
| `src/ui/webview-react/components/shared/McpServersEditor.tsx`       | Modify  | Import path for the plural credential helper                                                                                               |
| `src/ui/webview-react/test/components/shared/McpServerForm.test.ts` | Modify  | Covers `findLiteralCredentialEnvKeys` directly; must follow the helper and gain the `Bearer ${secret:TOKEN}` false-positive case           |
| `src/ui/webview-react/test/components/shared/KeyValueMapEditor.test.tsx` | Delete  | Obsolete textarea assertions; equivalent row and bulk-mode coverage lives in `KeyValueRowsEditor.test.tsx`                              |
| `src/test/unit/KeyValueKeyKinds.test.ts`                            | Create  | Pure validation-rule tests                                                                                                                 |

## Implementation steps

1. [x] `KeyValueKeyKinds.ts` + its unit tests; point `VarSubstitutor` at the shared
   variable-name pattern and confirm the existing `VarSubstitutor` coverage
   still passes unchanged. Exports: `KEY_VALUE_KEY_KINDS`, `KeyValueKeyKind`,
   `VARIABLE_NAME_PATTERN_SOURCE`, `VARIABLE_NAME_PATTERN`, and
   `validateKeyValueKey`.
2. [x] Refactor the credential heuristic to `looksLikeLiteralCredential(key, value)`,
   fix the anchored-pattern false positive, keep `findLiteralCredentialEnvKeys`
   as a wrapper (`McpServersEditor` depends on it). Both helpers remain
   exported from `KeyValueMapHelpers.ts`.
3. [x] Build `KeyValueRowsEditor` — rows model, blur commit, validation display,
   per-row secret picker, add/delete, stacked/wide layout. The component is
   intentionally not exported from `shared/index.ts` and no call site is wired
   yet; step 4 can add paste/bulk-edit behavior in the same component before
   step 5 performs the all-at-once migration. Its value diagnostics reuse
   `looksLikeLiteralCredential` from `KeyValueMapHelpers.ts`, whose helper
   remains available after the component migration.
4. [x] Add paste-expansion and the bulk-edit toggle.
5. [x] Roll out all five call sites in one change (they share one component;
   staging them means maintaining both editors against the same store shapes).
6. [x] Tests (below).
7. [x] Gate: `npm run typecheck`, `npm run lint`, `npm test`. Never
   `npm run test:harness`.

The parsing and credential helpers live in
`src/ui/webview-react/components/shared/KeyValueMapHelpers.ts`.

## Test coverage

The former `KeyValueMapEditor.test.tsx` asserted textarea mechanics and is
deleted, but each of its behaviors has a row-editor analogue that must be
carried over, not dropped:

| Existing assertion                                   | Row-editor analogue                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| no commit per keystroke, commit on blur              | typing in a key/value input does not call `onChange`; blurring it does                    |
| `=` preserved inside values                          | a value containing `=` round-trips (now trivially true — kept as a bulk-mode regression guard) |
| secret picker inserts a reference                    | the per-row picker sets _that_ row's value and leaves its key alone                       |
| credential warning only when `allowSecretReferences` | unchanged, now rendered per row                                                           |
| disabled state disables editing and the picker       | all inputs, the picker, add, and delete are disabled                                      |

New coverage:

- Renaming a key preserves row order and does not drop focus.
- A duplicate key flags both rows and still commits last-wins.
- An empty key row stays visible and is excluded from the commit.
- Each `keyKind`'s error and warning rules (`my-var` as a variable, `1BAD` as
  an env name, `bad header` as a header, `region`/`REGION` case collision).
- `Bearer ${secret:TOKEN}` is **not** flagged as a pasted credential.
- Pasting a multi-line `.env` blob into a key field expands into rows, and an
  unparseable line becomes a visible errored row rather than disappearing.
- Bulk-edit round trip commits the same record the rows would have.

## Decisions

All four open questions are settled. Nothing below is left to implementation.

1. **`keyKind` is required.** Four of five call sites are `env`, so a default
   would be right most of the time and silently wrong for exactly the two
   fields (Variables, headers) whose rules differ — and a wrong default means
   a validation rule that never fires. Required forces the choice at every new
   call site.
2. **`KeyValueMapEditor` is deleted, not kept alongside.** Pre-release, five
   call sites, all migrating at once; two components reading the same store
   would drift. The parsing helpers survive because bulk mode and
   `McpServersEditor` still need them — the _component_ does not.
3. **Row reordering is cut entirely — not deferred.** Investigated whether
   `Record` iteration order ever changes behavior; it does not, anywhere:
   - `VarSubstitutor` resolves by `hasOwnProperty` lookup, never by iteration.
   - `ScriptProcessRunner.ts:79-81` (the `CTRLYOKE_VAR_` loop) is the only order-sensitive loop in the
     codebase (`CTRLYOKE_VAR_${key.toUpperCase()}`), and it is order-sensitive
     _only_ under the case collision this plan now flags as a warning. Fixing
     the collision removes the dependency; preserving the order does not.
   - `ParallelGroupPreflight.ts:136` freezes `{...workflow.vars}` per member —
     a copy, order-insensitive.
   - MCP env/headers are handed to the harness as objects; nothing iterates
     them positionally.
   The only real effect of order is the key order written into the workflow
   file, i.e. git-diff churn. That argues for *stability*, not for a reorder
   affordance: rows render in `Object.entries` order, new rows append, and
   nothing ever re-sorts. Drag handles would import the dnd-kit machinery
   `webview-react-components.instructions.md` documents as a source of real
   feedback-loop bugs, in exchange for a cosmetic win — and bulk-edit mode
   already reorders by hand for the rare case someone wants to group keys.
   **Remove the idea; do not carry it as a Future Extension.**
4. **Multiline values are out of v1.** Note it becomes _possible_ for the first
   time under this design — the textarea grammar could never express a newline
   in a value. If a PEM-shaped value is ever wanted inline, it should arrive as
   a per-row "expand" affordance, not by making every value input a textarea.
   The right answer for a PEM today is a managed secret plus `${secret:NAME}`.

### Forward compatibility: computed variables

`COMPUTED_VARIABLES_PLAN.md` proposes variables whose value is produced by a
script at execution time (`{{test_coverage_percent}}`) rather than authored as
a literal. That is an engine feature and is deliberately out of scope here, but
it lands in **this** editor's UI, so two constraints follow for v1:

- The row model must be able to grow a per-row _kind_ (literal vs. computed)
  without a rewrite. `KeyValueRow` already carries an `id` distinct from its
  key, which is what makes a row able to hold something other than a plain
  string value later.
- Do not push the literal-string assumption into the `onChange` contract beyond
  what `Record<string, string>` already forces. Keep the value column's editing
  logic in one place so a second value renderer can be slotted in.

No v1 work is required for either — just don't design them out.

## Future extensions

- **Computed variables** — see `COMPUTED_VARIABLES_PLAN.md`. That plan owns the
  engine work; this editor is the surface it renders in (see "Forward
  compatibility" above).
- **Variable-reference awareness.** `VarSubstitutor.findUnresolvedVariables`
  already computes unresolved `{{name}}` placeholders for diagnostics. The
  Variables editor could show, per row, whether the variable is actually
  referenced anywhere in the workflow, and offer a "declare it" affordance for
  placeholders that resolve to nothing — turning the panel into the place you
  discover a typo'd `{{stepName}}`, instead of the run log.
- **Codex composite-interpolation warning for MCP env/headers.**
  `CodexCliProvider.splitCodexEnvironment`
  (`src/core/harness/codex/CodexCliProvider.ts:84-102`) **throws** for an MCP
  env value that embeds `${secret:...}` inside a larger string, and
  `splitCodexHeaders` special-cases exactly `Bearer ${secret:NAME}`. So
  `Authorization=Bearer ${secret:TOKEN}` works on Codex while
  `X-Api-Key=key-${secret:TOKEN}` fails at run time. That is a harness
  compatibility fact, so it belongs in the existing
  `compatibilityDiagnostics.ts`/`FieldDiagnostic` pipeline rather than in this
  editor's own syntax rules — but the row editor is the surface that would
  display it, and the per-row diagnostic slot built here is what makes that
  possible.
- **Reuse the `KeyValueKeyKinds` rules extension-side** to validate
  file-authored `vars:`/`env:` blocks at parse time, so a hand-edited YAML gets
  the same feedback the dashboard gives. The module is deliberately
  dependency-free so `PromptFileParser` can import it.

## Non-goals

- Any change to how variables or env are resolved, substituted, or injected at
  execution time. This is authoring-time feedback only — including computed
  variables, which are `COMPUTED_VARIABLES_PLAN.md`'s scope.
- Row reordering, in any form. See Decision #3 — cut, not deferred.
- Adding a key pattern constraint to `schemas/workflow-schema.json`. The editor
  warns; the schema stays permissive so an existing workflow with an
  unreferenceable variable still loads.
- Blocking save or run on a validation error. Every rule here is advisory —
  consistent with the stance `ALLOW_DENY_LIST_EDITOR_PLAN.md` and
  `HARNESS_HELP_FLAG_COMPLETIONS_PLAN.md` both take.
- Masking or hiding values. This field holds references, not secrets;
  `SecretsSection` remains the only place a secret value is ever entered.
- MCP per-server `autoApprove`/`deniedTools` (different vocabulary — see
  `ALLOW_DENY_LIST_EDITOR_PLAN.md` Follow-Up #2).
