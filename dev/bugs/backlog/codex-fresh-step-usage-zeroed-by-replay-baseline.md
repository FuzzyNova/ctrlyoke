# Codex step usage is zeroed for a fresh session whose turn made several model calls

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/harness/codex/CodexLogParser.ts`
- **Severity:** high

## Symptom

Since `850801a4` ("fix: correct Claude and Codex step usage"), a Codex step's reported token
usage, and so its cost estimate, is 0 or far too low whenever its first `token_count` event
covers more than one model request. That is the normal case: any turn that calls a tool makes
several requests before Codex writes a `token_count`.

HEAD's `npm test` is red because of this. Three `CodexLogParser` tests fail:

- `headless golden output > maps the real stdout/log pair to equivalent universal semantics`:
  usage is `{input 0, cached 0, output 0}`; expected `{54917, 48128, 518}`.
- `extractResponse > should use last token total for context window usage`: `inputTokens` is 0;
  expected 5191984.
- `extractResponse > should fall back to the Codex 5.6 context window when token_count omits it`:
  `totalTokens` is 0; expected 4200.

Because of that red gate, steps 14 and 15 of the `lots-of-bug-fixes` run left their finished fixes
uncommitted (see "Pending work" below).

## Steps to Reproduce

1. `npm run test:extension` (or look at any `npm test` log since 21:49Z on 2026-09-28 under
   `.ctrlyoke/logs/test-runs/`).
2. Or run `CodexLogParser.extractResponse` on `src/test/fixtures/codex/headless-golden.session.jsonl`.
   This is a real fresh `codex exec` rollout: `session_meta`, 7 `response_item` events (message,
   two tool calls, reasoning, final message), then one `token_count` with
   `total_token_usage.input_tokens 54917` and `last_token_usage.total_tokens 14156`.
3. Observed usage: all zeros.

## Root Cause

The `token_count` branch (around lines 283-312) records the **first** `token_count` in the event
window as a "replayed prior total" baseline whenever `cumulativeTotal > lastTurnTotal` (or
`last_token_usage` is absent). The final usage (around lines 617-645) then subtracts that baseline.

The heuristic assumes a fresh session's first cumulative total equals its last-request total. That
only holds when the first `token_count` covers exactly one request. In real rollouts, cumulative is
larger than last whenever the turn made several requests. In the golden fixture it is 55,435
against 14,156. The fresh session's only `token_count` becomes the baseline and the step's usage
is subtracted down to 0. When a step has several `token_count` events, everything up to the first
one is dropped.

The fixtures added in `850801a4` (`fresh-session-usage.jsonl`, `resumed-session-usage.jsonl`) are
synthetic, and the fresh one has `total == last`, so they never covered the real shape.

## Suggested Fix

Detect the replay structurally, not by comparing magnitudes. In a resumed `codex exec` rollout,
the replayed `token_count` appears in the step's window **before any of this step's model output**
(assistant `response_item` messages, reasoning, function/custom tool calls). A fresh step's first
`token_count` always comes after model output. Only treat a `token_count` as the baseline when no
model-output event has been seen yet in the window (an explicit "resumed" flag from the provider
would work too). Otherwise the baseline is zero.

Keep the resumed-session fixture test passing, and make it realistic: put the replay line before
the step's `response_item` events. Keep the three existing tests above unchanged; they are the
regression tests. Add a fresh-session fixture with two `token_count` events where the first has
`total > last`, and assert that the full cumulative total is reported.

## Pending work riding on this fix

Steps 14 and 15 left their completed changes uncommitted in the working tree because this bug
kept the gate red:

- history search: `HistorySearchMatcher.ts`, `HistorySearchMatcher.test.ts`,
  `HistorySearchShardScanner.test.ts` (bugs `history-regex-prefilter-joins-group-literal-to-neighbors`,
  `history-substring-match-index-wrong-after-lowercase-length-change`);
- redaction and retry: `PreviewRedactor.ts`, `PreviewRedactor.test.ts`, `RetryUtils.ts`,
  `retryUtils.test.ts`, `CliProviderUtils.ts`, `ModelRegistry.ts` (bugs
  `preview-redaction-hides-key-when-value-repeats-key-text`,
  `retry-with-backoff-retries-errors-callers-mean-as-permanent`).
