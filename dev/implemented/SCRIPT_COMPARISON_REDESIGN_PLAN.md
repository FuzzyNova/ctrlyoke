# Script Comparison Redesign Plan

> Status: **implemented.** All four open design questions were decided (see
> "Decisions") and the change landed in full: schema, evaluator, verdict contract,
> dashboard editor, CLI output, tests, docs, templates, and the `manual-test/`
> corpus. Two surfaces this plan originally missed are recorded at the bottom.

## Problem

`compareSource` + `returns` are the only controls a user gets over whether a
`preCondition`, `endCondition`, or `scriptStep` passed. Three things about them are
wrong, and the third is worse than it looks from the UI.

1. **`auto` is a mode whose meaning depends on the value you typed.** `'true'`/`'false'`
   silently switch to exit-code semantics; anything else compares stdout.
2. **`returns: "true"` is asked for, then translated to exit code 0.** The UI even prints
   the apology: `"Shell exit codes: true = 0 (success) · false = non-zero (failure)"`
   (`ScriptConditionEditor.tsx:395`). We invented a boolean, then had to explain that it
   is inverted from every language the user writes in.
3. **There is no comparison operator, and the one we actually apply is inferred from the
   data at runtime.** `EndConditionEvaluator.checkResult()`
   (`src/core/EndConditionEvaluator.ts:1068-1135`) is a four-stage waterfall, tried in
   order:

   | Stage | Rule                                                                                                                      | `matchRule`  |
   | ----- | ------------------------------------------------------------------------------------------------------------------------- | ------------ |
   | 1     | exact match (both sides trimmed + lowercased)                                                                             | `exact`      |
   | 2     | boolean synonyms (`true/1/yes/pass/passed` vs `false/0/no/fail/failed`), only when `expected` is literally `true`/`false` | `boolean`    |
   | 3     | **if both sides `parseFloat` → `actual >= expected`**                                                                     | `numericGte` |
   | 4     | **`actual.includes(expected)`**                                                                                           | `substring`  |

So "is it exact, or contains?" has no answer today — it is whichever stage fires first for
that run's output. Two consequences that are outright bugs from the author's point of view:

- `expected: "0"` against stdout `"10 errors"` **passes**. `parseFloat("10 errors")` is
  `10`, `10 >= 0`, stage 3 wins. Every "expect zero of something" condition is silently
  a `>=` against a number scraped off the front of the line.
- `expected: "PASS"` against stdout `"3 PASSED, 2 FAILED"` **passes** via stage 4.

The operator is also invisible after the fact except as the "Matched by" row in
`ScriptVerdict.tsx` — we report which rule we guessed, which is a tell that the guess
should have been the user's to make.

Three more inconsistencies worth folding into the same change:

- **`stdout` secretly ANDs in a clean exit; `stderr` does not.** `evaluateSuccess`
  (`:1007-1016`) requires `result.success` for stdout and auto-non-boolean, but
  `stderr` ignores the exit code entirely. Nothing in the UI says so.
- **Script steps and conditions already disagree on the default.**
  `WorkflowExecutor.ts:2519` resolves script steps to `compareSource: exitCode,
returns: "0"`, while pre/end conditions default to `auto`. The new default below
  matches what script steps already do, so only conditions change behavior.
- **`returns` is _mandatory_ on an `endCondition`** — `CtrlYokeTypes.ts:1003` narrows it to
  `returns: string`, `workflow-schema.json`'s `endCondition` has
  `required: ["script", "returns"]`, and `settings-schema.json:244` repeats it. That is
  _why_ `returns: "true"` appears in ~30 authored files: the schema forces every author to
  write a boolean they never wanted. Dropping the requirement is what turns migration into
  deleting two lines.

---

## Recommended design

Replace the two-field guess with an explicit three-part comparison that reads as a
sentence, and make "the script succeeded" the zero-config default so no boolean is ever
requested from the user.

### Schema

```yaml
endCondition:
  script: npm test
  compareSource: stdout # stdout | stderr | exitCode   (was: + auto)
  operator: contains # new; defaults to eq
  expected: "0 failing" # was: returns
  ignoreCase: false # new, optional; string operators only
```

| Change                                                | Why                                                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drop `auto` from `COMPARE_SOURCES`**                | It exists only to guess stage 2 vs stages 1/3/4. With an operator, there is nothing left to guess.                                                                                             |
| **Default `compareSource` to `exitCode`**             | Matches `WorkflowExecutor.ts:2519`'s existing script-step default; matches what "did the command work" means on a shell.                                                                       |
| **Rename `returns` → `expected`**                     | The runtime, the verdict, and `$endCondition:expected` already call it `expected`. `returns` reads as "the value the script returned", which is exactly what invites the true/false confusion. |
| **`expected` becomes optional everywhere**            | Absent = "exits 0". Removes the forced-boolean requirement described above.                                                                                                                    |
| **`expected` accepts `string \| number`**             | `expected: 0` instead of `returns: "0"`. Normalized to string at the parse boundary. The forced quoting is itself one of the cringe points.                                                    |
| **Add `operator`**                                    | The whole point: the author states the comparison, the evaluator stops inferring it.                                                                                                           |
| **Remove boolean keywords from exit-code comparison** | This is the fix for tension #2 — see below.                                                                                                                                                    |
| **Remove the implicit clean-exit AND on stdout**      | If the author says `stdout contains "0 failing"`, that is the condition. Hidden conjunctions are the same class of bug as hidden operators.                                                    |
| **Add optional `ignoreCase`**                         | Today every comparison is silently lowercased. Default `false` (case-sensitive, what `==` means everywhere else) and let the author opt back in.                                               |

### Resolving the true = 0 tension by never asking for a boolean

The discomfort is real but it is not caused by exit codes — it is caused by ctrlyoke
asking for a boolean and then mapping it onto one. Exit 0 does not mean `true`; it means
"no error". So stop offering the translation:

- **Nothing configured** → pass when the script exits 0. Surfaced in the UI as
  _"Passes when the script exits with code 0"_, never as `true`.
- **Someone genuinely wants a specific code** → `compareSource: exitCode`,
  `operator: eq`, `expected: 3`. Pure integers.
- **`true` / `false` are no longer accepted as exit-code values at all.** There is no place
  left where `true` silently becomes `0`.

The old `returns: "false"` (pass when the script fails) becomes
`compareSource: exitCode, operator: ne, expected: 0` — which says what it does.

`SCRIPT_BOOLEAN_OUTPUT_VALUES` (`true/1/yes/pass/passed/...`, `DashboardConstants.ts:182`)
goes away with stage 2. A script that prints `PASS` is served by
`stdout eq PASS` or `stdout contains PASS`, stated out loud. The five bundled
`check_condition.*` templates print `"true"` **and** `exit 0` redundantly today, so
dropping stdout boolean synonyms does not break them — but they should be rewritten to
exit-code-only so the templates teach the real contract.

### `returns` absent stops being a special case

`evaluateSuccess` currently branches on `returns === undefined` before it looks at
`compareSource` (`:956-964`) — which is why `compareSource: stdout` with no `returns`
silently means "exit 0" today. Under the new model that branch disappears: the omitted
trio simply defaults to `exitCode` / `eq` / `0` and runs the one normal code path. To keep
half-configured states from meaning something surprising, enforce in schema:

> If `compareSource` or `operator` is present, `expected` is required
> (except for `isEmpty` / `isNotEmpty`, which take no value).

Draft-07 spells this `dependencies: { compareSource: ["expected"], operator: ["expected"] }`
— **not** `dependentRequired`, which is draft 2019-09 and would be silently ignored by both
the editor's JSON language service and the schema as declared
(`workflow-schema.json` is `"$schema": "http://json-schema.org/draft-07/schema#"`).
The `isEmpty`/`isNotEmpty` carve-out needs an `if/then` beside it, or can be enforced in
`PromptFileParser` validation instead if the schema branch gets ugly — a parser diagnostic
is acceptable here because the UI cannot produce the invalid state anyway.

### Operator tokens: words on the wire, symbols in the UI

**Symbolic tokens cannot be used as YAML values.** Verified with the project's own `yaml`
package:

| Authored       | Result                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| `operator: >=` | **hard parse error** — `Block scalar header includes extra characters` |
| `operator: !=` | **silently parses to `""`** — `!=` is read as a YAML tag               |
| `operator: ==` | ok                                                                     |
| `operator: <=` | ok                                                                     |

`!=` silently becoming an empty string is precisely the class of bug this change exists to
delete, so the wire format uses word tokens and the dropdown renders symbols — the same
value/label split `COMPARE_SOURCE_LABELS` already uses (`exitCode` → `Exit Code`).

| Group     | Token                       | UI label                    | Notes                                                                                                                                         |
| --------- | --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Equality  | `eq` _(default)_            | `==`                        | Trimmed whole-value string compare; numeric compare when `compareSource: exitCode`.                                                           |
|           | `ne`                        | `!=`                        |                                                                                                                                               |
| Substring | `contains`                  | `contains`                  | The explicit version of today's accidental stage 4.                                                                                           |
|           | `notContains`               | `does not contain`          |                                                                                                                                               |
| Numeric   | `gte` / `gt` / `lte` / `lt` | `>=` / `>` / `<=` / `<`     | The explicit version of stage 3. **Both sides must parse as numbers** — if not, the condition _fails_, never degrades.                        |
| Regex     | `matches`                   | `matches regex`             | Unanchored by default. See below.                                                                                                             |
| Emptiness | `isEmpty` / `isNotEmpty`    | `is empty` / `is not empty` | Hides the value input, which also resolves a UI ambiguity: an empty text box cannot otherwise mean "expect empty output" vs "not configured". |

#### `matches` vs `eq`

- **`eq`** compares the **entire** trimmed value literally. `expected: "0 failing"` passes
  only if the whole trimmed stdout is exactly `0 failing`. No characters are special — a
  `.` is a dot.
- **`matches`** treats `expected` as a **regular expression**, and it is **unanchored**, so
  it matches anywhere in the value unless the author writes `^`/`$`. `.` means any
  character, and `|`, `[]`, `\d`, `+`, `*`, `?` all have their regex meanings.

So `matches` with `^...$` and no metacharacters is equivalent to `eq`, and `matches`
without anchors overlaps `contains`. The reason all three exist is that `eq` and `contains`
need no escaping and cover most cases, while `matches` is the one that replaces a wrapper
script:

```yaml
expected: "^\\d+ passing, 0 failing$" # shape, not a fixed string
expected: "coverage: (9[0-9]|100)%" # a range
```

Two consequences to document: an unanchored pattern is a _contains_-style match (the most
likely author surprise), and `\` needs YAML/JSON escaping.

#### Two operator-semantics calls

- **Numeric operator against non-numeric output** → **fail**, not `errored`. `errorBehavior`
  is for ctrlyoke being unable to run the thing or the script crashing; a comparison whose
  operand is the wrong type is a failed comparison, which belongs to the author's `onFail`
  (and a retry at least gives the model a shot at fixing the script). **No new contract
  field for the reason** — the verdict already renders `Compare: stdout >= 80` next to
  `Actual: none`, which reads correctly on its own. Document it instead of growing the
  payload we are otherwise shrinking.
- **`matches` and ReDoS.** The pattern is author-written (no new trust boundary — we
  already run their scripts) but the _input_ is model-influenced output, and a hang lands
  in the extension host, which is worse than a script timeout. Bound `actual` length before
  matching and note it in the docs.

### What this deletes

The payoff is not just clarity — an explicit operator makes three existing contract fields
redundant:

- **`ScriptVerdict.actualSource`** — it exists only because `auto` resolves to a source at
  runtime. `resolveActualSource()` (`:1043-1056`) returns `compareSource` verbatim in every
  non-auto branch, so with `auto` gone `actualSource ≡ compareSource`. Delete the field,
  `resolveActualSource()`, and the `auto → stdout` label logic in `ScriptVerdict.tsx:24-35`
  and `CliTerminalFormatter.ts:126-132`.
- **`ScriptVerdict.matchRule` / `ScriptMatchRule` / `SCRIPT_MATCH_RULE_NONE`
  (`DashboardConstants.ts:3517`) / `SCRIPT_MATCH_RULE_LABELS`
  (`CliTerminalFormatter.ts:77`)** — "which rule did we guess" collapses into `operator`
  plus `passed`. The "Matched by" rows (`ScriptVerdict.tsx` expanded view,
  `CliTerminalFormatter.ts:707`) go away; the collapsed line reads
  `stdout contains "0 failing"`.
- **`checkResult()`'s waterfall and `SCRIPT_BOOLEAN_OUTPUT_VALUES`** — replaced by a pure
  comparator.

So `EvaluationComparison` shrinks from four fields to `{ passed, actual }`,
`EvaluationResult` drops both, and `ScriptVerdict` becomes `compareSource`, `operator`,
`expected`, `actual`, `passed` — five fields a user can read back and reproduce by hand.
The verdict's `operator` is populated the same way `compareSource` already is, from the
resolved config in `ScriptExecutionReporter.ts:367`, not from the comparison result.
`WorkflowExecutor.ts:2594`'s `matchRule: ptyTimedOut ? "none" : comparison.matchRule` line
simply disappears — the timeout is already carried by `timeout`/`errored` on the same
object.

### Where the comparator lives

New `src/utils/ScriptComparison.ts`, exporting two pure functions:

- `compareScriptOutput({ compareSource, operator, expected, ignoreCase }, result)` → `{ passed, actual }`
- `describeComparison({ compareSource, operator, expected })` → the human sentence

Both are needed on the extension-host side (`EndConditionEvaluator.evaluateCondition`,
the interactive-PTY `evaluateResult` path at `WorkflowExecutor.ts:2580-2595`,
`ExecutionPreviewService.ts:1281`, `CliTerminalFormatter`) **and** in the webview (the
drawer hint). `ScriptConditionEditor.tsx` already imports `@root/utils/ShellCatalog`, so
`src/utils/` is the established shared home for exactly this shape of helper. One
`describeComparison` means the drawer hint, the execution preview, and the CLI verdict all
phrase the condition identically instead of three hand-written strings drifting apart.

### UI: one sentence instead of two disconnected dropdowns

`ScriptConditionEditor.tsx` currently renders a `Compare Source` select with a paragraph of
hint text plus an `Expected Return` box with an apology about exit codes. Replace both with
a labelled `Pass when` row:

```
Pass when
[ Exit code ▾ ]  [ == ▾ ]  [ 0                      ]
Passes when the script exits with code 0.
```

- The three controls are the schema trio, in reading order.
- Unset state shows the defaults (`Exit code`, `==`, placeholder `0`) as greyed hints and
  serializes **nothing** — the author sees what will happen without the file carrying it.
- The sentence under the row is `describeComparison(...)`, so it is generated, not authored
  per-branch. It replaces both `compareSourceHint` and `returnsExitCodeHint`.
- `isEmpty` / `isNotEmpty` hide the value input.
- `ignoreCase` renders as a checkbox only while a string operator (`eq`, `ne`, `contains`,
  `notContains`) is selected. Per `webview-react-components.instructions.md`: when it is
  hidden, the operator's `onChange` must _clear_ `ignoreCase`, not merely stop displaying
  it, or a stale `ignoreCase: true` stays serialized on a numeric comparison.

"Pass when …" also does the rhetorical work on tension #2: the author reads
`Pass when exit code == 0` and never encounters a boolean to be confused by.

This one component is the editor for **all four** authoring surfaces — step script
(`PromptEditor.tsx`), step pre/end condition (`PropertiesDrawer.tsx`), workflow defaults
(`WorkflowPropertiesPanel.tsx`), and global settings defaults
(`settings/defaults/DefaultsValidationPage.tsx`) — so the row is written once.

---

## Decisions

| #   | Question                                    | Decision                                                                                                                                           |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Operator list                               | **All eleven.** `eq` `ne` `contains` `notContains` `gte` `gt` `lte` `lt` `matches` `isEmpty` `isNotEmpty`, as word tokens with symbolic UI labels. |
| 2   | `ignoreCase`                                | **Add it.** Optional, default `false` (case-sensitive), shown only for string operators.                                                           |
| 3   | Numeric operator against non-numeric output | **`failed`**, not `errored` — `errored` is for a script that threw or crashed; a wrong-typed operand is a failed comparison, so `onFail` owns it.  |
| 4   | `compareSource` name                        | **Keep it.** 72 files reference it and the name gets _more_ accurate once `auto` is gone.                                                          |

## Rejected alternatives

- **A one-line DSL (`expect: stdout contains "0 failing"`).** Reads beautifully in YAML and
  would suit the composer agent, but it needs a parser with its own error messages, it
  cannot be validated by JSON Schema, and the drawer — the primary authoring surface — still
  needs three controls plus lossless round-tripping back to the string. Not worth it.
- **Symbolic operator tokens on the wire.** Verified unusable in YAML (see above).
- **Keeping `auto` as a convenience default.** Any default that changes semantics based on
  the value typed into a different field is the original defect.
- **Keeping the boolean synonyms as an explicit `isTruthy` operator.** Defensible (the
  problem today is that they fire invisibly, not that they exist), but it re-imports the
  true/false vocabulary this change exists to remove, and `contains PASS` covers it.
- **A `requireCleanExit` flag to preserve the stdout + exit-0 AND.** Adds a field to
  reproduce a behavior nobody asked for. If both genuinely matter, that is two conditions —
  a future `checks: []` array with AND semantics, not a boolean bolted onto one check.
- **A `failureReason` field for the non-numeric case.** Four contracts grown for one
  sentence the verdict already implies.

## Deliberately out of scope

- **Multiple checks per condition (`checks: []`).** The flat trio is the right first cut;
  an array can be added later as a mutually exclusive alternative (the `errorBehavior`
  `oneOf` precedent) without disturbing it. Do not shape the schema around it now.
- **`$endCondition:operator` as a new retry-prompt reference.** Cheap and arguably useful in
  a retry prompt, but additive and independent of this change.

---

## Implementation surface

Pre-release, so no compatibility shim — but `returns` / `auto` appear in ~30 authored files
and the meaning change is silent, so the migration has to be deliberate.

### Order of work

1. **Constants + types** — `DashboardConstants.ts`, `CtrlYokeTypes.ts`.
2. **`src/utils/ScriptComparison.ts`** + a direct unit test for it.
3. **`EndConditionEvaluator.ts`** — delete the waterfall, delegate to the comparator.
4. **Remaining core/CLI call sites.**
5. **Schemas** — `workflow-schema.json`, regenerate the YAML, `settings-schema.json`,
   `ValidationUtils.ts`.
6. **UI** — `ScriptConditionEditor.tsx`, `editorStore.ts`, `ScriptVerdict.tsx`, callers.
7. **Tests.**
8. **Docs, templates, `manual-test/` migration.**
9. `npm run lint` · `npm run format` · `npm test`.

### Contracts and schema

- `src/types/DashboardConstants.ts` — drop `COMPARE_SOURCES.AUTO`,
  `SCRIPT_BOOLEAN_OUTPUT_VALUES` (`:182`), `SCRIPT_MATCH_RULE_NONE` (`:3517`); add
  `SCRIPT_OPERATORS` + `SCRIPT_OPERATOR_LABELS` + the derived union next to
  `COMPARE_SOURCES` (`:2792`).
- `src/types/CtrlYokeTypes.ts` — `ScriptProperties` (`:988`): `returns` → `expected`
  (optional), add `operator` / `ignoreCase`; drop the `returns: string` narrowing on
  `EndCondition` (`:1003`); delete `ScriptMatchRule` (`:882`), `ScriptVerdict.matchRule` /
  `.actualSource` (`:889`, `:892`), and `ConditionEvaluationSummary.actualSource` (`:911`).
- `schemas/workflow-schema.json` — the trio, draft-07 `dependencies`, `expected` as
  `string | number`, `endCondition.required` → `["script"]`. The ref topology is:
  `scriptProperties.properties.*` is canonical; `scriptStep` and **`rootScriptStep`** each
  carry their own `additionalProperties: false` allowlist that `$ref`s into it
  (`:394`/`:397` → `scriptStep`, `:887`/`:890` → `scriptProperties`), so **three**
  definitions need `operator`/`ignoreCase` entries, not two.
  **`schemas/workflow-schema.yaml` is generated** — do not hand-edit it; run
  `node scripts/generate-yaml-schema.mjs`.
- `schemas/workflow-schema.json` `conditionEvaluationSummary` (`:1256-1300`) — the
  **persisted** `_runtime` shape for pre/end-condition summaries (`$ref`d at `:1241`,
  `:1245`). `actualSource` is both a property (`:1274`) and a `required` entry (`:1298`);
  remove both. Old run files that still carry the key keep validating, since this
  definition does not set `additionalProperties: false`.
- `schemas/settings-schema.json` — **two** blocks: `defaults.endCondition` (`~:192`) and
  `defaults.preCondition` (`~:253`). Each needs `auto` removed from its `compareSource`
  enum, `returns` renamed to `expected`, `operator`/`ignoreCase` added, and
  `required: ["script", "returns"]` (`:244`) reduced to `["script"]`. These do **not**
  create new settings-UI parity obligations: `settingsSchemaUiParity.integration.test.ts`'s
  `isPlainObjectSchema` deliberately skips `oneOf` nodes, so both leaf out at
  `defaults.endCondition` / `defaults.preCondition` and never recurse into subfields.
- `src/utils/ValidationUtils.ts:87-166` — a **second**, hand-written Ajv schema that lists
  `compareSource` explicitly; needs `expected`/`operator`/`ignoreCase` too.

### Core

- `src/utils/ScriptComparison.ts` — new; `compareScriptOutput` + `describeComparison`.
- `src/core/EndConditionEvaluator.ts` — delete `checkResult` (`:1068`),
  `resolveActualSource` (`:1043`), the `returns === undefined` branch (`:956`), and the
  `switch (compareSource)` in `evaluateSuccess` (`:968`); shrink `EvaluationResult` (`:59`)
  and `EvaluationComparison` (`:79`); update the three `matchRule: "none"` error paths
  (`:242`, `:316`, `:350`).
- `src/core/WorkflowExecutor.ts` — `:2519` resolved defaults, `:2580-2595` interactive-PTY
  verdict (incl. dropping the `matchRule` line at `:2594`), `:3634-3636` synthesized
  verdict, `:3694`, `:3765`.
- `src/core/orchestration/ScriptExecutionReporter.ts` — `:126-128` summary-string builder,
  `:156`, `:367` (add `operator` alongside `compareSource`), `:370`, `:377`.
- `src/core/WorkflowInstance.ts:4161`/`:4195` (worktree-setup script),
  `src/core/EndConditionHandler.ts:503`, `src/core/ConditionOutputRefs.ts:41`,
  `src/core/PromptFileParser.ts:263`, `src/core/WorkflowStepSanitizer.ts` (four sites:
  `:315`, `:352`, `:479`, `:629`), `src/core/ExecutionPreviewService.ts:1281`,
  `src/completions/PromptPropertyCompletionProvider.ts:58`/`:408`.
- `src/cli/CliJsonResultBuilder.ts:107`/`:512` — `actualSource` is part of the
  `ctrlyoke --json` result contract; it goes, `operator` comes in.
- `src/cli/CliTerminalFormatter.ts` — `:77` `SCRIPT_MATCH_RULE_LABELS` (delete),
  `:126-132` compare label, `:707` "Matched by" row (delete).
- The interactive `compareSource: stderr` → forced-headless warning
  (`WorkflowExecutor.ts:2508-2521`) survives unchanged.

### UI

- `components/shared/ScriptConditionEditor.tsx` — the "Pass when" row; `returnsInput` →
  `expectedInput`, new operator select + `ignoreCase` checkbox, both hints replaced by
  `describeComparison`. Control ids: `${idPrefix}-expected`, `${idPrefix}-operator`,
  `${idPrefix}-ignore-case` (must match the round-trip test below).
- `components/editor/PromptEditor.tsx:961`/`:1193`/`:1214`,
  `store/editorStore.ts` (`scriptReturns`/`scriptCompareSource` → `scriptExpected`/… plus
  new operator/ignoreCase state; `:135`, `:191`, `:323`, `:405`, `:437`, `:458`, `:487`,
  `:510`, `:559`), `utils/executionPreview.ts:62`,
  `components/output/ScriptVerdict.tsx` (12 references), `utils/outputRows.ts`.

### Tests

Extension host: `endConditionEvaluator.test.ts` (32 refs — the waterfall cases become
per-operator cases), `scriptExecutionReporter.test.ts` (12), `unit/EndConditionHandler.test.ts`
(8), `unit/CliDryRunOutput.test.ts` (8), `unit/WorkflowExecutor.test.ts` (3),
`unit/CliPromptPreparer.test.ts` (3), `unit/CliJsonResultBuilder.test.ts` (2),
`unit/conditionOutputRefs.test.ts` (2), `unit/PromptQueueConditionSummary.test.ts` (1),
`unit/interactiveScriptStep.test.ts`, `unit/WorkflowStepSanitizer.test.ts`,
`unit/PromptFileLoader.test.ts`, `unit/TemplateManager.test.ts`,
`integration/preConditionFlow.integration.test.ts`,
`integration/schemaUiPropertyRoundTrip.integration.test.ts`.

Webview: `test/components/shared/ScriptConditionEditor.test.tsx` (806 lines),
`test/components/output/OutputRow.test.tsx` (6), `test/utils/outputRows.test.ts` (2),
`test/utils/outputFind.test.tsx` (2).

`schemaUiPropertyRoundTrip.integration.test.ts`'s `UI_CONTROL_IDS` map (`:353`) enumerates
every authorable schema property against a literal control id — replace
`["returns", ["${idPrefix}-returns"]]` and add `operator` / `ignoreCase` entries, or the
suite fails by design.

New: a direct unit test for `ScriptComparison.ts` covering every operator, plus the two
bugs above as explicit regression cases (`expected: 0` vs `"10 errors"` must now **fail**;
`eq PASS` vs `"3 PASSED, 2 FAILED"` must now **fail**, `contains PASS` must pass), the
numeric-vs-non-numeric failure, `ignoreCase` on and off, and `matches` anchored vs not.

### Docs and authored content

- `docs/workflows/end-conditions.md`, `docs/workflows/yaml-format.md`,
  `docs/reference/workflow-schema.md` (`:83-84`, `:94` — hand-maintained, not generated),
  `docs/guide/quick-start.md`, `docs/guide/your-first-workflow.md`,
  `docs/troubleshooting/common-errors.md`, `docs/examples/index.md`, `README.md`.
- `src/templates/check_condition.{sh,ps1,bat,js,py}` — drop the redundant `echo "true"`,
  exit-code only.
- `src/templates/agents/ctrlyoke-workflow-composer.agent.md` (`:34`, `:46`, `:96`, `:118` —
  line 46 currently documents `returns: "true"` as "passes on exit code 0", the cringe
  verbatim in the agent that teaches new users), `ctrlyoke-tech-support.agent.md:143`,
  `src/templates/workflows/{fix-tests,full-feature}.ctrlyoke.yaml`.

### Migration of authored files

| Today                                         | Becomes                                                  |
| --------------------------------------------- | -------------------------------------------------------- |
| `returns: "true"`, no `compareSource`         | delete the line (it is the default)                      |
| `returns: "false"`, `auto`                    | `compareSource: exitCode`, `operator: ne`, `expected: 0` |
| `compareSource: exitCode`, `returns: "0"`     | `compareSource: exitCode`, `expected: 0`                 |
| `compareSource: stdout\|stderr`, `returns: X` | **decide per file** — `eq` or `contains`                 |
| `returns: "<number>"` on stdout               | **decide per file** — `eq` or `gte` (today it is `gte`)  |

The last two need judgment; roughly 15 sites across `manual-test/` (12 files —
`script-contexts-test.ctrlyoke.yaml` is the dense one, with stdout, stderr, exit-code, and a
bare `returns: "42"` whose intent must be read from its comment) and `docs/`.

**Making stale keys fail loudly.** `compareSource: auto` already errors once `auto` leaves
the enum. A leftover `returns` needs help: `endCondition`/`preCondition` are
`allOf: [scriptProperties]` + their own `properties`, so adding
`additionalProperties: false` there hits the classic allOf trap (it cannot see the
inherited `script`/`env`/… and would reject valid files). Instead keep `returns` declared
as an always-failing property:

```json
"returns": {
  "not": {},
  "description": "Removed — renamed to `expected`. See dev/backlog/SCRIPT_COMPARISON_REDESIGN_PLAN.md."
}
```

in `scriptProperties` (inherited by both conditions) and in `scriptStep`/`rootScriptStep`,
so `PromptFileParser`'s Ajv pass (`:177-181`, which throws
`Validation failed: …`) reports the rename by name instead of an opaque
`additionalProperties` complaint.

Rough size: a solid day or two, most of it mechanical once the comparator and the schema
land.

---

## Found during implementation

Both were missed by the plan's inventory and are worth knowing for the next
cross-layer field change:

- **`WorkflowSerializer.PROMPT_FIELDS`** (`src/ui/WorkflowSerializer.ts`) is a
  second, hand-maintained step-field allowlist used by Save As and template
  export. A field missing from it saves silently as `undefined`.
  `ui.instructions.md` already documents that rule — read it whenever a new
  persisted property is added.
- **`rootScriptStep`** is a third schema definition carrying the script
  comparison fields, alongside `scriptStep` and `scriptProperties`. Recorded in
  `core.instructions.md` along with the YAML operator-token constraint.

Two follow-ups were deliberately left out of scope and remain open:

- `$endCondition:operator` as a retry-prompt reference.
- `checks: []` for multiple AND-ed comparisons in one condition.
