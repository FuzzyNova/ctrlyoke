# Token Total Cache Normalization Plan

> **Status:** Not implemented. Root-caused and grounded in code + provider docs; no design
> decision is blocking, but the fix touches durable data consumed by two "Implemented" plans
> ([`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`](../implemented/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md),
> [`HARNESS_USAGE_TRACKING_PLAN.md`](../implemented/HARNESS_USAGE_TRACKING_PLAN.md)), so it
> is staged here rather than patched ad hoc.
> **Created:** August 31, 2026, from a user report of implausible-looking token totals in
> [`StatsUsageSection.tsx`](../../src/ui/webview-react/components/settings/stats/StatsUsageSection.tsx)
> and the step-metadata tooltip.
> **Revised:** August 31, 2026 — real captures for Antigravity, Qwen, and OpenCode added.
> Their cache relationships are now empirically confirmed (not just parser-comment-inferred),
> which changes Phase 1's scope: two harnesses need the total-netting fix, not one, and two
> others turn out to already be correct with no fix needed.
> **Revised again:** August 31, 2026 — live-probed Copilot CLI directly (`copilot -p ...` with
> `COPILOT_OTEL_ENABLED`/`COPILOT_OTEL_FILE_EXPORTER_PATH` set, model `gpt-5.6-luna`, CLI
> `1.0.82`). Copilot **does** now expose a cache signal — the "not fixable from current data"
> framing below is stale. It needs no total-netting fix (confirmed `DISJOINT`, same shape as
> Claude/Antigravity/OpenCode), but does need new parser wiring, and the probe surfaced a live
> cost-accuracy bug as a side effect. See the rewritten Copilot rows/section and
> [Open questions](#open-questions).
> **Revised again:** August 31, 2026 — live-probed Qwen CLI directly (`qwen -p ...`,
> CLI `0.22.3`, models `qwen3.5-plus`/`qwen3.8-max` via the DashScope OpenAI-compatible
> endpoint). Qwen's `reasoningRelationship` is now confirmed `INCLUDED_IN_OUTPUT`, resolving
> that part of the open question below (Antigravity/OpenCode remain unverified). The probe also
> surfaced a live double-counting bug in `QwenLogParser.ts`, independent of and more directly
> visible than the cache-netting issue: it adds `thoughtsTokenCount` on top of
> `candidatesTokenCount` even though the former is already a subset of the latter, inflating
> every Qwen attempt's displayed output/total whenever extended thinking occurs. See the new
> [Qwen reasoning deep dive](#qwen-reasoning-deep-dive-thinking-tokens-confirmed-as-a-subset-of-output)
> section below.

## The report

Real "Copy Metadata" captures from ctrlyoke runs:

```text
Claude:
Current context window: 231k/1M (23%)
Attempt total: 106.7k tokens
Tokens: 242 in / 106.4k out / 106.7k total | 21.4M cached | 907.1k cache-created
Compactions: 0
≈$7.61 at API list prices.

Codex (with 1 compaction):
Current context window: 61.1k/258.4k (24%)
Attempt total: 8.5M tokens
Tokens: 8.5M in / 22.2k out / 8.5M total | 8.1M cached
Compactions: 1
≈$0.26 at API list prices.

Copilot:
Current context window: 34k/200k (17%)
Attempt total: 161.7k tokens
Tokens: 161.2k in / 500 out / 161.7k total
Compactions: 0
≈$0.03 at API list prices.
[Original capture, CLI version unrecorded. Superseded by a live CLI 1.0.82 probe below —
Copilot does carry a cache signal ctrlyoke isn't reading yet, so this total is very likely
already correct in shape (DISJOINT, see below) but its ≈$ figure is probably overpriced.]

Antigravity:
Current context window: 29.7k/1M (3%)
Attempt total: 3.9k tokens
Tokens: 3.8k in / 11 out / 3.9k total | 16.3k cached | 0 cache-created

Qwen:
Current context window: 42k/1M (4%)
Attempt total: 125.2k tokens
Tokens: 124.7k in / 464 out / 125.2k total | 82.7k cached
Compactions: 0

OpenCode:
Current context window: 30.7k/200k (15%)
Attempt total: 32.1k tokens
Tokens: 30.5k in / 1.6k out / 32.1k total | 138.7k cached | 0 cache-created
Compactions: 0
≈$0.00 reported by the harness; not incremental subscription spend.
```

The user's mental model was:
`current-context-window + (compactions × context-window-size) == tokens-in + tokens-out`,
with cached tokens excluded because they're cache *hits*, not new context. That formula does
not hold for any of the six examples, and the "Attempt total" numbers look wildly
inconsistent across harnesses (100k-scale for Claude/Antigravity/OpenCode, multi-million for
Codex, low-hundred-thousand-but-still-inflated for Qwen) for runs of plausibly similar shape.
Both observations are real; neither is a bug in the arithmetic. Two separate, compounding
effects are responsible, and this plan addresses the second one, which is fixable.

## Root cause 1 (not fixable, needs better copy): two signals that were never meant to add up

`contextWindowUsed` and `total`/`prompt`+`completion` measure different things by design —
this is documented in `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`'s Problem section and
`TokenStats`'s field comments, but the tooltip text doesn't say so, so the natural reading is
that they should reconcile.

- **`contextWindowUsed`** is a snapshot of the **last turn only** — Claude:
  `ClaudeLogParser.ts:429-434` builds it from `lastAssistantUsage`, explicitly commented
  "not cumulative across turns like the totals above"; Codex:
  `CodexLogParser.ts:267-275` builds it from `info.last_token_usage`; Qwen:
  `QwenLogParser.ts:352-356` from the last `usageMetadata`.
- **`total`/`prompt`+`completion`** is a **sum across every turn** of the attempt (every
  tool-call round-trip), per `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`'s collection strategy.

An agentic attempt with many tool-call turns can easily have a last-turn context window far
smaller than the sum of every turn's contribution (a long attempt that never compacted can
still have consumed much more than its final window shows, simply because turns 1–40 existed
too). The user's formula assumes context window is a running total; it's a point-in-time
reading. This is real and worth calling out but is not something to "fix" — it's an accurate
distinction. The actionable item is **Phase 0** below: make the tooltip say so explicitly
instead of implying a reconciliation that was never intended.

## Root cause 2 (fixable): "attempt total" means a different thing per harness

This is the part worth fixing. Confirmed against the ctrlyoke parsers, each provider's own
documented token semantics (Anthropic, Gemini/Qwen, OpenAI Codex — see References), and, for
Antigravity/Qwen/OpenCode/Copilot, real captures from actual ctrlyoke runs (Copilot's captured
live in this session — see below):

| Harness | `input_tokens` semantics | Verified via |
| --- | --- | --- |
| `claude-cli` | **Excludes** cached tokens — "the number of input tokens which were not read from or used to create a cache (tokens after the last cache breakpoint)" | [Anthropic prompt-caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); `ClaudeLogParser.ts:349-354` sums `usage.input_tokens` per turn |
| `codex-cli` | **Includes** cached tokens — "all content sent to the API," with `cached_input_tokens` reported as a breakdown subset, not a deduction | Codex rollout format research (openai/codex PR #1583 discussion); `CodexLogParser.ts:256-266` takes `total_token_usage.input_tokens` (Codex's own already-cumulative session counter) as-is |
| `qwen-cli` | **Includes** cached tokens (`SUBSET`) — confirmed, not just inferred | Three independent sources agree: (1) the parser's own doc comment, `QwenLogParser.ts:61`: `` `promptTokenCount` - Input tokens (includes cached)``; (2) Google's own Gemini API docs — `cachedContentTokenCount` is a subset of `promptTokenCount`, non-cached = `promptTokenCount − cachedContentTokenCount` ([Counting tokens, Gemini API docs](https://ai.google.dev/api/tokens)); (3) the real capture above is numerically consistent (`82.7k cached ≤ 124.7k in`) |
| `copilot-cli` | **Excludes** cached tokens (`DISJOINT`) — confirmed live on CLI `1.0.82`, reversing the earlier "no cache field" finding | See [Copilot deep dive](#copilot-deep-dive-cache-signal-confirmed-on-cli-1082) below |
| `antigravity-cli` | **Excludes** cached tokens (`DISJOINT`) — confirmed | The real capture above proves it mathematically: `16.3k cached > 3.8k in`, which is only possible if the two fields don't overlap. Antigravity's `result.usage` reports `input_tokens`/`cache_read_tokens`/`output_tokens` as separate fields (same shape as Claude), not a breakdown of one field into another |
| `opencode-cli` | **Excludes** cached tokens (`DISJOINT`) — confirmed | The real capture above proves it the same way: `138.7k cached > 30.5k in`. OpenCode persists `tokens.input`, `tokens.cache.read`, and `tokens.cache.write` as separate JSON fields per step, and the project's own cache-read/context-overflow handling treats `cache.read` as distinct from current prompt/context tokens, not folded into `tokens.input` |

Antigravity and OpenCode were previously `UNKNOWN` in `HARNESS_TOKEN_SEMANTICS`
(`ModelPricing.ts:94-97, 90-93`) pending a live run, per the standing rule in
`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md` Phase 4 that a parser comment alone isn't enough. The
real captures above satisfy that bar for **cache relationship** specifically. Their
**reasoning relationship** is a separate dimension (`calculateTokenCost`
in `ModelPricing.ts:151-159` requires *both* to be non-`UNKNOWN` before it will price an
attempt from the table); none of the three new captures shown here carried a reasoning
figure, so this round of evidence does not by itself unblock table pricing for Antigravity
or OpenCode — see [Open questions](#open-questions). Qwen's reasoning relationship *is* now
resolved, but by a separate, later probe — see the
[Qwen reasoning deep dive](#qwen-reasoning-deep-dive-thinking-tokens-confirmed-as-a-subset-of-output)
below. Copilot, uniquely, was **already** marked `DISJOINT` in
`HARNESS_TOKEN_SEMANTICS` (`ModelPricing.ts:98-101`) before any of this — apparently a
forward-looking default rather than evidence-backed, since the code comments elsewhere
insisted no cache field existed. The live probe below confirms that existing classification
was accidentally correct.

## Copilot deep dive: cache signal confirmed on CLI 1.0.82

The `1.0.78` research behind the original "no cache field exists at all" claim is stale. A
live probe against the currently-installed CLI (`copilot --version` → `1.0.82`) found a real
cache signal in **two independent places**, neither read by `CopilotLogParser` today:

**1. OTel `chat <model>` spans** (`COPILOT_OTEL_FILE_EXPORTER_PATH`, `COPILOT_OTEL_ENABLED=true`,
model `gpt-5.6-luna`, two turns in one resumed session):

- Turn 1 (`copilot -p "Say the word 'hello'..." --model gpt-5.6-luna`): span attributes
  `gen_ai.usage.input_tokens: 21836`, `gen_ai.usage.cache_write.input_tokens: 21833` (first
  turn — nothing to read from cache yet, almost the whole prompt gets written to it).
- Turn 2 (`copilot -p "Now say 'world'..." --resume=<same session>`): span attributes
  `gen_ai.usage.input_tokens: 21910`, `gen_ai.usage.cache_read.input_tokens: 21833`,
  `gen_ai.usage.cache_write.input_tokens: 74`. The CLI's own terminal summary for this turn
  read `Tokens ↑ 43.7k (21.8k cached, 21.9k written) • ↓ 21 (9 reasoning)` — i.e. the CLI's
  own UI already adds `cache_read` (21.8k) + `input_tokens` (21.9k, confusingly labeled
  "written" in the UI, not to be confused with the `cache_write` attribute) to get the
  displayed total. `21910 + 21833 = 43743 ≈ 43.7k` matches exactly, which proves
  mathematically that `gen_ai.usage.input_tokens` does **not** include `cache_read` —
  the same `DISJOINT` shape as Claude/Antigravity/OpenCode, not the `SUBSET` shape of
  Codex/Qwen.
- Two new attribute names exist beyond the four already read via the
  `COPILOT_OTEL_*_ATTRIBUTE` constants: `gen_ai.usage.cache_read.input_tokens` and
  `gen_ai.usage.cache_write.input_tokens`. (The `gen_ai.client.token.usage` *metric*, by
  contrast, only carries `gen_ai.token.type` values `"input"`/`"output"` — no cache
  dimension. The cache breakdown lives on the span attributes only.)
- The same span also carried `gen_ai.usage.reasoning.output_tokens: 9` on turn 2, a
  previously-unread reasoning-token signal — see the reasoning-relationship note below.

**2. Headless JSON stdout (`--output-format json`), no OTel required at all**: a third
`-p` call in the same resumed session, `--output-format json`, surfaced a `model.model_call_success`
event whose `data.copilotUsage.token_details` (also duplicated at
`data.responseChunk.copilot_usage.token_details`) is an explicit, non-overlapping partition:
`[{"token_type":"input","token_count":3},{"token_type":"cache_read","token_count":21907},
{"token_type":"cache_write","token_count":73},{"token_type":"output","token_count":16}]` —
these four numbers sum exactly to the turn's `prompt_tokens`/`total_tokens` fields, which is
an even more direct proof of `DISJOINT` than the OTel arithmetic above. The same event also
carries `data.responseUsage.prompt_tokens_details.{cached_tokens,cache_creation_tokens}`
(OpenAI-shaped, same values) and a `session.usage_checkpoint` event later in the stream
duplicates the same figures again under
`data.promptCacheBreakState[].models.<modelId>.{prompt_tokens,cache_read,cache_write}`. None
of `model.model_call_success`, `responseUsage`, `copilotUsage`, or `session.usage_checkpoint`
are event/field names `CopilotLogParser.extractResponse()` or
`extractStructuredEventsFromEvent()` currently handle — this fully contradicts
`augmentParsedOutput()`'s docstring claim that "Copilot's `--output-format json` stdout
contains output tokens per turn but no input tokens," which was accurate for whatever CLI
version that comment was written against but is stale for `1.0.82`. Note these
`"ephemeral":true`-flagged events are still present in the literal stdout text — `ephemeral`
appears to be a Copilot-internal "don't render in the TUI" marker, not "don't emit to JSONL";
they were captured directly from raw process stdout the same way
`CopilotCliProvider.parseHeadlessStdout()` receives it.

**Interactive mode still needs OTel — the JSON stream doesn't exist there.**
`buildInteractiveArgs()` launches with `-i <prompt>`, never `--output-format json`, so
Copilot's stdout in interactive/TUI mode is human-rendered text with no `model.model_call_success`
event to read at all. The two-signal split above isn't a choice; it's forced by mode:

- **Headless** (`-p`, ctrlyoke's default execution mode): the JSON stdout event source is
  sufficient on its own — no OTel/env-var setup required, matching how ctrlyoke already reads
  headless stdout for everything else (`headlessSource = "stdout"`).
- **Interactive**: only OTel (`gen_ai.usage.cache_read.input_tokens` /
  `cache_write.input_tokens` on the `chat <model>` span) can supply this, exactly as
  `CopilotLogParser.ts`'s existing "OTel is a third artifact" architecture note already
  assumes for context-window tracking. `CopilotCliProvider.getInteractiveSpawnEnv()` already
  threads `buildOtelSpawnEnv()` into interactive launches for that reason, so the plumbing
  ctrlyoke needs already exists — it just isn't reading the two new attributes yet.
  **Caveat:** the OTel captures above were both taken via `-p` headless runs with
  `COPILOT_OTEL_ENABLED` forced on (scripting a real attached TUI session wasn't practical for
  this probe). OTel span emission is documented as invocation-mode-agnostic (the same "chat
  \<model\>" span wraps every model call regardless of `-p` vs `-i`), so this is expected to
  hold for interactive mode too, but that specific path was not independently re-verified
  against a live TUI session — flagged as residual risk in
  [Open questions](#open-questions) rather than assumed.

**Reasoning tokens are also newly visible, and the existing classification looks wrong.**
`HARNESS_TOKEN_SEMANTICS[COPILOT_CLI].reasoningRelationship` is currently `UNREPORTED`
(`ModelPricing.ts:100`) — but the turn-2 capture explicitly reports
`gen_ai.usage.reasoning.output_tokens: 9` (OTel) and `completion_tokens_details.reasoning_tokens: 9`
out of `completion_tokens: 16` (JSON stdout, OpenAI-shaped schema where `completion_tokens`
already totals output including the reasoning subset). That's the same shape already
classified `INCLUDED_IN_OUTPUT` for Codex, not `UNREPORTED`. Functionally this doesn't change
`calculateTokenCost`'s output today — both values zero out `separatelyPricedReasoning` — but
the label is factually wrong and worth correcting for the next reader (see Phase 3 below).

Because Claude nets cache out of `input_tokens` at the API level and Codex/Qwen don't,
summing `input_tokens` across every turn of a long tool-calling attempt produces numbers with
different meanings:

- **Claude's cumulative "in"** ≈ genuinely new tokens the model had to newly process across
  the whole attempt (small — 242, 24 in the examples).
- **Codex's/Qwen's cumulative "in"** ≈ sum of the *entire resent prompt* on every single
  turn, repeated in full each time (huge — 8.5M), because their raw `input_tokens` never
  excludes what was cache-hit that turn.

This is exactly what the user suspected ("the cached token value interferes with the in
tokens in codex's case") and it's confirmed correct. It also explains why Codex's `total`
(taken directly from the provider's own `total_token_usage.total_tokens`,
`CodexLogParser.ts:263-264`) is dominated by the same inflation — `total` is provider-total,
and the provider's own total already double/triple/N-counts the same cached context on every
turn it was resent.

**The netted, Claude-comparable number is already sitting in the data**: for Codex,
`8.5M in − 8.1M cached ≈ 0.4M` "genuinely new" input, which is the same order of magnitude as
Claude's 106.7k total for a comparably-sized agentic run — not 80× larger. The Qwen capture
shows the same direction of error at smaller scale: `124.7k in − 82.7k cached ≈ 42k`
genuinely-new input, versus the displayed (inflated) total of 125.2k — roughly 3× smaller
once netted, and notably close to that same attempt's own `42k` context-window reading,
which is exactly the kind of internal consistency check that's absent from the raw number
today.

**Antigravity, OpenCode, and Copilot need no total-netting fix.** All three are `DISJOINT`,
the same shape as Claude: their `in` figures already exclude cache, so their displayed totals
are already genuinely-new-tokens-only and already comparable to Claude's. (Antigravity: `3.8k
in / 11 out / 3.9k total`, cache tracked separately at `16.3k`; OpenCode: `30.5k in / 1.6k out
/ 32.1k total`, cache tracked separately at `138.7k`; Copilot's live probe: turn 2's
`21910 in + 16 out` total already excludes the `21833` cache-read tokens it also carries.) The
inflation problem is specific to the two harnesses whose provider API folds cache into the
input count: Codex and Qwen. Copilot differs from Antigravity/OpenCode in one way, though:
its total is already correct, but its cache figures aren't captured or displayed *at all*
today (no breakdown line, and a cost-estimate bug — see the Copilot deep dive above and
Phase 3 below), where Antigravity/OpenCode's parsers already surface theirs correctly.

## Qwen reasoning deep dive: thinking tokens confirmed as a subset of output

Qwen's `reasoningRelationship` (`HARNESS_TOKEN_SEMANTICS[QWEN_CLI]`, `ModelPricing.ts:87-88`)
was `UNKNOWN`, gating table-priced cost estimates for every Qwen attempt regardless of the
cache-relationship promotion in Phase 1 (`calculateTokenCost` requires *both* dimensions
non-`UNKNOWN`). Three live `qwen -p ... -o json` runs (CLI `0.22.3`, models `qwen3.5-plus` and
`qwen3.8-max`, real DashScope OpenAI-compatible-endpoint traffic — see `.qwen/settings.json`'s
`baseUrl: https://dashscope-us.aliyuncs.com/compatible-mode/v1`) now resolve it: **thinking
tokens are `INCLUDED_IN_OUTPUT`, the same classification as Codex, not a `DISJOINT`
provider-billed-separately pool.**

**Run 1** (`qwen3.5-plus`, a plain step-by-step word problem) — raw `usageMetadata` from the
session log (`~/.qwen/projects/c--dev-ctrlyoke/chats/6e6c76d9-a48d-4020-8175-650ea9cdab34.jsonl`):
`promptTokenCount: 29051, candidatesTokenCount: 199, thoughtsTokenCount: 31, totalTokenCount:
29250`. `29051 + 199 = 29250` exactly — `totalTokenCount` already equals `prompt + candidates`
with no room left to add `thoughts` again.

**Run 2** (`qwen3.8-max`, same style of prompt) reproduced the identical shape at a different
model and magnitude: `promptTokenCount: 29069, candidatesTokenCount: 203, thoughtsTokenCount:
144, totalTokenCount: 29272`. Again `29069 + 203 = 29272` exactly.

Both runs are consistent with two different hypotheses, though: either (a) `thoughtsTokenCount`
is genuinely a subset already counted inside `candidatesTokenCount`, or (b) it's a disjoint pool
that `totalTokenCount` simply — buggily — forgets to add. Word-count sanity-checking wasn't
conclusive (both runs had thinking text short enough, relative to the visible answer, that
either hypothesis fit the numbers).

**Run 3 was designed to be decisive**: a prompt demanding "at least 15 sentences" of visible
internal reasoning followed by a **one-token final answer** ("just the raw number, no words").
If `candidatesTokenCount` only ever counted the *visible* answer, it should have stayed in the
single digits regardless of how much thinking happened. It didn't. Raw log
(`~/.qwen/projects/c--dev-ctrlyoke/chats/54f71575-4441-4c88-9b31-8694a9eae04e.jsonl`):

```text
message.parts[0]: thought: true,  text.length: 1055  ("I need to calculate 47 × 89 ...")
message.parts[1]: thought: false, text.length: 4     ("4183")
usageMetadata: { promptTokenCount: 29082, candidatesTokenCount: 614,
                 thoughtsTokenCount: 605, totalTokenCount: 29696 }
```

`candidatesTokenCount` (614) tracks the *thinking* text's length (605), not the 4-character
visible answer — `614 − 605 = 9`, matching a few tokens for `"4183"` plus small formatting
overhead. If thoughts were disjoint from candidates, `candidatesTokenCount` would have stayed
near single digits (just `"4183"`) no matter how long the reasoning ran; instead it scaled
directly with the thinking length. This rules out hypothesis (b): `thoughtsTokenCount` is a
true subset of `candidatesTokenCount`, and `totalTokenCount = promptTokenCount +
candidatesTokenCount` is already complete and correct — matching the OpenAI-compatible
`completion_tokens_details.reasoning_tokens ⊂ completion_tokens` convention (DashScope's
`compatible-mode` endpoint, not Google's native Gemini API, which is what Qwen CLI's
Gemini-shaped `usageMetadata` field names would otherwise suggest).

**This confirms a real double-counting bug, not just an unresolved classification.**
`QwenLogParser.extractResponse()` (`QwenLogParser.ts:267-271`) currently computes:

```typescript
totalOutputTokens +=
  (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
```

Since `thoughtsTokenCount` is already inside `candidatesTokenCount`, this adds it a second
time. For Run 3, the parser would report `outputTokens: 614 + 605 = 1219` — nearly double the
true value (614) — inflating both the raw "out" figure and `TokenStats.total` (Qwen's `total`
is parser-computed as `totalInputTokens + totalOutputTokens`, `QwenLogParser.ts:362`, not a
provider-reported field) for every Qwen attempt that does any extended thinking. This bug is
independent of, and visible before, the Phase 1 cache-netting fix — it inflates the headline
number directly, the same way the Copilot cache-pricing bug did. Should be split into its own
fix alongside the `reasoningRelationship` promotion (both touch the same few lines) — see
Phase 1's Qwen bullets and Touch points below.

## Why this isn't a same-session hot-fix

The naive fix — subtract `cached` from `prompt` wherever it's displayed — would corrupt cost
math if applied carelessly. `calculateAttemptCost` (`ModelPricing.ts`) already does this
subtraction **internally**, once, using the harness's `cacheInputRelationship`
(`SUBSET`/`DISJOINT`/`UNKNOWN`) from `HARNESS_TOKEN_SEMANTICS`, and it needs the **raw**
`prompt`/`cached` values as separate inputs to do it
(`WorkflowExecutor.resolveTokenCounts` at `WorkflowExecutor.ts:1758-1763` passes `u.inputTokens`
and `u.cachedInputTokens` straight through). Overwriting `TokenStats.prompt` itself with a
netted value would double-subtract there.

The number that actually needs to change is the **headline total** — `TokenStats.total`,
which today is "provider-reported total when present, else `prompt + completion`"
(`ClaudeLogParser.ts:454-455`, `CodexLogParser.ts:263-264`) — and everything downstream of it:

- `WorkflowTokenTotalsReducer` sums `TokenStats.total` per attempt into `WorkflowTokenTotals`
  (`byHarness`, `byLocalDay`) — the workflow list, run list, and run-summary totals in
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`.
- `HARNESS_USAGE_TRACKING_PLAN.md`'s `ObservedHarnessUsageStore` and
  `StatsUsageSection.tsx`'s per-harness `UsageCard`s consume those same `byLocalDay`
  subtotals as their **only** input (`byHarness` is documented there as "the invariant
  cross-check" — never re-derived).
- The step tooltip (`buildAttemptTokenTooltipLines` in `TokenFormatting.ts`) and
  `CliTerminalFormatter.renderStats` both render `TokenStats.total` as "Attempt total".

So a correct fix normalizes `total` once, at the same place cost is already computed
(`resolveTokenCounts`, which already has `parsedOutput.metadata.harness` and already imports
`HARNESS_TOKEN_SEMANTICS`-driven cost math), and lets every downstream consumer — reducer,
persistence, workflow/run lists, observed-usage rollups, tooltip, CLI — inherit the corrected
number for free, exactly the way `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md` designed the pipeline to
work ("normalize at the parser/lossless-boundary, aggregate in the history layer, render in
React"). That is a change to a value multiple already-shipped, already-tested features
depend on — worth a reviewed, staged change, not an in-session patch.

## Proposed fix

### Phase 0 — tooltip/copy clarification (small, no data-model change)

- In `buildAttemptTokenTooltipLines` (`TokenFormatting.ts`) and the mirrored
  `CliTerminalFormatter.renderStats` text, stop implying the context bar and the attempt
  total should reconcile. Add one line making the distinction explicit, e.g. "Current context
  window is the last turn only; attempt total sums every turn." This is copy-only and
  unblocks confusion immediately regardless of Phase 1's timeline.
- Clarify the breakdown line's cache semantics per harness so `X in | Y cached` doesn't read
  identically for Claude (additive — cached is *on top of* in) and Codex (overlapping —
  cached is *inside* in). Something like `8.5M in (8.1M cached)` for subset harnesses vs.
  `242 in | 21.4M cached` (unchanged) for disjoint ones communicates the difference without
  needing the Phase 1 data change.

### Phase 1 — normalize the headline `total` for confirmed cache-subset harnesses

- First, promote `HARNESS_TOKEN_SEMANTICS` (`ModelPricing.ts:75-102`) `cacheInputRelationship`
  from `UNKNOWN` to the values confirmed above: `QWEN_CLI → SUBSET`,
  `ANTIGRAVITY_CLI → DISJOINT`, `OPENCODE_CLI → DISJOINT`. This is a one-line-per-harness,
  low-risk change on its own (it only ever *enables* cache-aware cost math where it was
  previously suppressed) and can land ahead of the rest of Phase 1. Leave
  `reasoningRelationship` as `UNKNOWN` for Antigravity and OpenCode — unrelated evidence,
  still unverified (see Phase 2). **Qwen is different**: promote
  `HARNESS_TOKEN_SEMANTICS[QWEN_CLI].reasoningRelationship` from `UNKNOWN` to
  `INCLUDED_IN_OUTPUT` in the same change — confirmed by live probe, see the
  [Qwen reasoning deep dive](#qwen-reasoning-deep-dive-thinking-tokens-confirmed-as-a-subset-of-output).
  This is what actually unblocks table-priced cost estimates for Qwen (both dimensions must be
  non-`UNKNOWN`), not the cache promotion alone.
- **Fix the Qwen thinking-token double-count while touching this code.** In
  `QwenLogParser.extractResponse()` (`QwenLogParser.ts:267-271`), change
  `totalOutputTokens += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)` to drop
  the `+ (u.thoughtsTokenCount || 0)` — `thoughtsTokenCount` is already a subset of
  `candidatesTokenCount` (proven in the deep dive above), so adding it again currently inflates
  `outputTokens`/`TokenStats.total` for every Qwen attempt with extended thinking. This is a
  correctness bug independent of the cache-netting work below and worth its own test fixture
  (a captured turn with a non-trivial `thoughtsTokenCount` asserting `outputTokens ===
  candidatesTokenCount`, not `candidatesTokenCount + thoughtsTokenCount`).
- Add a `total` computation at the `resolveTokenCounts` boundary
  (`WorkflowExecutor.ts:1740-1782`) that, when
  `HARNESS_TOKEN_SEMANTICS[harness].cacheInputRelationship === SUBSET`, computes
  `total = Math.max(prompt - (cached ?? 0), 0) + completion` instead of forwarding the raw
  provider total. Leave `DISJOINT` and `UNKNOWN` harnesses exactly as-is — after the
  promotion above, this now touches **two** harnesses, Codex and Qwen; Claude, Antigravity,
  OpenCode, and Copilot are all `DISJOINT` and already correct (Copilot confirmed live —
  see the Copilot deep dive above; it needs Phase 3's parser wiring for its cache/cost
  display, not a netting fix here).
- `TokenStats.prompt`/`cached`/`cacheCreated` stay raw and untouched, so `calculateAttemptCost`
  keeps working unmodified and the detailed breakdown line can still show true provider
  figures.
- Downgrade `totalConfidence` for a normalized-not-provider total appropriately (it's now a
  ctrlyoke computation over provider fields, not a value the provider asserted directly) —
  reuse `TOKEN_TOTAL_CONFIDENCE.ACCUMULATED` rather than `PROVIDER` once normalized, so
  downstream partial-coverage logic keeps its existing meaning.
- `HARNESS_TOKEN_SEMANTICS` currently lives in `ModelPricing.ts`, framed purely as a
  cost-calculation input. Once the token pipeline (not just cost) depends on it, consider
  whether it belongs in `DashboardConstants.ts`/a shared token-semantics module instead —
  otherwise the lossless token-normalization boundary ends up importing a "cost" module for a
  non-cost decision, which is the kind of structural relationship the project's coding
  principles ask to make explicit rather than incidental.
- Update every place that currently says "Attempt total" / renders `TokenStats.total` to also
  make clear (via tooltip, not headline, per the existing cost-divergence precedent in
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`) that a `SUBSET` harness's total has cache netted out,
  the same way the existing cost tooltip already explains harness-vs-table divergence.

### Phase 2 — verify OpenCode's and Antigravity's reasoning relationship

Their cache relationship is now confirmed (this revision), but `reasoningRelationship` stays
`UNKNOWN` for both, which independently blocks table-priced cost estimates
(`calculateTokenCost` requires both dimensions non-`UNKNOWN`, `ModelPricing.ts:151-159`).
Antigravity separately reports `thinking_tokens`
(`AntigravityLogParser.ts` per the audit table) and OpenCode separately reports
`tokens.reasoning` — a live run showing whether either figure is already folded into the
harness's own output-token count (`INCLUDED_IN_OUTPUT`) or billed apart (`DISJOINT`) is the
remaining gate before their cost estimates can turn on. This does not affect the token-total
display fix in Phase 1, only the `≈$` cost line — OpenCode already sidesteps this via its own
`step_finish.part.cost` (Tier 1), so this phase mainly unblocks Antigravity, which has no
self-reported cost and currently shows tokens with no dollar estimate at all (see the
Antigravity capture above — no `≈$` line, unlike Codex/Claude/OpenCode).

### Phase 3 — wire up Copilot's newly confirmed cache/reasoning signal (parser only, no total-netting)

Per the [Copilot deep dive](#copilot-deep-dive-cache-signal-confirmed-on-cli-1082) above,
Copilot needs no Phase 1 netting (`DISJOINT`, same as Claude/Antigravity/OpenCode) and no
`HARNESS_TOKEN_SEMANTICS` promotion for `cacheInputRelationship` (`ModelPricing.ts:98-101`
already says `DISJOINT`, apparently by lucky default rather than evidence — this phase makes
that entry evidence-backed instead of accidentally correct). What's actually missing is parser
wiring to populate `TokenStats.cached`/`cacheCreated`, which today stay `undefined` for every
Copilot attempt:

- **Headless** (`-p`, no OTel needed): have `CopilotLogParser.extractResponse()` and
  `extractStructuredEventsFromEvent()` read the `model.model_call_success` event's
  `data.copilotUsage.token_details` array (or the flatter `data.responseUsage.prompt_tokens_details.{cached_tokens,cache_creation_tokens}`)
  and accumulate `cache_read`/`cache_write` per turn the same way `outputTokens` is already
  accumulated from `assistant.message` events. `session.usage_checkpoint`'s
  `data.promptCacheBreakState[].models.<modelId>.{cache_read,cache_write}` is a second,
  pre-aggregated source carrying the same numbers — pick one as canonical rather than summing
  both (double-counting risk if both are read naively).
- **Interactive** (OTel only): extend `CopilotLogParser`'s existing OTel poller
  (`pollOtelContextWindow()`/`getFinalOtelUsage()`) to also accumulate
  `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_write.input_tokens` per
  `chat <model>` span, mirroring the existing `otelCumulativeInputTokens`/
  `otelCumulativeOutputTokens` pattern. Add these two attribute names alongside the existing
  `COPILOT_OTEL_*_ATTRIBUTE` constants.
- Reconcile the headless-stdout-event source and the OTel source deliberately (which one wins
  when both are present, e.g. a resumed session that mixes interactive and headless turns) —
  not assumed here; needs its own design decision, same caveat `augmentParsedOutput()`
  already navigates for context-window data via its tiered fallback.
- **Correct the reasoning-relationship label while touching this code.** Change
  `HARNESS_TOKEN_SEMANTICS[COPILOT_CLI].reasoningRelationship` from `UNREPORTED` to
  `INCLUDED_IN_OUTPUT` (`ModelPricing.ts:100`) — confirmed by the same probe
  (`completion_tokens_details.reasoning_tokens` is a subset of `completion_tokens`, matching
  Codex's classification). No behavior change in `calculateTokenCost` today (both values
  currently zero out separately-priced reasoning), so this is a documentation-accuracy fix,
  not a functional one — but leaving it wrong invites the same "trust the label" mistake this
  whole plan is about.
- **This surfaced a live cost-accuracy bug, not just a missing feature.** `HARNESS_TOKEN_SEMANTICS`
  already being `DISJOINT`/non-`UNKNOWN` for Copilot means `calculateTokenCost` already runs
  for it today — but with `cached` always `undefined → 0`, every cache-read token is billed at
  the full input rate. The probe's own `model.turn_started` event carried Copilot's live
  per-model billing table (`modelInfo.billing.token_prices.default`):
  `cache_read_price: 2` vs `input_price: 20` — cache reads are billed at **1/10th** the input
  rate. A run with heavy cache reuse (e.g. this plan's own `161.2k in` Copilot capture) is
  materially overpriced today by ctrlyoke's `≈$` estimate, not merely missing a nice-to-have
  breakdown line. Worth considering splitting this off as a small standalone fix ahead of the
  full parser-wiring work — see [Open questions](#open-questions).

## Touch points (for whoever implements this)

- `src/core/WorkflowExecutor.ts:1740-1782` (`resolveTokenCounts`) — insertion point for the
  netted total.
- `src/utils/ModelPricing.ts:75-102` (`HARNESS_TOKEN_SEMANTICS`) — reused, possibly relocated.
- `src/utils/TokenFormatting.ts` (`formatTokenBreakdown`, `buildAttemptTokenTooltipLines`) —
  Phase 0 copy and cache-relationship-aware breakdown formatting.
- `src/cli/CliTerminalFormatter.ts` (`renderStats`) — mirror the same copy/formatting change.
- `src/core/orchestration/` `WorkflowTokenTotalsReducer` — no code change expected (it just
  sums whatever `TokenStats.total` says), but its tests encode today's raw-provider-total
  assumption for Codex fixtures and will need updated expected values.
- `src/ui/webview-react/components/settings/stats/StatsUsageSection.tsx` and `UsageCard.tsx` —
  no code change expected; they render whatever the observed-usage store already rolled up,
  so they inherit the fix once Phase 1 lands upstream.
- `src/core/harness/copilot/CopilotLogParser.ts` (Phase 3) — `extractResponse()`,
  `extractStructuredEventsFromEvent()` (headless `model.model_call_success`/
  `session.usage_checkpoint` handling), and the OTel poller
  (`pollOtelContextWindow()`/`getFinalOtelUsage()`, plus two new
  `COPILOT_OTEL_CACHE_READ_ATTRIBUTE`/`COPILOT_OTEL_CACHE_WRITE_ATTRIBUTE`-style constants for
  interactive mode).
- `src/core/harness/copilot/CopilotCliProvider.ts` (Phase 3) — `augmentParsedOutput()`'s
  docstring claim that headless stdout "contains ... no input tokens" is stale as of CLI
  `1.0.82` and should be corrected alongside the parser change.
- `src/utils/ModelPricing.ts:98-101` (Phase 3) — correct
  `HARNESS_TOKEN_SEMANTICS[COPILOT_CLI].reasoningRelationship` from `UNREPORTED` to
  `INCLUDED_IN_OUTPUT`.
- `src/core/harness/qwen/QwenLogParser.ts:267-271` (`extractResponse()`) — drop the
  `+ (u.thoughtsTokenCount || 0)` term from `totalOutputTokens` (double-counts a value already
  inside `candidatesTokenCount` — see the
  [Qwen reasoning deep dive](#qwen-reasoning-deep-dive-thinking-tokens-confirmed-as-a-subset-of-output)),
  and promote `HARNESS_TOKEN_SEMANTICS[QWEN_CLI].reasoningRelationship`
  (`ModelPricing.ts:86-89`) from `UNKNOWN` to `INCLUDED_IN_OUTPUT`.
- Tests: `src/test/unit/ModelPricing.test.ts` and the per-harness parser tests referenced in
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md` Phase 2/3 (streaming replacement, retry inclusion,
  `byHarness === sum(byLocalDay)`) will need Codex **and Qwen** fixtures updated for the new
  expected totals; add a new test asserting cost math is unaffected (raw `prompt`/`cached`
  unchanged) while the headline total is netted. Also add `HARNESS_TOKEN_SEMANTICS`
  promotion tests for `QWEN_CLI`/`ANTIGRAVITY_CLI`/`OPENCODE_CLI` asserting `SUBSET`/
  `DISJOINT`/`DISJOINT` (cache) and `QWEN_CLI` asserting `INCLUDED_IN_OUTPUT` (reasoning)
  respectively, a `QwenLogParser` fixture with a non-zero `thoughtsTokenCount` asserting
  `outputTokens === candidatesTokenCount` (not `+ thoughtsTokenCount`), and a regression test
  that `DISJOINT`-harness totals are byte-for-byte unchanged by this plan (Claude, Antigravity,
  OpenCode).

## Open questions

- ~~Does Copilot's OTel exporter expose any cache signal in a newer CLI version than the
  `1.0.78` installed at the time of the Stage 9 research in
  `HARNESS_USAGE_TRACKING_PLAN.md`?~~ **Resolved this session:** yes, on CLI `1.0.82` — see
  the [Copilot deep dive](#copilot-deep-dive-cache-signal-confirmed-on-cli-1082). Two residual
  questions this raised, still open:
  - The exact CLI version where the cache breakdown was introduced is unbounded below `1.0.82`
    and above `1.0.78` — worth pinning down precisely if ctrlyoke wants a version-gated
    capability check, mirroring the `verifiedVersions` pattern already used for other Copilot
    capabilities in `CopilotCliProvider.ts`'s capability constants (e.g.
    `COPILOT_MCP_FILTERING_CAPABILITY`).
  - The interactive-mode OTel cache attributes (`gen_ai.usage.cache_read.input_tokens`/
    `cache_write.input_tokens`) were confirmed via headless `-p` runs with OTel forced on, not
    against a live attached TUI (`-i`) session — scripting a real interactive session wasn't
    practical for this probe. Expected to hold (OTel span emission is documented as
    invocation-mode-agnostic, and `getInteractiveSpawnEnv()` already wires the same env vars
    into interactive launches) but not independently re-verified; worth a quick manual `-i`
    check before Phase 3 ships the interactive-mode half of the fix.
  - Should the now-confirmed cost-accuracy bug (Copilot cache-read tokens billed at the full
    input rate today, a 10× overpricing per the model's own billing table) be split into its
    own small standalone fix ahead of the broader Phase 3 parser-wiring work, since it's a
    pure accuracy bug independent of this plan's display/total-netting scope?
- Should the normalized total's `totalConfidence` distinguish "provider total, verbatim"
  from "provider total, ctrlyoke-adjusted for cache" more explicitly than reusing
  `ACCUMULATED`? A dedicated confidence value might be worth adding to
  `TOKEN_TOTAL_CONFIDENCE` in `DashboardConstants.ts` rather than overloading an existing one
  whose meaning is otherwise "summed from provider per-turn usage."
- ~~`reasoningRelationship` remains `UNKNOWN` for Qwen, OpenCode, and Antigravity even after
  this revision's cache-relationship evidence — a live run showing whether each harness's
  reasoning/thinking tokens are folded into output or billed separately is still needed
  before their table-priced cost estimates can turn on (see Phase 2). This plan's cache-only
  evidence does not resolve it.~~ **Resolved this session for Qwen:** three live `qwen -p`
  runs (including a decisive test isolating thinking length from visible-answer length)
  mathematically confirm `INCLUDED_IN_OUTPUT` — see the
  [Qwen reasoning deep dive](#qwen-reasoning-deep-dive-thinking-tokens-confirmed-as-a-subset-of-output).
  **Still open for OpenCode and Antigravity** — Phase 2 stands unchanged for both; this
  session's evidence is Qwen-specific and doesn't generalize (Qwen's shape is driven by its
  particular DashScope OpenAI-compatible backend, not a property of "reasoning tokens" in
  general).
- Is a single real capture per harness a high enough evidentiary bar to promote
  `HARNESS_TOKEN_SEMANTICS` permanently, or should the promotion in Phase 1 note that it
  rests on one example each (Antigravity, Qwen, OpenCode) versus Claude/Codex's broader
  original research? The `cached > in` proof for Antigravity and OpenCode is mathematically
  conclusive regardless of sample size (it can't be explained any other way), but Qwen's
  `cached ≤ in` is corroborating, not a proof by itself — it's trusted here because it's
  independently confirmed by Google's own Gemini API docs, not the capture alone.

## References

- [Anthropic prompt-caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — confirms `input_tokens` excludes both `cache_read_input_tokens` and `cache_creation_input_tokens`.
- [openai/codex PR #1583 discussion](https://github.com/openai/codex/pull/1583) — Codex rollout `token_count` field semantics: `input_tokens` is "all content sent to the API," `cached_input_tokens` a breakdown subset.
- [openai/codex issue #1047](https://github.com/openai/codex/issues/1047) — cumulative session token display, corroborating that Codex's own running totals are session-cumulative, not per-turn deltas.
- [Counting tokens, Gemini API docs](https://ai.google.dev/api/tokens) — confirms `cachedContentTokenCount` is a subset of `promptTokenCount`, matching Qwen's parser comment and the real capture above.
- [OpenCode issue #30649](https://github.com/anomalyco/opencode/issues/30649) and [#28494](https://github.com/anomalyco/opencode/issues/28494) — corroborate that OpenCode tracks `tokens.cache.read` as a field distinct from `tokens.input`/context accounting, consistent with the `DISJOINT` classification confirmed here.
- `copilot help monitoring` / `copilot help environment` (CLI `1.0.82`, run locally) — documents `COPILOT_OTEL_FILE_EXPORTER_PATH`/`COPILOT_OTEL_ENABLED` activation and the `gen_ai.client.token.usage` metric shape; the cache attributes themselves (`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`) are undocumented in either help topic and were found only by inspecting live span output, not by reading the CLI's own docs — see the [Copilot deep dive](#copilot-deep-dive-cache-signal-confirmed-on-cli-1082) for the raw capture.
- Three live `qwen -p ... -o json` runs (CLI `0.22.3`, local session logs under `~/.qwen/projects/c--dev-ctrlyoke/chats/*.jsonl`, not a published URL) — the decisive third run mathematically rules out `thoughtsTokenCount` being disjoint from `candidatesTokenCount` for Qwen CLI's DashScope OpenAI-compatible-endpoint traffic; see the [Qwen reasoning deep dive](#qwen-reasoning-deep-dive-thinking-tokens-confirmed-as-a-subset-of-output) for the raw numbers. This is the same `completion_tokens_details.reasoning_tokens ⊂ completion_tokens` convention OpenAI's own [Chat Completions usage object docs](https://platform.openai.com/docs/api-reference/chat/object) describe for its own reasoning models — corroborating, not itself proof for Qwen, since DashScope is a different vendor merely exposing an OpenAI-compatible response shape.
