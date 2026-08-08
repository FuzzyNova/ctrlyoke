# Harness Usage Tracking Plan

**Status:** Researched / ready for design
**Provider research:** June 15, 2026 (CLI versions checked then: Claude Code `2.1.177`, Codex CLI `0.139.0`, GitHub Copilot CLI `1.0.62`)
**Revised:** August 8, 2026 — re-aligned with current code; Antigravity added; sidecar pattern is no longer speculative; Claude collector and auto-enable confirmed
**Related:** `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`

---

## Executive Summary

ctrlyoke can provide a useful unified usage display, but the implementation
should use different collection strategies per harness:

1. **Claude Code:** status-line JSON for live quota windows during a ctrlyoke-run
   session; local transcripts for observed token/cost history; enterprise/admin
   APIs opt-in only.
2. **Codex CLI:** parse local session JSONL `token_count` events for both
   observed tokens and last-known rate-limit windows; no standalone
   `codex status` command existed in the checked version.
3. **GitHub Copilot CLI:** OTel spans (already wired in ctrlyoke) for observed
   token usage; personal monthly AI credit balance appears only in GitHub UI and
   the CLI TUI — no documented personal REST/GraphQL quota API was found.
4. **Antigravity, OpenCode, Qwen:** ctrlyoke-observed usage only.

The MVP is **observed usage plus last-known provider quota**. Do not fabricate
exact remaining quota when the provider exposes only session-local or UI-only
data.

### The motivating outcome

The feature exists to answer one question before a run starts: **"do I have
enough quota left to launch this queue?"** — e.g. warning the user before
kicking off a 20-step workflow on a nearly-exhausted Claude five-hour window.
That is the payoff, not the usage cards; the cards are how the data gets
inspected once collected. Treat the near-limit warning in Phase 5 as the
deliverable the earlier phases exist to enable, and do not value-engineer the
provider-quota collectors down to observed-only token counters — observed
tokens alone cannot answer the question, because they do not know the limit.

This also settles the scope boundary between the two plans:
**usage limits ≠ token totals.** Knowing a run consumed 410k tokens says
nothing about how much of a five-hour subscription window remains. They are
independent signals with independent sources, and neither substitutes for the
other.

---

## What Changed Since The June Research

The research findings below still hold; what changed is ctrlyoke's own code, and
that changes the build plan materially:

- **The status-line sidecar pattern is already shipped.**
  `src/core/harness/antigravity/AntigravityStatuslineSidecar.ts` generates a
  statusline command, has the harness write JSON snapshots to a ctrlyoke-owned
  path, polls for a changed `_ctrlyoke.sequence` / `writtenAt` marker, and feeds
  the parsed snapshot into the live context-window pipeline. The proposed
  `ClaudeUsageProvider` status-line collector should be modelled directly on it
  rather than designed from scratch — and the shared parts (snapshot path
  allocation, marker-based change detection, teardown) belong in
  `src/core/harness/shared/` so the second implementation forces the extraction.
- **Copilot OTel is already implemented.** `CopilotLogParser` sets
  `COPILOT_OTEL_ENABLED` / `COPILOT_OTEL_FILE_EXPORTER_PATH` and reads
  `gen_ai.usage.input_tokens` / `output_tokens` off each `chat <model>` span
  incrementally during execution (`CopilotLogParser.ts:116-237`). The
  "Copilot CLI observed-usage collector" in Phase 3 is therefore mostly wiring an
  existing signal into the usage store, not new parsing.
- **Antigravity is a first-class harness now** and was missing from this plan
  entirely. The six harnesses are `HARNESS_IDS` in
  `src/types/DashboardConstants.ts`; "Gemini" in the old adapter list was not one
  of them and has been removed.
- **Observed usage has a real upstream source.**
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md` defines normalized per-attempt
  `TokenStats` totals and a per-run `WorkflowTokenTotals` aggregate persisted in
  the run's working file and manifest. `HarnessObservedTokens` must be summed
  **from those**, not from a second parse of `events.jsonl`. That plan is a hard
  prerequisite for this one's Phase 1.
- **Cost estimation moved.** Per-attempt and per-run dollar estimates, the model
  price table, and the cache-subset billing rules now live in
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`. This plan consumes those numbers for its
  rollups and does not define its own pricing.

---

## Research Findings

### Claude Code

Confirmed surfaces:

- `claude --help` lists `-p/--print`, `--output-format json|stream-json`,
  `--no-session-persistence`, `--max-budget-usd`, `--session-id`, `--resume`.
- `claude auth status` is machine-readable JSON reporting login/auth/subscription
  state, but includes account identifiers that must be redacted if logged.
- Official commands docs list `/usage`; `/cost` and `/stats` are aliases. It
  shows session cost, plan usage limits, activity stats, and breakdowns by
  skill/subagent/plugin/MCP on paid plans.
- `claude -p "/usage" --output-format json --max-turns 1` exits quickly with zero
  API turns and zero cost, but returned only a short subscription message — not
  quota bars or reset windows. Do not rely on it as the usage data source.
- Status-line docs are the best live source: a configured status-line command
  receives JSON on stdin with `cost`, `context_window`, and
  `rate_limits.five_hour` / `rate_limits.seven_day`. `rate_limits` appears only
  for Claude.ai subscribers after the first API response, and each window can be
  absent.
- Local transcripts under `~/.claude/projects/<project-key>/*.jsonl` include
  assistant records with `message.usage` (input/output/cache token fields), model,
  service tier, timestamps, cwd, version, session ID. Reliable for observed
  usage, not authoritative remaining quota.
- The stream-json `result` event carries `total_cost_usd` and a per-model
  `modelUsage` breakdown — consumed by `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`, with
  the known ~10x over-reporting caveat documented there.
- Claude Agent SDK exposes per-run cost/usage accounting but not personal
  subscription quota remaining.
- Anthropic Admin APIs exist for usage/cost, rate limits, and Claude Code
  analytics, but require admin/API-key contexts — not a default Claude Pro path.

Implementation implications:

- Add a **Claude status-line collector** built on the Antigravity sidecar
  pattern: generate a tiny status-line command that writes the JSON payload to a
  ctrlyoke temp path, poll for marker changes, parse, discard the raw file.
  Scope it to sessions ctrlyoke starts, enabled automatically (see Open
  Questions), and release the settings lease on teardown — including after a
  crashed host, which is why the Antigravity implementation's dead-owner
  recovery is part of what gets extracted rather than reinvented.
- Parse `rate_limits.five_hour.{used_percentage,resets_at}` and
  `rate_limits.seven_day.{used_percentage,resets_at}` for provider quota.
- Parse transcript JSONL for observed history, deduplicating repeated assistant
  `message.id` values — Claude transcripts emit multiple content records per API
  response.
- Use `claude auth status` only for capability/auth state, with strict redaction.
- Do not parse the human `/usage` screen as the primary integration.

Confidence: high for status-line/transcript paths; medium for using status-line
as a background quota probe, since rate limits only appear after a live API
response.

### Codex CLI

Confirmed surfaces:

- `codex --help` listed no `status` top-level command in `0.139.0`.
- `codex login status` reports authentication mode only.
- `codex doctor --json` emits redacted install/auth/config/state diagnostics, no
  quota.
- `codex exec --json` exists for machine-readable non-interactive runs.
- Local `~/.codex/sessions/**/rollout-*.jsonl` files contain `event_msg` entries
  of payload type `token_count` with:
  - `info.total_token_usage`, `info.last_token_usage`, `info.model_context_window`
  - `rate_limits.primary.{used_percent,window_minutes,resets_at}`
  - `rate_limits.secondary.{used_percent,window_minutes,resets_at}`
  - `rate_limits.plan_type`, optional `credits`
- Sampled records showed a 300-minute primary window and a 10080-minute secondary
  window.
- `~/.codex` also holds `history.jsonl`, `logs_2.sqlite`, `state_5.sqlite`,
  `models_cache.json`. Rollout JSONL is easier and less invasive than SQLite.

Implementation implications:

- **ctrlyoke already parses the token half of this shape.**
  `CodexLogParser.ts:230-250` reads `token_count.info.total_token_usage`,
  `last_token_usage`, and `model_context_window`. The usage provider needs the
  sibling `rate_limits` object from the same event — extend the existing parse
  site rather than adding a second reader over the same file.
- Treat `rate_limits.primary` / `.secondary` as **last-known** provider quota,
  refreshed whenever Codex emits token-count events, not an always-fresh global
  status.
- Map primary/secondary into normalized rolling/weekly windows by
  `window_minutes`.
- Do not shell out to `codex exec "/status"` as a quota probe — it would consume
  quota and may not produce stable machine-readable status.
- `logs_2.sqlite` is a later optional investigation only; rollout JSONL already
  carries the needed fields.

Confidence: high for local session-log parsing after Codex activity; high that no
standalone `codex status` existed in the checked CLI; medium on long-term
stability of the internal rollout schema.

### GitHub Copilot CLI

Confirmed surfaces:

- `copilot --help` lists a `billing` help topic.
- `copilot help billing` says: the footer continuously shows remaining AI credit
  budget (or remaining premium requests on legacy billing); `/statusline`
  supports `ai-credits` (monthly) and `ai-used` (session); legacy billing can use
  `quota`; `/usage` shows session AI credit usage, token breakdown, and
  usage-limit progress; `/context` shows context-window token usage.
- `copilot -p "/usage" --output-format json --stream off` could not be validated
  in the research environment — an auth/network failure, not evidence the command
  cannot work.
- GitHub docs describe current individual monthly AI credit allowances: Pro
  `1,500`, Pro+ `7,000`, Max `20,000`, with 1 AI credit = $0.01.
- GitHub REST Copilot metrics endpoints are org/enterprise oriented and require
  org/enterprise permissions. Older metrics endpoints closed April 2, 2026 in
  favor of usage metrics reports.
- No documented personal REST/GraphQL endpoint for "my remaining monthly AI
  credits" was found.
- VS Code's authentication API can obtain GitHub sessions with consent, but no
  public VS Code API exposes Copilot quota from the Copilot extension.

Implementation implications:

- **Observed usage is already available**: the OTel file exporter wired in
  `CopilotLogParser` emits per-`chat` span `gen_ai.usage.*` attributes during
  execution. Feed that through the shared attempt totals rather than adding a
  Copilot-specific usage parser.
- Copilot is the one harness where **tokens are not the billing unit**. Its usage
  card should show AI credits (or premium requests on legacy billing) as the
  headline and tokens as secondary. Do not synthesize a dollar figure from token
  counts for Copilot.
- Investigate a **Copilot status-line collector** only if `/statusline
  ai-credits ai-used` can emit structured data. The help topic confirms item
  names, not a public JSON schema.
- For personal account quota, prefer: an "Open GitHub usage dashboard" link;
  local/session usage; last-known CLI TUI data when available. Avoid undocumented
  GitHub private endpoints.
- Add optional enterprise/org metrics integration only when a user supplies an
  authorized token and explicitly chooses org/enterprise scope.

Confidence: high for CLI TUI/session surfaces; high that documented REST APIs are
admin/org oriented; medium-high that no documented personal credit API exists.

### Antigravity CLI

Not covered by the June research; added here from ctrlyoke's own implementation.

- The statusline sidecar (`AntigravityStatuslineSidecar.ts`) already receives
  periodic JSON snapshots containing `context_window.{total_input_tokens,
  total_output_tokens, context_window_size, current_usage}` plus model
  identity. Snapshots carry a ctrlyoke-written `_ctrlyoke.{sequence,writtenAt}`
  marker used for change detection.
- Stream-json `result.usage` provides real billing-shaped totals
  (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`,
  `total_tokens`).
- **No quota/rate-limit fields have been observed** in either surface. Until one
  is found, Antigravity is `ctrlyoke-observed` only.
- Open research task: inspect a full statusline snapshot for any plan/quota
  fields before assuming none exist — ctrlyoke currently reads only the
  `context_window` subtree and would discard anything else silently.

### OpenCode CLI / Qwen CLI

Observed-only. OpenCode additionally self-reports per-step USD cost
(`step_finish.part.cost`), which the observed rollup should carry through as
authoritative spend for that harness rather than re-deriving it from tokens.

### Existing VS Code Extensions

Searches for "Copilot quota", "Copilot usage", "premium requests", "Claude
usage", and "Codex status" found no mature unified quota panel. Absence of
evidence is not proof, but ctrlyoke has a strong product reason to own this
because harness choice is already part of workflow execution.

---

## Product Shape

Add a compact **Usage** surface near existing harness controls:

- A chip on the harness quick picker in `src/ui/webview-react/components/editor/EditorFooter.tsx`
  (which already hosts `HarnessQuickPicker.tsx`): `63% 5h`, `24% week`,
  `observed only`, `needs auth`, or `stale`.
- Usage cards in the global settings drawer's harness page,
  `src/ui/webview-react/components/settings/HarnessesSection.tsx` — one card per
  harness, beside the existing per-harness configuration it already renders.
- Command: `ctrlyoke: Refresh Harness Usage`.
- Optional command: `ctrlyoke: Open Provider Usage Dashboard`.

Each harness card shows:

- provider display name
- data source: `provider-live`, `provider-log`, `ctrlyoke-observed`,
  `enterprise-api`, or `unavailable`
- freshness timestamp
- active windows, if known, and reset time, if known
- observed ctrlyoke token totals for today/week/month
- observed spend, where a harness self-reports it or a model price is known
- last safe error code

Usage lookup must never block workflow execution.

---

## Data Model

Create a normalized usage contract in `src/types/UsageTypes.ts`:

```typescript
export type HarnessUsageSource =
  | "provider-live"
  | "provider-log"
  | "ctrlyoke-observed"
  | "enterprise-api"
  | "unavailable";

export type HarnessUsageWindowKind =
  | "rolling"
  | "daily"
  | "weekly"
  | "monthly"
  | "unknown";

export interface HarnessUsageWindow {
  kind: HarnessUsageWindowKind;
  label: string;
  used?: number;
  limit?: number;
  remaining?: number;
  percentUsed?: number;
  resetAt?: number;
  windowMinutes?: number;
  unit: "tokens" | "credits" | "requests" | "percent" | "unknown";
  confidence: "exact" | "approximate" | "last-known";
}

export interface HarnessObservedTokens {
  input: number;
  cachedInput?: number;
  cacheCreated?: number;
  output: number;
  reasoningOutput?: number;
  total: number;
  /** Summed attempt cost where priceable. See PROMPT_TOTAL_TOKEN_USAGE_PLAN. */
  costUsd?: number;
  /** True when at least one attempt in the window had no usable total. */
  partial?: boolean;
  since: number;
}

export interface HarnessUsageSnapshot {
  harnessId: HarnessId;
  source: HarnessUsageSource;
  fetchedAt: number;
  staleAfterMs: number;
  windows: HarnessUsageWindow[];
  observedTokens?: HarnessObservedTokens;
  planType?: string;
  message?: string;
  errorCode?: string;
}
```

Note the string-union fields above are display metadata, not flow control. Any
value compared with `===` or switched on belongs in `DashboardConstants.ts` as a
`const` object per the project's coding principles — including
`HARNESS_USAGE_SOURCES` and the window kinds.

Model **multiple windows**: Claude exposes five-hour and seven-day windows via
status line, Codex session logs expose primary/secondary, Copilot may expose
monthly credits alongside session usage.

`HarnessObservedTokens` fields map one-to-one onto the normalized `TokenStats`
from `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`. Keep them aligned; a divergence means
two different answers to "how many tokens did I use" in the same product.

---

## Architecture

### 1. HarnessUsageService

Add `HarnessUsageService` under `src/core/harness/shared/usage/`.

Responsibilities:

- maintain an in-memory cache keyed by harness ID
- debounce refreshes
- expose `refreshHarnessUsage(harnessId)` and `refreshAllHarnessUsage()`
- merge provider snapshots with ctrlyoke-observed token stats
- emit dashboard updates
- never write account-specific details to logs

### 2. Provider Adapters

```typescript
export interface IHarnessUsageProvider {
  readonly harnessId: HarnessId;
  refreshUsage(signal?: AbortSignal): Promise<HarnessUsageSnapshot>;
}
```

Adapters, one per `HARNESS_IDS` entry — every adapter declares
`implements IHarnessUsageProvider` explicitly:

- `ClaudeUsageProvider` — status-line sidecar for live windows; transcript parser
  for observed history.
- `CodexUsageProvider` — rollout JSONL `rate_limits` for provider-log windows,
  reusing the existing `token_count` parse site.
- `CopilotUsageProvider` — OTel-derived observed usage; optional
  status-line/TUI research path; GitHub dashboard link fallback.
- `AntigravityUsageProvider` — observed-only until a quota field is found in the
  statusline snapshot.
- `ObservedOnlyUsageProvider` — OpenCode and Qwen. OpenCode passes through its
  self-reported per-step USD cost.

### 3. Observed Usage Store

Persist a small workspace-local rollup in `.ctrlyoke/.usage/observed-usage.json`,
fed by the per-run `WorkflowTokenTotals` written at run completion. This is not a
quota source — it records what ctrlyoke launched or safely observed locally.

Bucket by local day/week/month at write time so reads never scan runs.

### 4. Webview Messages

Add message constants `REQUEST_HARNESS_USAGE`, `REFRESH_HARNESS_USAGE`,
`HARNESS_USAGE_UPDATED`:

```typescript
export interface HarnessUsageUpdatedMessage {
  type: typeof MESSAGE_TYPES.HARNESS_USAGE_UPDATED;
  snapshots: HarnessUsageSnapshot[];
}
```

---

## Implementation Phases

**Prerequisite:** Phases 1–3 of `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`. Without
normalized per-run totals there is nothing correct to roll up, and building a
parallel token pipeline here would be the exact duplication both plans warn
against.

### Phase 1: Observed Usage Baseline

- [ ] Add `UsageTypes.ts` and the matching constants in `DashboardConstants.ts`
- [ ] Add `ObservedHarnessUsageStore`, fed by run-completion `WorkflowTokenTotals`
- [ ] Render usage cards in `HarnessesSection.tsx` showing observed totals
- [ ] Tests for rollup bucketing, corrupt-file recovery, and stale snapshots

### Phase 2: Claude And Codex Provider Signals

- [ ] Extract the shared sidecar mechanics out of
      `AntigravityStatuslineSidecar.ts` into `src/core/harness/shared/`
- [ ] Add `ClaudeUsageProvider` + a generated Claude status-line command built on
      the extracted sidecar; parse `rate_limits`
- [ ] Parse Claude transcript JSONL with assistant-message deduplication
- [ ] Add `CodexUsageProvider`; read `rate_limits` at the existing `token_count`
      parse site
- [ ] Map Codex primary/secondary windows to normalized kinds by `window_minutes`
- [ ] Redaction tests for `claude auth status`

### Phase 3: Copilot Usage

- [ ] Route existing OTel span usage into the observed store
- [ ] Investigate whether `/statusline ai-credits ai-used` can emit structured
      data or only TUI text
- [ ] Show AI credits (not dollars) as Copilot's headline unit
- [ ] Add a GitHub usage dashboard link for personal accounts
- [ ] Optional enterprise/org metrics integration behind explicit auth + scope
      prompts

### Phase 4: Antigravity Research

- [ ] Dump a full statusline snapshot and check for plan/quota fields beyond the
      `context_window` subtree ctrlyoke reads today
- [ ] Promote Antigravity from observed-only if a quota surface exists

### Phase 5: Selection Assist — the motivating outcome

- [ ] Near-limit warnings before starting a large queue: compare queue size
      against the harness's freshest quota window and warn when the window is
      nearly exhausted. Warn, never block — the user may knowingly want to burn
      the remainder, and a stale or absent window must not gate execution.
- [ ] Say which window triggered the warning and when it resets; a bare "low
      quota" is not actionable.
- [ ] Suppress the warning entirely when the snapshot is `unavailable` or stale
      past `staleAfterMs`, rather than guessing.
- [ ] Fallback harness suggestions based on stale/fresh usage data
- [ ] User-configurable preferred fallback order

---

## Security And Privacy

Non-negotiables:

- Do not store raw `/usage`, `/status`, status-line payloads, auth status output,
  or provider transcripts.
- Do not log emails, org IDs, org names, account IDs, access tokens, session
  tokens, or billing identifiers.
- Store only normalized numbers, reset timestamps, source/freshness, and generic
  status/error codes.
- Keep observed usage workspace-local by default.
- Do not request broad GitHub scopes for Copilot usage.
- Never call a model-consuming command as an automatic quota probe.

Potential setting:

```json
"ctrlyoke.usageTracking": {
  "enabled": true,
  "providerRefreshEnabled": true,
  "persistObservedUsage": true,
  "enterpriseUsageApisEnabled": false
}
```

---

## Open Questions Left

Decided August 8, 2026:

- **Keep the Claude status-line collector.** Quota-window visibility and the
  pre-queue near-limit warning are wanted features, and the status line is the
  only machine-readable source for `rate_limits` — verified empirically, not
  just from docs: a scan of 25 local transcripts found no `five_hour` /
  `seven_day` / `resets_at` fields anywhere, and `claude -p "/usage"
  --output-format json` returns only a subscription blurb. The sidecar earns its
  cost (a leased key in the user's global Claude settings, with dead-owner
  recovery) because nothing else answers the question.
- **Enable Claude status-line capture automatically for ctrlyoke-started Claude
  sessions**, matching the Antigravity sidecar precedent, on the condition that
  no raw payload is ever persisted — only normalized numbers, per Security And
  Privacy below. No separate opt-in prompt; the existing usage-tracking setting
  is the off switch.
- **Treat Codex `token_count.rate_limits` as best-effort internal parsing**, not
  a stable contract. Parse defensively, tolerate absent or renamed fields, and
  degrade that harness to `ctrlyoke-observed` rather than erroring when the
  shape drifts. The same rule applies to the Claude status-line schema.

Still open:

1. Can Copilot `/statusline ai-credits ai-used` be captured as structured data,
   or only as TUI text?
2. Should observed usage be workspace-local only, or should users opt into a
   user-level aggregate across workspaces? (Workspace-local is the Phase 1
   default either way; this only decides whether the opt-in exists.)
3. Does Antigravity expose any quota field at all? Unknown until Phase 4.
4. Do the June-2026 CLI findings still hold on current CLI versions? Re-verify
   the Claude status-line schema and the Codex rollout shape before Phase 2 —
   both are internal formats with no stability guarantee.

---

## References

- Claude Code commands: https://code.claude.com/docs/en/commands
- Claude Code status line JSON schema: https://code.claude.com/docs/en/statusline
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code headless/JSON output: https://code.claude.com/docs/en/headless
- Claude Agent SDK overview/cost usage: https://code.claude.com/docs/en/agent-sdk/overview
- Anthropic Usage and Cost Admin API: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
- Anthropic Claude Code Analytics Admin API: https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex CLI slash commands: https://developers.openai.com/codex/cli/slash-commands
- Codex config/state locations: https://developers.openai.com/codex/config-advanced#config-and-state-locations
- Codex enterprise governance/analytics: https://developers.openai.com/codex/enterprise/governance
- GitHub Copilot models and pricing: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
- GitHub Copilot legacy requests: https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests
- GitHub Copilot usage metrics REST API: https://docs.github.com/en/rest/copilot/copilot-usage-metrics
- GitHub Copilot CLI docs: https://docs.github.com/en/copilot/how-tos/copilot-cli
