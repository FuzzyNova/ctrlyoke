# Prompt and Workflow Total Token Usage Plan

**Status:** Proposed  
**Created:** July 9, 2026  
**Revised:** July 28, 2026
**Related:** `HARNESS_USAGE_TRACKING_PLAN.md`, `WORKFLOW_VARIANTS_PLAN.md`

---

## Problem

ctrlyoke currently shows context-window fullness per prompt in two places:

- `src/ui/webview-react/components/prompts/WorkflowStep.tsx` renders the vertical percent bar from `contextWindowUsed/contextWindowSize`.
- `src/ui/webview-react/components/output/OutputRow.tsx` `StatsRowView` renders `Context: used/size (%)` and puts the current prompt/completion token details in the hover text.

That is accurate for the **final/current conversation state**, but misleading for long prompts that cross compaction boundaries. Example: a 200k context window fills, compacts, fills again, compacts again, then finishes with 10k tokens in the final window. The UI correctly shows `10k/200k (5%)`, but the prompt actually consumed roughly `410k` tokens across the full run.

Users need both signals:

- **Current context window usage:** "How full is the conversation right now?"
- **Total prompt usage:** "How much work did this prompt actually consume?"
- **Total workflow usage:** "How many observed tokens did this run consume
  across all of its AI attempts?"

Do not replace the current context-window display. Add a separate per-prompt cumulative usage concept.

The workflow dropdown also lacks a token total. That makes a common comparison
flow unnecessarily laborious: duplicate a workflow, select a different harness,
run both variants, then open each run and inspect its individual steps. The
latest run's observed total should be visible directly in
`src/ui/webview-react/components/workflow/WorkflowList.tsx`.

---

## Product Decision

Use total tokens as the primary user-facing metric, with compaction count as context.

Recommended UX:

1. Keep the existing context percentage bar in the steps panel unchanged.
2. Add a compact badge/tooltip when a prompt spans compactions:
   - `410k total`
   - optionally `2 compactions`
3. In the output stats row, show both concepts when available:
   - `Context: 10.0k/200.0k (5%)`
   - `Prompt total: 410.0k`
   - `Compacted 2x`
4. Tooltips should explain the split:
   - context usage is the final/current window only
   - prompt total is cumulative usage across API turns and compactions
5. Aggregate prompt-attempt totals into one run-scoped workflow total and show
   it in every workflow-list row:
   - completed recent workflow: `410k tokens`
   - active workflow: `183k tokens` with an accessible "observed so far" label
   - incomplete provider coverage: `≥183k tokens`
   - unavailable usage: omit the value or show `Tokens unavailable` in the
     tooltip; never show zero

Rationale:

- A compaction count alone is too coarse for cost and performance. Two compactions on a 200k model suggest a lower bound, but not the actual token shape or output/cached/reasoning mix.
- Total tokens can later feed effective-cost display, prompt-level analytics, and harness comparison.
- Compaction count remains useful because users understand why the context percentage dropped after a long run.
- An aligned workflow total makes lightweight harness comparison possible
  without introducing a dedicated comparison view.

---

## Data Model

Extend the existing token contracts instead of creating a separate UI-only field.

Current `TokenStats` in `src/types/WebviewMessageTypes.ts`:

```typescript
export interface TokenStats {
  prompt: number;
  completion: number;
  cached?: number;
  cacheCreated?: number;
  contextWindowUsed?: number;
  contextWindowSize?: number;
}
```

Add one shared run-scoped summary type in `src/types/CtrlYokeTypes.ts` and reuse
it from `WorkflowSummary`, `RecentWorkflowsMessage`, and the React
`RecentWorkflow` projection:

```typescript
export interface WorkflowTokenTotals {
  /** Sum of all normalized AI attempt totals observed in this run. */
  total: number;
  /** Complete only when every executed AI attempt reported a usable total. */
  coverage: "complete" | "partial";
  /** Number of AI attempts included in `total`. */
  reportedAttemptCount: number;
  /** Number of AI attempts executed, including retries and manual reruns. */
  attemptCount: number;
  /** False while the workflow can still add more usage. */
  isFinal: boolean;
}

export interface WorkflowSummary {
  // existing fields...
  tokenTotals?: WorkflowTokenTotals;
}
```

Keep this as a shared contract rather than spelling the same optional fields
independently in backend messages and UI stores. `total` is an observed token
total, not a cost estimate. When `coverage === "partial"`, it is a lower bound
and the UI must format it with `≥`.

### Workflow Total Semantics

A workflow total is scoped to one run, not the entire lineage:

- Include every executed AI attempt in the run: ordinary prompts, final steps,
  automatic retries, manual step reruns, and dynamically added AI steps.
- Count each attempt's cumulative `promptTotal.total` exactly once. Streaming
  updates replace that attempt's current snapshot; they are not summed as new
  usage.
- Exclude script steps unless a future script-backed harness reports normalized
  AI usage.
- Do not include earlier runs from the lineage.
- A draft that has never executed has no total, not a zero total.
- A running workflow exposes an observed-so-far total with `isFinal: false`.
- If any executed AI attempt lacks a usable total, preserve the known sum with
  `coverage: "partial"` rather than comparing it as complete.

For retries, the per-step UI may choose whether to emphasize the latest attempt,
but the workflow total includes every attempt because all of them consumed
tokens.

Add cumulative prompt fields:

```typescript
export interface PromptTokenTotals {
  /** Cumulative input tokens observed during this prompt attempt. */
  input: number;
  /** Cumulative output tokens observed during this prompt attempt. */
  output: number;
  /** Billing/display total. Prefer provider total when available. */
  total: number;
  /** Cumulative cache-read input tokens, when reported separately. */
  cachedInput?: number;
  /** Cumulative cache-creation input tokens, when reported separately. */
  cacheCreatedInput?: number;
  /** Cumulative reasoning output tokens, when reported separately. */
  reasoningOutput?: number;
  /** Number of compaction events observed during this prompt attempt. */
  compactionCount?: number;
  /** Sum of known pre-compaction window token counts. Best effort. */
  compactedContextTokens?: number;
  /** Whether totals came directly from provider cumulative usage or were derived. */
  confidence: "provider-cumulative" | "derived" | "partial";
}

export interface TokenStats {
  prompt: number;
  completion: number;
  cached?: number;
  cacheCreated?: number;
  contextWindowUsed?: number;
  contextWindowSize?: number;
  promptTotal?: PromptTokenTotals;
}
```

Also extend lower-level shared usage metadata in `src/types/CliOutputTypes.ts`:

```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreatedTokens?: number;
  reasoningOutputTokens?: number;
  contextWindowUsedTokens?: number;
  contextWindowSize?: number;
  promptTotalTokens?: number;
  promptTotalInputTokens?: number;
  promptTotalOutputTokens?: number;
  promptTotalCachedInputTokens?: number;
  promptTotalCacheCreatedTokens?: number;
  promptTotalReasoningOutputTokens?: number;
  promptCompactionCount?: number;
  promptCompactedContextTokens?: number;
  promptTokenTotalConfidence?: "provider-cumulative" | "derived" | "partial";
}
```

Persist durable completed-step fields in `src/types/CtrlYokeTypes.ts` runtime metadata so undo/redo, pause/resume, and history restore the same UI:

```typescript
promptTotalTokens?: number;
promptCompactionCount?: number;
promptCompactedContextTokens?: number;
```

If the detailed breakdown is needed in history/search later, persist the full prompt total object instead of only the three summary fields.

---

## Collection Strategy

### Provider-Cumulative Path

Use this when a harness already reports cumulative usage for the whole run/prompt attempt.

Known candidates:

- Codex `token_count.info.total_token_usage`
- Qwen result/usage totals
- OpenCode step token accumulation, if it already covers all API turns for the prompt
- Claude final/result usage when it represents total API usage for the prompt attempt

In this mode:

- `promptTotal.total` should use provider cumulative `total_tokens` if present.
- `contextWindowUsed` should continue to use last-turn/current-window usage.
- `confidence = "provider-cumulative"`.

### Derived Compaction Path

Use this when only final context-window usage plus compaction events are available.

Formula:

```text
prompt total estimate = sum(known compaction.preTokens) + final contextWindowUsed
```

If only the count is known, show `Compacted 2x` but do not fabricate `410k total`.

In this mode:

- `promptTotal.compactionCount` is exact when compaction events are observed.
- `promptTotal.compactedContextTokens` is set only when pre-compaction token counts are reported.
- `confidence = "derived"` when all needed counts are present.
- `confidence = "partial"` when compactions are known but token counts are incomplete.

### Event Aggregation

Maintain a per-prompt attempt usage accumulator in the harness integration layer, not in React components.

Responsibilities:

- Count `CLI_EVENT_TYPES.COMPACTION` events during the active prompt attempt.
- Sum `CompactionData.preTokens` where available.
- Merge provider usage snapshots from parser metadata.
- Emit one normalized `TokenUsage` object on prompt completion and during streaming updates when available.

React should only render the normalized fields.

### Workflow Aggregation

Add one pure workflow-token aggregator over normalized per-attempt totals. The
executor/history layer owns it; `WorkflowList.tsx` must not walk output rows or
reconstruct provider usage.

Responsibilities:

- identify attempts by stable execution target plus attempt/rerun identity;
- replace streaming snapshots for an attempt instead of double-counting them;
- include retries, final steps, manual reruns, and dynamic steps;
- track reported-versus-executed attempt coverage;
- persist the latest aggregate with the run's durable runtime summary so
  pause/resume, history reload, CLI-managed runs, and hosted clients agree;
- expose the same `WorkflowTokenTotals` through live `WorkflowSummary` and
  recent-workflow list messages.

The recent-workflow path already reads the addressed working file in
`WorkflowSerializer.getRecentWorkflows`; use the persisted aggregate from that
file rather than loading every `events.jsonl`. The running path should publish
the same aggregate from the active workflow summary.

---

## UX Details

### Steps Panel

`WorkflowStep.tsx` should continue to render the vertical context bar from `contextWindowUsed/contextWindowSize`.

Add a tiny secondary text/badge only when it adds information:

- If `promptTotal.total` exists and differs materially from final `contextWindowUsed`, show `410k`.
- If `promptTotal.compactionCount > 0`, include `2x` or `2 compactions` in the tooltip.
- Avoid crowding the row. The bar remains the primary visual; total usage can be a small label below or a compact chip beside the percentage.

Tooltip example:

```text
Current context window: 10.0k / 200.0k (5%)
Prompt total: 410.0k tokens across this attempt
Compactions: 2
```

### Output Stats Row

`StatsRowView` should render separate stat parts:

```text
Context: 10.0k/200.0k (5%) | Prompt total: 410.0k | Compacted 2x
```

When no current-window context exists, keep the existing token breakdown behavior.

When only compaction count exists:

```text
Tokens: 8k in / 2k out / 10k total | Compacted 2x
```

Do not hide prompt/completion/cache details in hover-only UI once cumulative prompt total exists. The visible row should answer the main question; the tooltip can provide the breakdown.

### CLI Terminal Formatter

Mirror the stats row in `src/cli/CliTerminalFormatter.ts` so CLI users see the same distinction:

```text
Context: 10.0k/200.0k (5%)  Prompt total: 410.0k  Compacted 2x
```

### Workflow List

Show the addressed run's `WorkflowTokenTotals` in
`src/ui/webview-react/components/workflow/WorkflowList.tsx`.

- Recent rows show the total for the row's current/latest run.
- Running rows show the live observed-so-far total. Because
  `WorkflowList.tsx` delegates those rows to `RunningWorkflowItem.tsx`, update
  that component too; the two row kinds must not diverge.
- Extend `WorkflowRowLayout.tsx` with a dedicated usage metadata slot so totals
  align vertically in flat rows and join the second metadata line in
  stacked/compact rows.
- Update the centralized row-track widths and responsive tier thresholds when
  adding the flat usage column.
- Use the existing shared token formatter:
  - complete: `410k`
  - partial: `≥410k`
  - absent: no numeric label
- Include the full phrase in the accessible row name, for example
  `410,000 total tokens` or `at least 410,000 observed tokens`.
- The tooltip explains coverage and whether the value is still increasing.
- Do not label a partial or unavailable value as a comparable exact total.

The workflow list is the initial aggregate surface. Run-summary rows, sorting,
and token filters may reuse the same contract later, but are not required for
this plan.

---

## Implementation Phases

### Phase 1: Contracts And Rendering

- [ ] Extend shared token types with cumulative prompt total fields.
- [ ] Add shared `WorkflowTokenTotals` and thread it through live workflow
      summaries, recent-workflow messages, and the React store.
- [ ] Add formatting helpers in `src/ui/webview-react/utils/tokenUtils.ts` for token counts and prompt-total labels.
- [ ] Update `OutputRow.tsx` stats row to show context, prompt total, and compaction count as distinct stats.
- [ ] Update `WorkflowStep.tsx` to expose total prompt usage without changing the current context bar semantics.
- [ ] Update `CliTerminalFormatter.ts` to use the same terminology.
- [ ] Add a dedicated workflow-total metadata slot to `WorkflowRowLayout.tsx`
      and render it from both recent and running rows in `WorkflowList.tsx`.
- [ ] Add React tests for stats-row rendering with current-window-only, total-only, and compaction cases.
- [ ] Add workflow-list tests for complete, partial, running, and unavailable
      totals at flat, stacked, and compact tiers.

### Phase 2: Harness Accumulators

- [ ] Add a shared prompt-attempt usage accumulator for compaction count and pre-token sums.
- [ ] Wire parser metadata into the accumulator so provider cumulative totals win over derived estimates.
- [ ] Persist summary fields into prompt `_runtime` metadata after completion.
- [ ] Restore prompt totals from runtime metadata in the steps panel after undo/redo and history reload.
- [ ] Add the shared workflow-token aggregator and persist its run-scoped
      summary without replaying history events for every workflow-list refresh.
- [ ] Publish rolling totals through `WorkflowSummary` and durable totals
      through the recent-workflow list.
- [ ] Add unit tests for compaction aggregation and runtime persistence.
- [ ] Add unit tests proving streaming replacement, retry/manual-rerun
      inclusion, partial coverage, dynamic-step inclusion, and run isolation.

### Phase 3: Harness-Specific Accuracy

- [ ] Codex: map `token_count.info.total_token_usage` into prompt totals and `last_token_usage` into context-window usage.
- [ ] Claude: verify whether final result usage is cumulative for the prompt attempt; otherwise derive from compact boundaries plus final context.
- [ ] OpenCode: verify whether accumulated step tokens span compactions; if not, combine with compaction events.
- [ ] Qwen: map final `usage.total_tokens` into prompt totals.
- [ ] Copilot: map any available session usage into prompt totals; otherwise show compaction count only when known.

### Phase 4: Cost Readiness

- [ ] Add optional per-model pricing metadata lookup after prompt totals are stable.
- [ ] Compute effective prompt cost from cumulative token breakdown, not context-window usage.
- [ ] Distinguish cached-input, cache-created, reasoning-output, and output pricing where harness/model metadata supports it.
- [ ] Keep cost display opt-in or clearly marked approximate when pricing is inferred.

---

## Edge Cases

- Retries should track totals per attempt, not merge all attempts into a single visible number unless the UI explicitly says "all attempts".
- The workflow total intentionally sums all retry and manual-rerun attempts,
  even when the step row emphasizes only the latest attempt.
- Final steps should use the same fields as normal prompt steps.
- Script steps should not show AI token totals unless a future script harness reports them.
- Streaming updates may show partial totals; completed output should replace them with durable totals.
- If compaction happens without token counts, display compaction count but do not estimate total token usage.
- If provider cumulative totals reset after compaction, mark confidence `partial` and fall back to compaction-derived values only when token counts are present.
- Unknown attempt usage makes the workflow aggregate partial; it must not turn
  into zero.
- Editing a completed run into a draft does not carry the prior run's total into
  the future run. Duplicate/Fork copy authored definitions, never usage.

---

## Relationship To Harness Usage Tracking

This plan is narrower than `HARNESS_USAGE_TRACKING_PLAN.md`.

- This plan: per-prompt usage for a single ctrlyoke workflow step/attempt.
- This plan also rolls those normalized prompt attempts into a single-run
  workflow total for list display.
- Harness usage plan: cross-session provider quota, observed usage rollups, and billing/limit windows.

The per-prompt totals from this plan should eventually feed the observed usage rollups from the harness usage plan. Avoid building a second storage pipeline for aggregate usage here.

---

## Open Questions

1. Should the steps panel show `410k` visibly, or only expose it in the tooltip to avoid row clutter?
2. Should total prompt usage include cache-read tokens in the headline total, or should the headline use provider `total_tokens` exactly and leave billing-adjusted totals for the future cost UI?
3. For retries, should collapsed output groups show the latest attempt total, all-attempt total, or both?
4. Which harnesses can guarantee provider-cumulative totals across compactions, and which require derived estimates?

Workflow aggregate semantics are not open: every incurred attempt belongs in
the run total, partial coverage is labeled as a lower bound, and totals never
span multiple runs.

---

## Acceptance Criteria

- Current context, cumulative prompt usage, and cumulative workflow usage remain
  distinct concepts in contracts and labels.
- A completed workflow row displays the addressed run's observed total without
  opening the run.
- A running workflow row updates its observed-so-far total without
  double-counting streaming snapshots.
- Automatic retries, manual reruns, final steps, and dynamic AI steps contribute
  exactly once per attempt.
- Partial provider coverage renders as a lower bound; unavailable usage never
  renders as zero.
- Recent and running rows use the same formatter, summary type, and responsive
  layout slot.
- Workflow-list refresh does not read every historical output event.
- Duplicate and fork operations do not copy token usage into the new lineage.
