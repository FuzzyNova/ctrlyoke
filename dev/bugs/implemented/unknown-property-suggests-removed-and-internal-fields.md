# Unknown-field warnings suggest removed and internal fields, and suggest something for any typo

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `src/core/PromptFileParser.ts` (`createUnknownPropertyWarning`, `getValidKeysAtPointer`, `nearestKey`)
- **Resolution:** fixed in this commit

## Symptom

An unknown workflow field produces the `unknown-property` warning
`Unknown property '<x>' at <pointer>. Did you mean '<key>'? …`. The CLI
(`ctrlyoke validate`) and the dashboard (`FILE_SELECTED.schemaWarnings`) both
show it. The suggested key is often wrong in ways that mislead the user:

1. **It suggests `returns`**, which the schema still lists only so it can reject
   it (`"not": {}`, "Removed — renamed to `expected`"). Following the hint turns
   a warning into a hard validation failure.
2. **It suggests internal fields** such as `_runtime` (view-only runtime
   metadata) and `_templateMeta`, which users never write.
3. **It always suggests something**, however far off the typo is. There is no
   distance cutoff, so `qqqqqqqqqqqqqq` gets "Did you mean '_runtime'?".

The docs (`docs/cli/ctrlyoke.md`, "Workflow warnings") say the message
"suggests the nearest valid key". A removed or internal key is not a valid key,
and a key nothing like the typo is not a useful suggestion.

## Steps to Reproduce

```yaml
# w.ctrlyoke.yaml
steps:
  - type: script
    script: echo
    retruns: 0
  - prompt: p
    qqqqqqqqqqqqqq: 1
finalStep:
  prompt: f
  retryPromt: x
```

`ctrlyoke validate w.ctrlyoke.yaml` prints:

```
⚠ Unknown property 'retruns' at /steps/0/retruns. Did you mean 'returns'? …
⚠ Unknown property 'qqqqqqqqqqqqqq' at /steps/1/qqqqqqqqqqqqqq. Did you mean '_runtime'? …
⚠ Unknown property 'retryPromt' at /finalStep/retryPromt. Did you mean 'returns'? …
```

Renaming `retruns` to `returns` as suggested makes validation fail with
`/steps/0/returns: must NOT be valid`.

## Root Cause

`getValidKeysAtPointer` (`src/core/PromptFileParser.ts`, around lines 746-797)
collects every name under `properties` in the schema closure for the location.
That includes properties whose schema is `{ "not": {} }` (removed fields kept
only to reject them, such as `returns` in `$defs/scriptProperties`, reached
through a `$ref`) and `_`-prefixed runtime/template metadata.
`nearestKey` (around line 812) returns the candidate with the smallest edit
distance, with no maximum distance.

## Suggested Fix

- In `getValidKeysAtPointer`, or in a filter applied only to the suggestion
  candidates in `createUnknownPropertyWarning`, skip:
  - properties whose schema, after following `$ref`, is a removed-field
    marker (`not: {}`);
  - keys that start with `_`.

  Keep `validRootKeys` (used to skip root-level errors in `validateSchema`)
  unchanged, so the warning/removal logic is not affected.

- Give `nearestKey` a cutoff and return `undefined` beyond it, so the message
  then omits "Did you mean". For example, allow at most
  `Math.max(2, Math.floor(key.length / 3))` edits. That keeps
  `harnes → harness` and `endCondtion → endCondition` working, while
  `qqqqqqqqqqqqqq` gets no suggestion.
- Add unit tests: `retruns` on a script step gets no `returns` suggestion;
  a long random key gets no suggestion; `harnes` still suggests `harness`.
  The existing expectation in `src/test/unit/PromptFileLoader.test.ts` should
  still hold. Add a `CHANGELOG.md` **Fixed** entry.
