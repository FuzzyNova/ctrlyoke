# History regex prefilter joins a group's partial literal onto its neighbours and drops matching lines

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/orchestration/HistorySearchMatcher.ts`, `src/core/orchestration/HistorySearchShardScanner.ts`
- **Resolution:** fixed in this commit

## Symptom

Regex history searches silently miss results. For example, searching `error (code|mode)` does not
find `error code` in any shard read through the streaming path (`streamHistorySearchDocuments`,
used for shards not held in `HistorySearchDocumentCache`). Cached shards skip the prefilter, so
the same query finds a match in recent runs but misses it in older ones.

`requiredLiteral` is documented (around line 28) as "A conservative literal required in every
possible match", and `createHistorySearchLinePrefilter` skips every JSONL line that doesn't
contain it. The extracted literal is not actually required.

## Steps to Reproduce

Use the real `createHistorySearchMatcher` and `createHistorySearchLinePrefilter`
(`hasPersistedLowercaseKey: true`):

| pattern              | extracted literal | text         | regex matches | prefilter passes |
| -------------------- | ----------------- | ------------ | ------------- | ---------------- |
| `error (code\|mode)` | `"error ode"`     | `error code` | true          | false            |
| `(error.)code`       | `"errorcode"`     | `errorXcode` | true          | false            |
| `x(ba\|ca)`          | `"xa"`            | `xba`        | true          | false            |
| `(a.)c`              | `"ac"`            | `abc`        | true          | false            |
| `(?=abc)a`           | `"abca"`          | `abc`        | true          | false            |

## Root Cause

In `analyzeSequence` (around lines 436-438), when a node with an exactly-once quantifier yields a
single required literal, that literal is appended to the adjacent literal run as if it were the
node's entire content. That is only true when the node is exactly that literal:

- For an alternation, `combineAlternatives` returns the longest common substring of the
  branches, which can sit in the middle or at the end of each branch (`code|mode` → `ode`).
- A group like `(a.)` reports `["a"]` although it also consumes the next character.
- A lookahead consumes nothing, so its literal overlaps the following text instead of preceding it.

The fixed `history-regex-prefilter-joins-quantified-literals` bug covered only quantifiers.

## Suggested Fix

Only extend `adjacentLiteral` from a node whose analysis says it matches exactly that literal
(for example a new `isExactLiteral` flag, set for plain literals and for non-lookaround groups
whose single alternative is itself an exact literal sequence). Otherwise flush the adjacent run
and push the node's literal as its own required entry. Lookarounds must never join the adjacent
run. Add the patterns above to the generated prefilter property check in
`HistorySearchShardScanner.test.ts` and to the matcher unit tests.
