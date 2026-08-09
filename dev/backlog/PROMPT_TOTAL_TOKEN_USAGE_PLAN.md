# Prompt, Workflow Token Usage And Cost Plan

**Status:** Ready to implement (empirical pricing gates remain in Phase 4)
**Created:** July 9, 2026
**Revised:** August 9, 2026 — final codebase pass; canonical attempt identity,
per-harness run subtotals, persistence ownership, and combined staging order added
**Related:** `HARNESS_USAGE_TRACKING_PLAN.md`, `WORKFLOW_VARIANTS_PLAN.md`

---

## What Changed Since The Last Revision

The July revision assumed ctrlyoke had only last-turn context-window numbers and
would have to _derive_ cumulative prompt usage from compaction boundaries. That
is no longer true. Five parsers already accumulate real usage for the whole
prompt attempt, Copilot has the necessary per-span source but currently retains
only the last input value, and Antigravity gained two independent token sources.
The remaining work is therefore preservation, normalization, and aggregation
rather than a compaction-based estimator:

- **The main gap is downstream of parsing.** Where a parser supplies
  `TokenUsage.inputTokens` / `outputTokens` / `totalTokens`, those fields are
  cumulative across the attempt; `contextWindowUsedTokens` is separately the
  last turn's window occupancy. The audit below identifies the small
  provider-specific exceptions that must be closed first.
- **The lossy boundary is `WorkflowExecutor.resolveTokenCounts`**
  (`src/core/WorkflowExecutor.ts:1569`), which maps `TokenUsage` → `TokenStats`
  and _drops_ `totalTokens` and `reasoningOutputTokens`. Downstream UI then
  recomputes `total = prompt + completion`
  (`src/ui/webview-react/components/output/OutputRow.tsx:1071`,
  `src/cli/CliTerminalFormatter.ts:563`), which discards provider totals and
  mis-sums every harness whose cache tokens sit outside `input_tokens`.
- **The derived-compaction estimator is no longer needed** as a source of
  totals. Compaction count survives only as explanatory context for why the
  context bar dropped.
- **Per-attempt durability is already free.** `CLI_OUTPUT_RECORDED` timeline
  events carry the whole `CliOutput`, including `tokens`
  (`src/types/WorkflowTimelineTypes.ts:254`). Widening `TokenStats` makes
  per-attempt totals durable with no new persistence code. The old plan's
  "persist `promptTotalTokens` into prompt `_runtime`" step is wrong and is
  dropped — `PromptQueue` deliberately strips display-only token fields out of
  working-file step runtime (`src/core/PromptQueue.ts:2032-2052`).
- **Cost is now in scope** because two harnesses self-report dollars and the
  rest can be priced from a table (see [Cost Model](#cost-model)).
- **The aggregate must retain harness attribution.** A workflow may switch
  harnesses between steps or reruns. A whole-run total alone cannot feed the
  per-harness rollups in `HARNESS_USAGE_TRACKING_PLAN.md`, so
  `WorkflowTokenTotals` includes `byHarness` and compact `byLocalDay`
  breakdowns populated from immutable attempt output metadata/timestamps.
- **Attempt identity is already canonical in the timeline.** Use
  `(target, runIndex, attemptIndex, phase)`, matching
  `OutputHistoryTimelineAdapter.getCliEntryKey`. Omitting `runIndex` collapses
  manual reruns; omitting `phase` can collapse prompt and condition output.
- **Working-file persistence reconstructs `_runtime`.** Adding a field to
  `WorkingFileRuntime` is not sufficient: `PromptQueue` must own the in-memory
  aggregate, `IWorkingFileQueueAccess` must expose it, and
  `WorkingFileManager.updateWorkingFile` must project it whenever it rebuilds
  `_runtime`. `CliWatchSession` must read the same field for CLI-managed runs.

### Per-harness token source audit (August 8, 2026)

| Harness           | Cumulative per-attempt totals                                                                                                                                         | Context window (last turn)                                              | Cache split                                                                                 | Reasoning tokens                                                   | Self-reported cost                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `claude-cli`      | Yes — sums every assistant `message.usage`, prefers `result.usage.total_tokens` (`ClaudeLogParser.ts:278-288, 362-378`)                                               | `input + cache_creation + cache_read` of last turn (`:345-353`)         | `cache_read` and `cache_creation` **disjoint** from `input_tokens`                          | No                                                                 | **Yes** — `result.total_cost_usd` + `modelUsage` (not parsed today) |
| `codex-cli`       | Yes — `token_count.info.total_token_usage` (`CodexLogParser.ts:230-240`); preserve its `total_tokens` instead of always recomputing input + output                    | `last_token_usage.total_tokens` (`:241-249`)                            | `cached_input_tokens` is a **subset** of `input_tokens` (`:242-243`)                        | Yes — `reasoning_output_tokens` (parsed, then dropped downstream)  | No                                                                  |
| `qwen-cli`        | Yes — sums `usageMetadata` per assistant turn (`QwenLogParser.ts:244-253`)                                                                                            | last turn `promptTokenCount` (`:322-326`)                               | `cachedContentTokenCount` is a **subset** of `promptTokenCount` (Gemini semantics — verify) | Folded into output (`thoughtsTokenCount`), not reported separately | No                                                                  |
| `opencode-cli`    | Yes — accumulates every `step_finish` (`OpenCodeEventMapper.ts:52-67`), but its output metadata currently omits the harness/model attribution the run breakdown needs | last step's `tokens.total`                                              | `tokens.cache.read` accumulated; `cache.write` **not** captured                             | Emitted by the CLI as `tokens.reasoning`, **not** captured         | **Yes** — `step_finish.part.cost` (USD), **not** captured           |
| `antigravity-cli` | Yes — stream-json `result.usage.total_tokens` (`AntigravityStreamJsonUsage.ts:39-54`)                                                                                 | statusline sidecar snapshot (`AntigravityStatuslineSidecar.ts:237-243`) | `cache_read_tokens`                                                                         | Yes — `thinking_tokens`                                            | No                                                                  |
| `copilot-cli`     | **No** — OTel keeps only the _last_ chat span's input (`CopilotLogParser.ts:132, 217`); output is cumulative (`:134, 221`)                                            | `otelLastInputTokens` (`:230-237`)                                      | None                                                                                        | None                                                               | No (bills in AI credits — see below)                                |

Four defects fall out of this table and are part of this plan:

1. **Antigravity discards its own billing totals.**
   `AntigravityLogParser.extractTokenUsage` short-circuits on the statusline
   snapshot and returns it wholesale, keeping only `reasoningOutputTokens` from
   stream-json (`AntigravityLogParser.ts:954-964`). The statusline is
   _context-window shaped_ (`contextWindowUsedTokens = input + output`,
   `AntigravityStatuslineSidecar.ts:240`); stream-json's `result.usage` is the
   _billing_ record. Statusline must win for context fields only; stream-json
   must win for `inputTokens` / `outputTokens` / `totalTokens` /
   `cachedInputTokens`.
2. **Copilot has no cumulative input.** Fixing it is a one-line accumulator
   (`otelCumulativeInputTokens += input` alongside the existing output sum), and
   is the difference between Copilot showing a real attempt total and showing a
   lower bound.
3. **Codex drops the provider's explicit total.** `CodexLogParser` currently
   sets `totalTokens` to `input + output` even though
   `total_token_usage.total_tokens` is present. Prefer the provider field and
   fall back to the sum only when it is absent.
4. **OpenCode lacks immutable harness attribution.** Its parsed metadata has
   `sessionId` and `usage`, but no `harness`. Ensure every completed AI
   `CliOutput` carries a valid `HarnessId` (and model when known) in
   `structured.metadata`; the aggregate must not infer the harness later from a
   mutable workflow definition.

---

## Problem

ctrlyoke shows context-window fullness per prompt in four places today:

- `src/ui/webview-react/components/prompts/WorkflowStep.tsx:327-349` — the
  vertical percent bar.
- `src/ui/webview-react/hooks/useContextPct.ts` — the shared percentage
  resolver used by `WorkflowStepsPanel` and the mobile `PromptChipRail`.
- `src/ui/webview-react/components/output/OutputRow.tsx:1028-1091` —
  `StatsRowView`'s `Context: used/size (%)`, with the token breakdown hidden in
  hover text.
- `src/cli/CliTerminalFormatter.ts:551-581` — `renderStats` for CLI users.

That is accurate for the **final conversation state** but misleading for long
prompts crossing compaction boundaries: a run that fills and compacts a 200k
window twice, then ends at 10k, correctly shows `10k/200k (5%)` while having
actually consumed ~410k tokens. Users need three distinct signals:

- **Current context window** — how full the conversation is right now.
- **Prompt attempt total** — how much work this attempt actually consumed.
- **Workflow run total** — observed tokens across every AI attempt in the run.

Do not replace the context-window display. Add cumulative usage beside it.

The workflow dropdown also lacks any token total, which makes harness
comparison laborious: duplicate a workflow, switch harness, run both, then open
each run and read its steps one by one. The latest run's observed total belongs
in `src/ui/webview-react/components/workflow/WorkflowList.tsx` directly.

Finally, tokens alone do not answer "which harness was cheaper" when models
differ by 30x in price. Cost estimation is the point of the exercise for most
users, so it is planned here rather than deferred indefinitely.

---

## Product Decision

Total tokens is the primary metric; cost is a secondary, clearly-labelled
estimate; compaction count is explanatory context.

1. Keep the existing context percentage bar in the steps panel unchanged, and
   surface the attempt total beside it **only when the context was compacted** —
   the one case where the bar actively misleads.
2. In the output stats row, show context, attempt total, and cost as distinct
   visible stats — not hover-only.
3. Show cost only when it is either harness-reported or priced from a known
   model. Label price-table values as list-price estimates and retain the source
   for harness-reported or user-overridden values; do not call every source
   "list price."
4. Aggregate attempt totals into one run-scoped workflow total shown in every
   workflow-list row.
5. Never render an unknown value as zero. Partial coverage renders as a lower
   bound (`≥410k`); unavailable renders as nothing plus a tooltip.

Rationale: compaction count alone is too coarse for cost or performance; total
tokens feed harness comparison and the observed-usage rollups in
`HARNESS_USAGE_TRACKING_PLAN.md`; an aligned workflow total makes lightweight
comparison possible without a dedicated comparison view.

---

## Data Model

### Widen `TokenStats` — flat, not nested

The July plan proposed a nested `PromptTokenTotals` object plus a parallel set
of `promptTotal*` fields on `TokenUsage`. Both are now redundant: the parsers
already produce cumulative attempt totals, so there is no second "total" concept
to model. Extend the existing contracts in place.

`src/types/WebviewMessageTypes.ts`:

```typescript
export interface TokenStats {
  /** Cumulative input tokens for this attempt (see per-harness cache semantics). */
  prompt: number;
  /** Cumulative output tokens for this attempt. */
  completion: number;
  /** Cache-read tokens (billed at reduced rate). */
  cached?: number;
  /** Cache-creation tokens — Claude only. */
  cacheCreated?: number;
  /** Cumulative reasoning output tokens, when reported separately. */
  reasoning?: number;
  /**
   * Normalized cumulative total for the attempt (provider-reported or parser
   * accumulated, as described by `totalConfidence`). Prefer this over
   * `prompt + completion`: whether cache tokens are already inside `prompt`
   * varies by harness, so the sum is wrong for at least half of them.
   */
  total?: number;
  /** Total input tokens occupying the context window (last API turn). */
  contextWindowUsed?: number;
  /** Model's total context window capacity in tokens. */
  contextWindowSize?: number;
  /** Compaction events observed during this attempt. Context, not a total source. */
  compactionCount?: number;
  /** Sum of known pre-compaction token counts. Best effort, display only. */
  compactedContextTokens?: number;
  /** Where `total` came from. Drives whether the UI may compare it as exact. */
  totalConfidence?: TokenTotalConfidence;
  /** Cost estimate for this attempt. Absent when unpriceable. */
  cost?: AttemptCostEstimate;
  /** Why `cost` is absent when token totals exist. */
  costUnavailableReason?: AttemptCostUnavailableReason;
}
```

Add to `src/types/DashboardConstants.ts` (flow-control strings must be
constants, per the project's coding principles):

```typescript
export const TOKEN_TOTAL_CONFIDENCE = {
  /** Provider reported a cumulative total for the whole attempt. */
  PROVIDER: "provider",
  /** Summed from provider per-turn usage by a ctrlyoke parser. */
  ACCUMULATED: "accumulated",
  /** Known to be incomplete (e.g. a harness that only reports the last turn). */
  PARTIAL: "partial",
} as const;

export const WORKFLOW_TOKEN_COVERAGE = {
  COMPLETE: "complete",
  PARTIAL: "partial",
} as const;
```

`src/types/CliOutputTypes.ts` `TokenUsage` needs no parallel total object, but
its comments and provenance do need correction. `inputTokens` is not always the
non-cached portion, and `totalTokens` is not universally `input + output`; both
relationships vary by harness. Add `totalConfidence` so the parser can state
provenance rather than the executor guessing. Keep harness-reported dollars on
`OutputMetadata.harnessReportedCostUsd` (not inside the token object), with any
provider model-cost breakdown in a typed sibling field. Narrow
`OutputMetadata.harness` to `HarnessId` and ensure all six parsers stamp it on
completed AI output; this is the immutable attribution used by run aggregation.

Set confidence at the source:

| Harness         | `totalConfidence`                                                                           |
| --------------- | ------------------------------------------------------------------------------------------- |
| Claude          | `PROVIDER` when `result.usage.total_tokens` is present; otherwise `ACCUMULATED`             |
| Codex           | `PROVIDER` for `total_token_usage.total_tokens`; otherwise `ACCUMULATED`                    |
| Qwen / OpenCode | `ACCUMULATED` when their per-turn/step records were observed                                |
| Antigravity     | `PROVIDER` for stream-json terminal/result totals; `PARTIAL` for a statusline-only fallback |
| Copilot         | `ACCUMULATED` when at least one OTel chat span was observed; otherwise no total             |

### Attempt cost

Define the normalized cost types in `src/types/CtrlYokeTypes.ts` and import them
into `WebviewMessageTypes.ts`; parser `OutputMetadata` carries only typed raw
harness-reported cost inputs.

```typescript
export interface AttemptCostEstimate {
  /** Total estimated cost in USD for this attempt. */
  usd: number;
  /** Where the number came from — governs the label and the disclaimer. */
  source: AttemptCostSource;
  /** Whether every billing relationship used by the calculation is verified. */
  confidence: AttemptCostConfidence;
  /** Machine-readable explanation for a fallback/substitution shown in the tooltip. */
  noteCode?: AttemptCostNoteCode;
  /** Model the price table was keyed on; shown in the tooltip. */
  modelId?: string;
  /** Optional component breakdown for the tooltip. */
  breakdown?: {
    inputUsd?: number;
    outputUsd?: number;
    cachedInputUsd?: number;
    cacheWriteUsd?: number;
    reasoningUsd?: number;
  };
}
```

```typescript
export const ATTEMPT_COST_SOURCES = {
  /** The harness itself reported dollars (Claude `total_cost_usd`, OpenCode `part.cost`). */
  HARNESS_REPORTED: "harness-reported",
  /** Computed by ctrlyoke from the bundled price table. */
  PRICE_TABLE: "price-table",
  /** Computed from a user-supplied per-harness/model override. */
  USER_OVERRIDE: "user-override",
} as const;

export const ATTEMPT_COST_CONFIDENCE = {
  COMPLETE: "complete",
  PARTIAL: "partial",
} as const;

export const ATTEMPT_COST_NOTE_CODES = {
  HARNESS_DIVERGENCE: "harness-divergence",
} as const;

export const ATTEMPT_COST_UNAVAILABLE_REASONS = {
  UNKNOWN_MODEL: "unknown-model",
  PARTIAL_TOKENS: "partial-tokens",
  UNVERIFIED_TOKEN_SEMANTICS: "unverified-token-semantics",
  MISSING_HARNESS_COST: "missing-harness-cost",
  COPILOT_BILLING_UNIT: "copilot-billing-unit",
} as const;
```

Derive `TokenTotalConfidence`, `WorkflowTokenCoverage`, `AttemptCostSource`,
`AttemptCostConfidence`, `AttemptCostNoteCode`, and
`AttemptCostUnavailableReason` from these constant objects; do not maintain a
second handwritten string union.

Source and confidence are independent. Do not overload `source` with
`"partial"`: the UI still needs to know whether a partial figure came from the
harness, the bundled table, or a user override. If cache/reasoning semantics are
unknown enough that no defensible single value exists, omit the estimate rather
than inventing a lower bound.

### Workflow run totals

Shared types in `src/types/CtrlYokeTypes.ts`, reused by `WorkflowSummary`,
`RecentWorkflowsMessage`, the React `RecentWorkflow` projection, and `RunSummary`:

```typescript
export interface WorkflowTokenTotals {
  /** Sum of every AI attempt's `TokenStats.total` observed in this run. */
  total: number;
  /** Complete only when every executed AI attempt reported a usable total. */
  coverage: WorkflowTokenCoverage;
  /** AI attempts included in `total`. */
  reportedAttemptCount: number;
  /** AI attempts executed, including retries and manual reruns. */
  attemptCount: number;
  /** False while the run can still add usage. */
  isFinal: boolean;
  /** Summed attempt cost. Absent when no attempt was priceable. */
  costUsd?: number;
  /** True when at least one included attempt could not be priced. */
  costPartial?: boolean;
  /** Distinct attempt cost sources represented, in stable display order. */
  costSources?: AttemptCostSource[];
  /**
   * Same aggregate partitioned by the harness recorded on each immutable
   * attempt output. This is the only source for cross-run harness rollups.
   */
  byHarness: Partial<Record<HarnessId, WorkflowHarnessTokenTotals>>;
  /**
   * Same per-harness subtotals partitioned by the attempt start's local
   * YYYY-MM-DD key. Allows day/week/month rollups without rescanning events or
   * assigning a multi-day run entirely to its completion date.
   */
  byLocalDay: Record<
    string,
    Partial<Record<HarnessId, WorkflowHarnessTokenTotals>>
  >;
}

export interface WorkflowHarnessTokenTotals {
  input: number;
  output: number;
  cachedInput?: number;
  cacheCreated?: number;
  reasoningOutput?: number;
  total: number;
  coverage: WorkflowTokenCoverage;
  reportedAttemptCount: number;
  attemptCount: number;
  costUsd?: number;
  costPartial?: boolean;
  costSources?: AttemptCostSource[];
}

export interface WorkflowSummary {
  // existing fields...
  tokenTotals?: WorkflowTokenTotals;
}
```

`total` is an observed token total, not a cost. When `coverage === "partial"`
it is a lower bound and the UI must format it with `≥`.
`WorkflowTokenTotals` is absent when zero attempts reported a usable total; do
not materialize `≥0` merely because an AI attempt ran. Each `byHarness` subtotal
uses the same rule.

### Workflow total semantics

A workflow total is scoped to **one run**, not the lineage:

- Include every executed AI attempt: ordinary prompts, final steps, automatic
  retries, manual step reruns, and dynamically added AI steps.
- Count each attempt's `TokenStats.total` exactly once. The canonical identity is
  `(target, runIndex, attemptIndex, phase)`. Later `CLI_OUTPUT_RECORDED`
  snapshots for that identity _replace_ earlier placeholder/streaming snapshots;
  they are never summed as new usage.
- Exclude script steps unless a future script-backed harness reports normalized
  AI usage. `TIMELINE_ATTEMPT_KINDS.AI` is the discriminator
  (`src/types/WorkflowTimelineTypes.ts:67-71`) — do not infer kind from runtime
  fields.
- Do not include earlier runs from the lineage.
- A draft that never executed has no total, not a zero total.
- A running workflow exposes an observed-so-far total with `isFinal: false`.
- If any executed AI attempt lacks a usable total, keep the known sum and set
  `coverage: "partial"`.
- Partition the same attempts by `structured.metadata.harness`. Missing/invalid
  attribution makes overall coverage partial and is never guessed from the
  workflow's current harness setting.
- Partition attributed attempts again by the local `YYYY-MM-DD` of their
  `ATTEMPT_STARTED.timestampMs` (fall back to the completed output timestamp only
  for repaired legacy events). `byHarness` must equal the sum of `byLocalDay`.

### Persistence

Three tiers, all reusing storage that already exists:

| Scope               | Where                                                                             | Why                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per attempt         | `CLI_OUTPUT_RECORDED` events in `events.jsonl` (already carry `CliOutput.tokens`) | Free once `TokenStats` is widened; survives history reload, undo/redo, and run navigation with no new code                                                                |
| Per run (fast path) | `WorkingFileRuntime.tokenTotals` in the run's `workflow.ctrlyoke.json`            | `WorkflowSerializer.handleGetRecentWorkflows` already parses this file per row and `RunSummaryCache` already caches it — the workflow list gets totals for zero extra I/O |
| Per run (run list)  | `WorkflowRunManifest` → projected into `RunSummary`                               | `RunSummaryRow.tsx` can then show the same total without loading events                                                                                                   |

Do **not** add per-step token fields to `PromptRuntimeMetadata`. Normal
execution does not persist display-only token state into working-file steps, and
`PromptQueue` actively strips it on undo/redo sync (`src/core/PromptQueue.ts:2032-2052`).
The timeline is the durable per-attempt record.

Persistence ownership is explicit:

- Add a pure `WorkflowTokenTotalsReducer` under `src/core/orchestration/`.
  `OutputHistoryManager` keeps one reducer per active manifest, hydrates it once
  from `TimelineRecorder.streamEvents` on restore/recovery, and applies the exact
  events returned by relevant `appendEvents` calls. The reducer's replacement
  semantics make repeated aggregate output events harmless.
- `PromptQueue` stores the reducer's latest projected snapshot for live summary
  and working-file persistence, and exposes it through `QueueState` /
  `IWorkingFileQueueAccess`; it does not independently recalculate tokens.
- `WorkingFileManager.updateWorkingFile` includes it whenever it reconstructs
  `workingFile._runtime`; otherwise the next runtime transition would erase it.
- `OutputHistoryManager` writes the same snapshot to the manifest through its
  existing serialized manifest operation queue. Bump `TIMELINE_SCHEMA_VERSION`
  for the optional manifest field.
- When both copies exist, the run working file wins and the manifest is the
  fallback, matching the existing execution-state precedence in
  `readRunSummaryRecord`.
- Reopening a same-run continuation flips `isFinal` back to `false`; every
  terminal transition writes the final aggregate to both copies.
- `WorkflowInstance.getSummary`, `WorkflowSerializer.handleGetRecentWorkflows`,
  `WorkflowOrchestrator`'s CLI-watch initial/final projections, and
  `CliWatchSession.handleWorkingFileChange` all forward the same field.

---

## Collection Strategy

### Normalize at the parser, aggregate in the history layer, render in React

1. **Parsers** keep doing what they do, plus: set `totalConfidence`, stop
   dropping reasoning tokens, and fix the four defects listed above.
2. **`WorkflowExecutor.resolveTokenCounts`** becomes lossless — it is the single
   `TokenUsage` → `TokenStats` conversion point and must forward `totalTokens`,
   `reasoningOutputTokens`, and confidence.
3. **One pure compaction summarizer** counts `CLI_EVENT_TYPES.COMPACTION` in the
   completed parser output and sums finite `CompactionData.preTokens`. Invoke it
   at the same `resolveTokenCounts` boundary; do not add six counters. Claude,
   Codex, OpenCode, and Antigravity emit these today; Qwen and Copilot remain
   silent rather than inferred.
4. **One pure `WorkflowTokenTotalsReducer`** over normalized timeline attempts,
   owned by `OutputHistoryManager` per active manifest and projected into
   `PromptQueue`. `WorkflowList.tsx` must never walk output rows or reconstruct
   provider usage.
5. **React renders normalized fields only** — no arithmetic over provider
   shapes in components.

The aggregator's responsibilities:

- identify attempts by `(target, runIndex, attemptIndex, phase)`, exactly as
  `OutputHistoryTimelineAdapter.getCliEntryKey` does;
- replace streaming snapshots for an attempt rather than double-counting;
- include retries, final steps, manual reruns, and dynamic steps;
- track reported-vs-executed attempt coverage;
- persist the latest aggregate into the run's `WorkingFileRuntime` and manifest
  so pause/resume, history reload, CLI-managed runs, and hosted clients agree;
- publish the same `WorkflowTokenTotals` through live `WorkflowSummary` and
  recent-workflow list messages.

Use `ATTEMPT_STARTED.payload.kind` to count every executed AI attempt, including
one that never produced a `CliOutput`. Use the highest-sequence
`CLI_OUTPUT_RECORDED` snapshot for each identity to supply tokens. This is what
makes coverage correct for failures and prevents the aggregate writes emitted by
`saveExecutionOutput` from recounting earlier snapshots.
Apply/persist a new reducer snapshot after `ATTEMPT_STARTED`, after any
`CLI_OUTPUT_RECORDED` aggregate, and after run reopen/termination changes
`isFinal`. Startup recovery reduces the timeline and repairs stale/missing
working-file or manifest aggregates without making normal list reads scan
`events.jsonl`.

---

## Cost Model

### Where the raw price data comes from

Three tiers, most trustworthy first. The tier used is recorded in
`AttemptCostEstimate.source` and surfaced in the tooltip.

**Tier 1 — harness-reported dollars.** Preferred whenever present, because the
harness knows its own model routing, its own discounts, and its own cache
accounting.

- `claude-cli`: `result.total_cost_usd`, plus a per-model `modelUsage` breakdown
  (documented in `dev/implemented/CLAUDE_CLI_STREAM_JSON_FORMAT.md:408-414,
748-754`; ctrlyoke parses the sibling `usage` object today but not the cost).
  **Caveat:** an upstream bug reported April 2026 has `total_cost_usd`
  over-reporting by roughly 10x on some models
  ([anthropics/claude-code#53371](https://github.com/anthropics/claude-code/issues/53371)).
  Before shipping, cross-check it against the price-table computation for the
  same attempt and prefer the table when they disagree by more than ~2x; log the
  discrepancy rather than silently trusting either.
- `opencode-cli`: `step_finish.part.cost` in USD per step, summed across steps.
  This is the _only_ viable source for OpenCode, because OpenCode proxies
  arbitrary providers and models that no bundled table can enumerate.

**Tier 2 — a bundled per-model price table.** Add `src/utils/ModelPricing.ts`
beside `ModelConstants.ts`, keyed **per harness then per model id**, mirroring
how context-window sizes are already keyed
(`COPILOT_CLI_CONTEXT_WINDOW_SIZES`, `CODEX_CLI_CONTEXT_WINDOW_SIZES`) — the
same model id can be priced differently by different harnesses.

```typescript
export interface ModelPricing {
  /** USD per 1M non-cached input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens (reasoning included unless priced separately). */
  outputPerMTok: number;
  /** USD per 1M cache-read input tokens. */
  cachedInputPerMTok?: number;
  /** USD per 1M cache-write tokens — Claude only. */
  cacheWritePerMTok?: number;
  /** USD per 1M reasoning tokens, when a provider prices them apart from output. */
  reasoningPerMTok?: number;
  /** Provider doc URL the numbers were read from. Asserted as fact — keep current. */
  sourceUrl: string;
  /** ISO date the entry was last verified against `sourceUrl`. */
  verifiedOn: string;
}
```

Rejected alternative: vendoring LiteLLM's
[`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
(MIT-licensed, community-maintained, covers 100+ providers). It is multi-megabyte
and covers thousands of models ctrlyoke will never run; ctrlyoke lists a few
dozen across all six harnesses (`ModelConstants.ts`). Keep a curated table and
use LiteLLM's file as a cross-check when refreshing prices, not as a dependency.

Also rejected: fetching prices at runtime. It adds a network dependency and a
privacy surface to a feature that must work offline, and prices change on the
order of months.

**Tier 3 — unpriceable.** Show tokens, omit cost, and say why in the tooltip.
Applies to unknown/BYO models, OpenCode runs where `part.cost` is missing, and
any attempt with `totalConfidence: "partial"`.

Add a user override so a table miss is not a dead end:

```json
"ctrlyoke.modelPricing": {
  "<harnessId>": { "<modelId>": { "inputPerMTok": 3, "outputPerMTok": 15 } }
}
```

### The calculation — and why the cache split matters

The naive formula (`input * inRate + output * outRate`) is wrong for most
harnesses, because **whether cache tokens are already inside the input count
differs per harness**, and cached input is typically 10x cheaper while often
being the _majority_ of tokens in an agentic run. Getting this wrong skews cost
estimates by more than the harness differences the feature exists to compare.

| Harness           | Relationship                                                                                                      | Billable non-cached input |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `claude-cli`      | `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` are **disjoint**                         | `prompt` as-is            |
| `codex-cli`       | `cached_input_tokens` ⊂ `input_tokens` (asserted in `CodexLogParser.ts:242-243`)                                  | `prompt − cached`         |
| `qwen-cli`        | `cachedContentTokenCount` ⊂ `promptTokenCount` (Gemini semantics — **verify against a live run before shipping**) | `prompt − cached`         |
| `opencode-cli`    | `tokens.cache.read` believed disjoint from `tokens.input` — **verify**                                            | n/a (use `part.cost`)     |
| `antigravity-cli` | `cache_read_tokens` vs `input_tokens` — **verify**                                                                | verify                    |
| `copilot-cli`     | No cache reporting at all                                                                                         | `prompt` as-is            |

So the calculation must be driven by a per-harness declaration, not a global
assumption:

```typescript
const nonCachedInput = harnessCachedIsSubsetOfInput(harnessId)
  ? Math.max(prompt - (cached ?? 0), 0)
  : prompt;

usd =
  (nonCachedInput / 1e6) * pricing.inputPerMTok +
  ((cached ?? 0) / 1e6) * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) +
  ((cacheCreated ?? 0) / 1e6) *
    (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) +
  (billableOutput / 1e6) * pricing.outputPerMTok +
  (separatelyPricedReasoning / 1e6) * (pricing.reasoningPerMTok ?? 0);
```

`billableOutput` also needs a per-harness rule. Qwen explicitly folds
`thoughtsTokenCount` into `outputTokens` (`QwenLogParser.ts:248-250`). A separate
reasoning field does not by itself prove whether those tokens are disjoint from
or included in output, so verify Codex and Antigravity rather than assuming.
Encode the relationship as `"included-in-output" | "disjoint" | "unreported" |
"unknown"` in one per-harness token-semantics descriptor keyed by `HarnessId`.
Unknown suppresses table pricing; it does not silently choose a formula.

### Cost is not spend

Say this plainly in the UI, because it is the single most likely source of user
complaints:

- **Subscription harnesses do not bill per token.** Claude Pro/Max, Codex on a
  ChatGPT plan, and Antigravity consume plan quota; a Claude Max user who "spent
  $40" of tokens spent $0 incrementally. For table-derived values use
  **"≈$0.41 at API list prices"**; for harness-reported or user-overridden
  values use the matching source phrase. Never label the number "cost" alone.
- **Copilot does not bill in tokens at all.** It bills in premium requests / AI
  credits (1 credit = $0.01; see `HARNESS_USAGE_TRACKING_PLAN.md`). Dollar
  estimates from token counts are meaningless there. Show tokens and, once the
  usage plan lands, credits — not a synthesized dollar figure.
- Keep the cost display **on by default but clearly marked**, with a setting to
  hide it entirely for users who find it noise.

---

## UX Details

### Steps panel — `WorkflowStep.tsx`

Keep the vertical context bar exactly as-is (it is the row's primary visual and
already tight on space). Cumulative usage is **tooltip-only by default**, and
becomes visible in exactly one case:

- **`compactionCount > 0` and a usable total exists → render the total (`410k`)
  beside the percentage.**
- `compactionCount === 0` → tooltip only, no label.

The gate is compaction, not a size heuristic, because compaction is precisely
the event that severs the bar's meaning: the window is emptied mid-attempt, so
the final percentage reads _low_ on the attempt that consumed the _most_. A
visible total there is not decoration — it is the indicator that the context
bar no longer reflects what this step actually cost, and its presence alone
tells the user a compaction happened. Absent compaction the bar and the total
tell the same story, and a second number would be noise.

This also means the label must be driven by `TokenStats.compactionCount`, not
by comparing `total` against `contextWindowUsed`. Do not substitute a magnitude
heuristic if the compaction count is unavailable for a harness — stay silent
instead, because a visible total that does _not_ imply compaction destroys the
signal for every harness that does report it.

```text
Current context window: 10.0k / 200.0k (5%)
Attempt total: 410.0k tokens (Claude reported)
  8.0k input · 12.0k output · 390.0k cache read
Estimated: ≈$0.41 at API list prices
Compactions: 2
```

The mobile `PromptChipRail` (via `useContextPct`) stays percentage-only — there
is no room, and the output row covers it.

### Output stats row — `OutputRow.tsx` `StatsRowView`

Visible parts, pipe-separated, in this order:

```text
Context: 10.0k/200.0k (5%) | Total: 410.0k | ≈$0.41 | Compacted 2x
```

- When there is no current-window data, lead with the token breakdown as today.
- When only compaction count is known: `Tokens: 8k in / 2k out / 10k total | Compacted 2x`.
- When unpriceable, omit the cost part entirely — never `$0.00`.
- Move the input/output/cache breakdown out of hover-only into the tooltip
  _plus_ keep the headline answerable at a glance. The visible row answers "how
  much"; the tooltip answers "made of what".

### CLI — `CliTerminalFormatter.renderStats`

Mirror the same terminology and ordering so CLI and dashboard users describe the
same numbers the same way:

```text
Context: 10.0k/200.0k (5%)  Total: 410.0k  ≈$0.41  Compacted 2x
```

### Workflow list — `WorkflowList.tsx` + `RunningWorkflowItem.tsx`

Show the addressed run's `WorkflowTokenTotals`:

- Recent rows show the total for the row's current/latest run.
- Running rows show the live observed-so-far total. `WorkflowList.tsx` delegates
  those to `RunningWorkflowItem.tsx`; update both — the two row kinds must not
  diverge.
- Add a dedicated usage slot to `WorkflowRowLayout.tsx` so totals align
  vertically in flat rows and join the second metadata line at the `stacked`
  tier.
  The current tracks are harness, label, count, glyph, badge, and time; the usage
  slot goes between count and glyph.
- Add the new track to `WORKFLOW_ROW_TRACKS` in
  `src/ui/webview-react/constants.ts:106-136` and re-derive the responsive tier
  thresholds from it. Sizing lives there, not in CSS — a track widened in CSS
  alone silently collapses the name column. Budget ~56px (fits `≥1.2M`).
- At the `compact` tier, drop the usage slot rather than shrink the name column.
- Formatting via the shared formatter: complete `410k`; partial `≥410k`; absent
  renders nothing.
- Accessible row name carries the full phrase: `410,000 total tokens` or
  `at least 410,000 observed tokens`.
- Tooltip explains coverage, whether the value is still increasing, and cost
  when known.
- Run cost uses `≈$0.41` only when complete; `costPartial: true` renders
  `≥$0.41` and the tooltip states that one or more attempts were unpriceable.
- Never label a partial or unavailable value as a comparable exact total.

### Run list — `RunSummaryRow.tsx`

Once `RunSummary` carries `tokenTotals`, render the same slot with the same
formatter. This is where per-run harness comparison actually happens (same
lineage, different runs), so it is worth doing in the same pass as the workflow
list rather than deferring.

---

## Implementation Phases

### Phase 1: Stop losing the numbers we already have

- [ ] Widen `TokenStats` with `total`, `reasoning`, `compactionCount`,
      `compactedContextTokens`, `totalConfidence`.
- [ ] Add `TOKEN_TOTAL_CONFIDENCE` and `WORKFLOW_TOKEN_COVERAGE` to
      `DashboardConstants.ts`.
- [ ] Correct the `TokenUsage.inputTokens` / `totalTokens` contract comments;
      add provenance fields and narrow `OutputMetadata.harness` to `HarnessId`.
- [ ] Make `WorkflowExecutor.resolveTokenCounts` lossless.
- [ ] Summarize compaction events at that same conversion boundary.
- [ ] Add pure token/total/accessible-label helpers to
      `src/utils/TokenFormatting.ts`, consumable by both CLI and webview
      (`@root/utils/...`); keep `calcContextPct` in the webview's
      `tokenUtils.ts`. Do not fork formatting logic by surface.
- [ ] Render total + breakdown in `StatsRowView` and `CliTerminalFormatter`.
- [ ] Expose the total in the `WorkflowStep` tooltip without changing the bar,
      and render the visible total **only** when `compactionCount > 0` and a
      usable total exists.
- [ ] React tests: context-only, total-only, compacted (label visible),
      uncompacted-with-large-total (label absent), and
      compaction-count-unavailable (label absent) cases.

### Phase 2: Close the harness gaps

- [ ] Copilot: accumulate input tokens per chat span
      (`CopilotLogParser.ts:214-222`) and report cumulative input from
      `getFinalOtelUsage`; when no OTel chat span was seen, emit no total and let
      run coverage become partial/unavailable rather than manufacturing zero.
- [ ] Antigravity: let the statusline snapshot win for context-window fields
      only, and stream-json `result.usage` win for billing totals
      (`AntigravityLogParser.ts:946-1000`).
- [ ] Capture OpenCode `tokens.reasoning` and `tokens.cache.write`.
- [ ] Stamp OpenCode output with `HARNESS_IDS.OPENCODE_CLI` and ensure all six
      completed AI outputs retain harness/model attribution.
- [ ] Preserve Codex `total_token_usage.total_tokens` and carry
      `reasoning_output_tokens` through to `TokenStats`.
- [ ] Unit tests per harness asserting cumulative-vs-last-turn separation.

### Phase 3: Run aggregation

- [ ] Add the pure run-scoped `WorkflowTokenTotalsReducer` over
      `TIMELINE_ATTEMPT_KINDS.AI` attempts, keyed by
      `(target, runIndex, attemptIndex, phase)`, with `byHarness` and
      `byLocalDay` breakdowns; own/hydrate it per active manifest in
      `OutputHistoryManager`.
- [ ] Persist `WorkflowTokenTotals` into `WorkingFileRuntime` and the run
      manifest; bump the timeline schema version and project into `RunSummary`.
- [ ] Thread the live value through `PromptQueue` / `IWorkingFileQueueAccess` /
      `WorkingFileManager`, and through both VS Code-managed and CLI-watch
      `WorkflowSummary` paths so later runtime writes cannot erase it.
- [ ] Publish rolling totals via `WorkflowSummary`, durable totals via
      `RECENT_WORKFLOWS`.
- [ ] Add the usage slot to `WorkflowRowLayout.tsx`, `WORKFLOW_ROW_TRACKS`, and
      both row kinds; render in `RunSummaryRow.tsx`.
- [ ] Update collapsed output groups to show the all-attempt sum with an
      explicit `N attempts` label; expanded rows retain per-attempt totals.
- [ ] Tests: streaming replacement, retry/manual-rerun inclusion, partial
      coverage, dynamic-step inclusion, run isolation, local-midnight
      partitioning, `byHarness === sum(byLocalDay)`, duplicate/fork runtime
      stripping, same-run reopen/final transitions, and workflow-list refresh
      not reading `events.jsonl`.
- [ ] Workflow-list tests at flat, stacked, and compact tiers for complete,
      partial, running, and unavailable totals.

### Phase 4: Cost

- [ ] Add `src/utils/ModelPricing.ts` with per-harness price tables, `sourceUrl`
      and `verifiedOn` per entry.
- [ ] Add attempt-cost source/confidence/note constants to
      `DashboardConstants.ts`, including explicit unavailable-reason constants;
      no cost flow-control string stays inline.
- [ ] Add the per-harness token-semantics descriptor (cache subset? reasoning
      included/disjoint/unknown?) as one typed `const` keyed by `HarnessId`.
- [ ] Verify the cache-subset and reasoning relationships for Codex, Qwen,
      OpenCode, and Antigravity against live runs; correct the table above and
      leave table pricing disabled for every `unknown` entry.
- [ ] Parse `claude-cli` `total_cost_usd` / `modelUsage` and `opencode-cli`
      `part.cost`; cross-check Claude's value against the table, prefer the
      table on >2x divergence, note the substitution in the tooltip, and log the
      discrepancy.
- [ ] Compute and render attempt cost + run cost with source-aware labelling
      from `costSources`; suppress dollars for `copilot-cli`.
- [ ] Add the `ctrlyoke.modelPricing` override setting and a hide-cost setting.
- [ ] Plumb both settings through `package.json`, `CtrlYokeSettings.ts`,
      `CtrlYokeConfigService`, and `ConfigurationUtils`; use a
      `USER_OVERRIDE` cost source.
- [ ] Tests: subset vs disjoint cache math, reasoning double-count guard,
      unknown-model omission, and harness-reported-vs-table divergence.

---

## Recommended Combined Staging Order

This is the canonical order for this plan and
`HARNESS_USAGE_TRACKING_PLAN.md`. Keep stages independently buildable and do not
start a second token-ingestion pipeline while the contracts are in flight.

1. **Token contracts and lossless mapping** — Phase 1 types/constants,
   `TokenUsage` contract corrections, `resolveTokenCounts`, confidence, shared
   formatting, and attempt-level UI/CLI tests.
2. **Harness correctness and immutable attribution** — Phase 2 Copilot,
   Antigravity, Codex, and OpenCode fixes plus compaction summarization and
   per-harness parser tests.
3. **Run aggregation and durability** — canonical attempt identity,
   `byHarness`/`byLocalDay`, queue/working-file/manifest ownership, schema bump,
   reopen/final semantics, `RunSummary`, recent-workflow and CLI-watch
   projections.
4. **Run-total UX** — workflow/run rows, responsive usage slot, accessibility,
   and complete/partial/running/unavailable tests. At this point the prompt plan
   delivers useful value on its own.
5. **Observed harness-usage baseline** — add usage contracts/service and the
   idempotent workspace rollup fed only from terminal run aggregates'
   `byLocalDay` values (`byHarness` is the invariant cross-check); render
   observed-only cards.
6. **Provider quota collectors** — implement the Codex app-server spike/fallback
   and Claude statusline collector, normalized snapshot persistence, refresh
   command/messages, redaction, and stale handling.
7. **Pre-launch selection assist** — near-limit warnings based only on fresh
   provider percentages, followed by conservative fallback suggestions.
8. **Cost estimation** — do pricing after empirical token-semantics gates pass;
   then let later terminal-run upserts enrich observed rollups with cost.
9. **Optional provider expansion** — Copilot structured-quota research,
   Antigravity quota research, and enterprise/admin integrations. None blocks
   the MVP stages above.

Recommended review/commit boundaries are the numbered stages. If a stage is too
large, split backend/contracts from rendering/tests, but preserve the order.

---

## Edge Cases

- Track totals per attempt; do not merge attempts into one visible number unless
  the label says "all attempts".
- The workflow total intentionally sums all retry and manual-rerun attempts,
  even when the step row emphasizes only the latest.
- Final steps use the same fields as normal prompt steps.
- Script steps show no AI token totals.
- Streaming updates may show partial totals; the completed output replaces them.
- Compaction without token counts → show the count, estimate nothing.
- If a provider's cumulative total resets after compaction, mark
  `totalConfidence: PARTIAL` — do not paper over it with a derived estimate.
- Unknown attempt usage makes the run aggregate partial, never zero.
- Editing a completed run into a draft does not carry the prior run's total
  forward. Duplicate/Fork copy authored definitions, never usage.
- A model missing from the price table suppresses cost for that attempt and
  marks the run's `costPartial: true` — it must not silently price at $0.
- A same-run continuation keeps prior attempts, sets `isFinal: false` while
  active, and upserts one new final snapshot; it never creates a second observed
  usage contribution for the same run.
- If an AI output lacks a valid harness ID, include its known tokens in the
  whole-run total, mark coverage partial, and omit it from `byHarness` and
  `byLocalDay` rather than guessing.

---

## Relationship To Harness Usage Tracking

This plan is the per-run half; `HARNESS_USAGE_TRACKING_PLAN.md` is the
cross-session half.

- Here: per-attempt usage and cost for one ctrlyoke workflow step, rolled into
  one run total for list display.
- There: cross-session provider quota, observed usage rollups, billing/limit
  windows.

The persisted `WorkflowTokenTotals.byLocalDay` values from this plan are the
**only** input the usage plan's calendar-bucketed `ctrlyoke-observed` source
should use; `byHarness` is the run-level cross-check. Do not rescan Claude
transcripts, Copilot OTel, or `events.jsonl` in that plan.

The canonical cross-plan staging sequence is
[Recommended Combined Staging Order](#recommended-combined-staging-order).

---

## Open Questions

Resolved since the last revision:

- ~~Which harnesses can provide cumulative totals when their source records are
  present?~~ All six can after the Copilot input-accumulation fix; absent or
  malformed records still produce partial/unavailable coverage.
- ~~Should the headline use provider `total_tokens` or a billing-adjusted sum?~~
  Provider `total_tokens` for the headline; billing adjustment happens only
  inside the cost calculation, where the cache-subset rules apply.
- ~~Where does raw price data come from?~~ Harness-reported first, then a
  curated `ModelPricing.ts`; LiteLLM's file as a refresh cross-check only.

Decided August 8, 2026 — implement these as written; do not relitigate:

1. **Steps panel visibility → compaction-gated.** The total is tooltip-only
   except when `compactionCount > 0`, where it renders visibly beside the
   percentage. See [Steps panel](#steps-panel--workflowsteptsx) for why the gate
   is the compaction event and not a magnitude heuristic.
2. **Retries in collapsed output groups → both, by level.** A collapsed group
   shows the all-attempt sum, because that is what the step actually consumed.
   Expanding reveals per-attempt totals. The collapsed label must say so
   (`3 attempts · 410k total`) so the sum is never mistaken for one attempt.
3. **Claude `total_cost_usd` trust → prefer the table on divergence, mark it,
   log it.** Compute both, use the harness-reported value when they agree within
   ~2x, otherwise fall back to the price-table figure, note the substitution in
   the tooltip (not the headline — the headline stays a single number), and log
   the discrepancy. Silent substitution is wrong because it hides an upstream
   regression; showing both numbers is wrong because it asks the user to
   adjudicate a bug they cannot see.
4. **Cost display default → on, labelled.** Always with its source/equivalent
   qualifier, with a setting to hide it. A hidden estimate answers nobody's
   question.
5. **Codex / Qwen / OpenCode / Antigravity token semantics → verify before
   table pricing.** Until cache and reasoning relationships are empirically
   confirmed for a harness, its table-derived cost is omitted. OpenCode's own
   `part.cost` remains usable because it does not depend on ctrlyoke's formula.

Genuinely still open:

- Nothing blocking. Phase 4 carries research tasks (the cache-semantics
  verifications above), but no design decision is outstanding.

Workflow aggregate semantics are **not** open: every incurred attempt belongs in
the run total, partial coverage is labelled as a lower bound, and totals never
span runs.

---

## Acceptance Criteria

- Current context, cumulative attempt usage, and cumulative run usage remain
  three distinct concepts in contracts, labels, and tooltips.
- A step row shows a visible token total only when that attempt compacted and a
  usable total exists, so the label's presence is a reliable "the bar
  under-reports this step" signal.
- No conversion step between a parser and a rendered stat discards a token field
  the parser produced.
- A completed workflow row displays its run's observed total without opening the
  run; a running row updates without double-counting streaming snapshots.
- Automatic retries, manual reruns, final steps, and dynamic AI steps contribute
  exactly once per attempt.
- Collapsed retry groups label their all-attempt sum explicitly, while expanded
  output preserves each attempt's own total.
- Manual reruns and execution phases remain distinct through the canonical
  `(target, runIndex, attemptIndex, phase)` key.
- Mixed-harness runs retain exact per-harness attribution in `byHarness`; the
  observed usage store consumes no whole-run total that it cannot attribute.
- Multi-day runs retain per-harness local-day attribution, and `byHarness`
  equals the sum of `byLocalDay`.
- Partial coverage renders as a lower bound; unavailable usage never renders as
  zero, and unavailable cost never renders as `$0.00`.
- Recent rows, running rows, and run-summary rows use the same formatter,
  summary type, and layout slot.
- Workflow-list refresh reads no historical output events.
- Duplicate and fork do not copy usage into the new lineage.
- Cost is never presented as money billed on a subscription plan, and is never
  synthesized in dollars for `copilot-cli`.
- A later working-file runtime write, same-run reopen, CLI watch update, or host
  restart does not erase or double-count the aggregate.
