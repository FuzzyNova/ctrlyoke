# History regex search drops matches when a quantified literal sits beside other literals

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/core/orchestration/HistorySearchMatcher.ts` (`analyzeSequence` / `extractRequiredLiteral`)
- **Severity:** medium

## Symptom

A regex history search silently misses documents that the regex matches, whenever the
pattern contains a literal repeated with `+`, `{n}`, or `{n,m}` next to other literals.
For example, searching (regex mode) for `xa+y` does not find a document whose text is
`xaay`, and `ab{1,3}c` does not find `abbc`. No error is shown; the result list is just
incomplete.

Measured directly against the source (`npx tsx`):

| pattern    | extracted `requiredLiteral` | text     | regex matches | prefilter passes |
| ---------- | --------------------------- | -------- | ------------- | ---------------- |
| `xa+y`     | `"xay"`                     | `xaay`   | true          | **false**        |
| `ab{1,3}c` | `"abc"`                     | `abbc`   | true          | **false**        |
| `err{2}or` | `"error"`                   | `errror` | true          | **false**        |

## Steps to Reproduce

1. `createHistorySearchMatcher("xa+y", true).requiredLiteral` → `"xay"`.
2. `createHistorySearchLinePrefilter(matcher, { hasPersistedLowercaseKey: true })` on a
   serialized document whose text is `xaay` returns `false`.
3. `streamHistorySearchDocuments` (`HistorySearchShardScanner.ts:308`) `continue`s past
   that line, so the document never reaches the real regex match.

## Root Cause

`analyzeSequence` (`HistorySearchMatcher.ts`) reads each node's quantifier but only
checks `quantifier.minimum === 0`. For any other quantifier it treats a single-literal
node as if it occurred exactly once and appends it to `adjacentLiteral`, gluing it to
its neighbours. A node repeated with `+` / `{n,}` / `{n,m}` (max > 1) — or `{n}` with
n > 1 — can appear more than once, so the concatenation (`x` + `a` + `y`) is not a
substring every match contains. The prefilter then rejects lines that do match.

The existing tests (`HistorySearchMatcher.test.ts` "extracts only literals required by
every regex branch", and the generated-match check in `HistorySearchShardScanner.test.ts`)
only cover alternation and lookarounds, never a quantified literal between literals.

## Suggested Fix

In `analyzeSequence`, only extend `adjacentLiteral` when the node is unquantified (or
quantified exactly `{1}`). For any other quantifier with minimum ≥ 1: flush the
pending `adjacentLiteral`, push the node's own required literal(s) as a separate entry,
and start a fresh adjacency run afterwards (`readQuantifier` needs to report whether
the quantifier is exactly-one, e.g. return `maximum` too). The literal still
contributes (e.g. `xa+y` → required `["x","a","y"]` or better `"xa"`/`"ay"`), but never
spans a repeat. Add unit tests for `xa+y`, `ab{1,3}c`, `err{2}or`, and `(ab)+c` asserting
the prefilter passes each pattern's matching text, ideally extending the generated
query/text property check in `HistorySearchShardScanner.test.ts` with quantified cases.
