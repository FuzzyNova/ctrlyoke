# Harness Usage Tracking Plan

**Status:** Ready to implement after the prerequisite token-total stages
**Provider research:** June 15, 2026; local CLI surfaces rechecked August 9,
2026 (Claude Code `2.1.225`, Codex CLI `0.146.0`, GitHub Copilot CLI `1.0.78`)
**Revised:** August 9, 2026 — final codebase pass; Codex app-server source,
idempotent per-harness rollups, normalized snapshot persistence, and combined
staging order added
**Related:** `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`

---

## Executive Summary

ctrlyoke can provide a useful unified usage display, but the implementation
should use different collection strategies per harness:

1. **Claude Code:** status-line JSON for live quota windows during a ctrlyoke-run
   session; normalized ctrlyoke run aggregates for observed token/cost history;
   transcript-wide/all-activity and enterprise/admin sources deferred and
   opt-in only.
2. **Codex CLI:** prefer the documented app-server
   `account/rateLimits/read` JSON-RPC method for live ChatGPT quota, with local
   session JSONL `token_count.rate_limits` as a defensive last-known fallback.
   No standalone top-level `codex status` command exists in the rechecked CLI.
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
  `AntigravityCliProvider` generates/registers the command and owns the settings
  lease; `AntigravityStatuslineSidecar.ts` watches the ctrlyoke-owned JSON
  snapshot, accepts changed `_ctrlyoke.sequence` / `writtenAt` markers, and
  feeds context-window updates into the existing pipeline. Model the Claude
  collector on that split. Extract only the provider-neutral snapshot watcher,
  marker/read/teardown mechanics into `src/core/harness/shared/`; command shape,
  payload parsing, settings key/path, and forwarding the user's prior statusline
  remain provider-specific. Dead-owner recovery already lives in the shared
  `SettingsJsonMcpTracker` value-lease implementation.
- **Copilot OTel is already implemented.** `CopilotLogParser` sets
  `COPILOT_OTEL_ENABLED` / `COPILOT_OTEL_FILE_EXPORTER_PATH` and reads
  `gen_ai.usage.input_tokens` / `output_tokens` off each `chat <model>` span
  incrementally during execution (`CopilotLogParser.ts:116-237`). The token plan
  only needs to make cumulative input lossless; the usage store then receives
  Copilot through the same run aggregate as every other harness, not a direct
  OTel feed.
- **Antigravity is a first-class harness now** and was missing from this plan
  entirely. The six harnesses are `HARNESS_IDS` in
  `src/types/DashboardConstants.ts`; "Gemini" in the old adapter list was not one
  of them and has been removed.
- **Observed usage has a real upstream source.**
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md` defines normalized per-attempt
  `TokenStats` totals and a per-run `WorkflowTokenTotals` aggregate persisted in
  the run's working file and manifest. `HarnessObservedTokens` must be summed
  **from the persisted `WorkflowTokenTotals.byLocalDay` per-harness
  subtotals**, not from a second parse of `events.jsonl`, provider transcripts,
  or OTel. `byHarness` is the run-level cross-check; whole-run totals are not
  enough because one run may use multiple harnesses or span multiple days. That
  plan is a hard prerequisite for this one's Phase 1.
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
  crashed host by reusing `SettingsJsonMcpTracker`'s existing dead-owner
  recovery rather than reinventing it.
- Parse `rate_limits.five_hour.{used_percentage,resets_at}` and
  `rate_limits.seven_day.{used_percentage,resets_at}` for provider quota.
- Do not parse Claude transcripts for the MVP observed rollup. That would count
  activity outside ctrlyoke, duplicate the normalized attempt pipeline, and add
  a broader privacy surface. If product scope later expands to "all Claude Code
  activity," model it as a separate provider-history source and deduplicate
  repeated assistant `message.id` values.
- Use `claude auth status` only for capability/auth state, with strict redaction.
- Do not parse the human `/usage` screen as the primary integration.

Confidence: high for status-line capture during a ctrlyoke session; medium for
using it as a background quota probe, since rate limits only appear after a live
API response. A normalized persisted last-known snapshot is therefore required
for a pre-launch warning before the first Claude turn after host startup.

### Codex CLI

Confirmed/rechecked surfaces:

- `codex --help` still lists no `status` top-level command in `0.146.0`.
- `codex login status` reports authentication mode only.
- `codex doctor --json` emits redacted install/auth/config/state diagnostics, no
  quota.
- `codex exec --json` exists for machine-readable non-interactive runs.
- The documented Codex app-server account surface now includes
  `account/rateLimits/read` and `account/rateLimits/updated`, returning
  `usedPercent`, `windowDurationMins`, `resetsAt`, optional plan/credit fields,
  and a multi-bucket `rateLimitsByLimitId` view. Starting app-server and reading
  account state does not launch a model turn. The `app-server` command is still
  labelled experimental, so capability/version gating and the rollout fallback
  remain required.
- The TUI now has `/usage` and can display daily, weekly, or cumulative account
  token activity. It remains a human UI, not the integration surface.
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

Implementation implications, in priority order:

- First spike a short-lived stdio `codex app-server` client that initializes,
  calls `account/rateLimits/read`, normalizes only quota fields, and shuts down.
  Prefer this documented provider-live source when the installed version
  supports it. Redact/ignore account identity returned by sibling methods.
- **Keep rollout parsing as a defensive fallback. ctrlyoke already parses the
  token half of this shape.**
  `CodexLogParser.ts:230-250` reads `token_count.info.total_token_usage`,
  `last_token_usage`, and `model_context_window`. The usage provider needs the
  sibling `rate_limits` object from the same event — extend the existing parse
  site and route a normalized signal through an injected callback/metadata
  field rather than adding a second reader over the same file.
- Treat `rate_limits.primary` / `.secondary` as **last-known** provider quota,
  refreshed whenever Codex emits token-count events, not an always-fresh global
  status.
- Map primary/secondary into normalized rolling/weekly windows by
  `window_minutes`.
- Do not shell out to `codex exec "/status"` as a quota probe — it would consume
  quota and may not produce stable machine-readable status.
- `logs_2.sqlite` is a later optional investigation only; rollout JSONL already
  carries the needed fields.

Confidence: high for the documented app-server rate-limit contract and local
session-log parsing after Codex activity; high that no standalone top-level
`codex status` exists in the rechecked CLI; medium on app-server process
compatibility across installed versions and on long-term stability of the
internal rollout fallback.

### GitHub Copilot CLI

Confirmed surfaces:

- `copilot --help` lists a `billing` help topic.
- In `1.0.78`, `copilot help billing` says the footer continuously shows
  remaining AI credit budget (or remaining premium requests on legacy billing);
  `/statusline` supports `quota` (plan-limit progress) and `ai-used` (session);
  `/usage` shows session AI credit usage, token breakdown, and usage-limit
  progress; `/context` shows context-window token usage. The earlier
  `ai-credits` statusline item name is stale and must not be implemented.
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
- Investigate a **Copilot status-line collector** only if `/statusline quota
ai-used` can emit structured data. The help topic confirms item
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
  periodic JSON snapshots containing context-window input, output, capacity,
  and current-usage fields plus model identity. Snapshots carry a
  ctrlyoke-written `_ctrlyoke.{sequence,writtenAt}` marker used for change
  detection.
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
the harness-reported cost for that run rather than re-deriving it from tokens.

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
- quota source: `provider-live`, `provider-log`, `enterprise-api`, or
  `unavailable`; observed totals are always explicitly `ctrlyoke-observed`
- freshness timestamp
- active windows, if known, and reset time, if known
- observed ctrlyoke token totals for today/week/month
- observed cost/equivalent estimate with provenance, where a harness
  self-reports it or a model price is known; partial sums use `≥`, never `≈`
  alone
- last safe error code

Usage lookup must never block workflow execution.

---

## Data Model

Create a normalized usage contract in `src/types/UsageTypes.ts`:

```typescript
export type HarnessQuotaSource =
  | "provider-live"
  | "provider-log"
  | "enterprise-api"
  | "unavailable";

export type HarnessUsageWindowKind =
  | "rolling"
  | "daily"
  | "weekly"
  | "monthly"
  | "unknown";

export type HarnessObservedPeriod = "daily" | "weekly" | "monthly";

export interface HarnessUsageWindow {
  /** Stable normalized key used to replace a pushed/refreshed window. */
  id: string;
  kind: HarnessUsageWindowKind;
  label: string;
  used?: number;
  limit?: number;
  remaining?: number;
  percentUsed?: number;
  /** Normalized Unix epoch milliseconds (provider seconds/ISO strings convert here). */
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
  /** Distinct cost provenances represented in `costUsd`, in stable display order. */
  costSources?: AttemptCostSource[];
  /** True when at least one token-bearing attempt in the window was unpriceable. */
  costPartial?: boolean;
  /** True when at least one attempt in the window had no usable total. */
  partial?: boolean;
  since: number;
}

export interface HarnessQuotaSnapshot {
  harnessId: HarnessId;
  source: HarnessQuotaSource;
  /** Last successful quota fetch/ingest; absent when quota was never available. */
  fetchedAt?: number;
  staleAfterMs: number;
  windows: HarnessUsageWindow[];
  planType?: string;
  message?: string;
  errorCode?: string;
}

export interface HarnessUsageSnapshot {
  harnessId: HarnessId;
  /** When this merged provider + observed snapshot was emitted. */
  updatedAt: number;
  quota: HarnessQuotaSnapshot;
  /** Calendar observed totals; each value carries its own `since` boundary. */
  observed: Partial<Record<HarnessObservedPeriod, HarnessObservedTokens>>;
}
```

The snippet uses string literals for readability. In implementation, define the
quota sources, observed periods, confidence values, units, and window kinds as
`const` objects in `DashboardConstants.ts`, then derive the union types from
those objects; do not maintain parallel handwritten string unions. Define and
test timestamp units at the normalization boundary: ctrlyoke uses epoch
milliseconds everywhere even when Codex returns Unix seconds or Claude returns
an ISO string.

Model **multiple windows**: Claude exposes five-hour and seven-day windows via
status line, Codex session logs expose primary/secondary, Copilot may expose
monthly credits alongside session usage.

The token and cost fields on `HarnessObservedTokens` map directly from the
corresponding `WorkflowTokenTotals.byLocalDay` subtotal fields in
`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`; `partial` derives from subtotal coverage.
Keep those meanings aligned—a divergence means two different answers to “how
many tokens did I use” in the same product.

Initial freshness policy (constants, not component literals): provider-live
snapshots are fresh for 5 minutes; provider-log fallbacks are fresh for 15
minutes; either expires earlier when its window has reset. Refresh in the
background when the quick picker/settings card opens and after relevant harness
events. The launch path reads the cache synchronously and never waits for a
network/process probe.

---

## Architecture

### 1. HarnessUsageService

Add `HarnessUsageService` under `src/core/harness/shared/usage/`.

Responsibilities:

- maintain an in-memory cache keyed by harness ID
- debounce refreshes
- expose `refreshHarnessUsage(harnessId)` and `refreshAllHarnessUsage()`
- accept push updates from active parser/sidecar paths through an injected
  `ingestProviderUsage(...)` port; parsers must not import a service singleton
- merge provider snapshots with ctrlyoke-observed token stats
- load/store normalized last-known provider windows in
  `.ctrlyoke/.usage/provider-snapshots.json` so Claude can warn before the first
  turn after a host restart; never persist raw payloads or identity fields
- emit dashboard updates
- never write account-specific details to logs

### 2. Provider Adapters

```typescript
export interface IHarnessUsageProvider {
  readonly harnessId: HarnessId;
  refreshUsage(signal?: AbortSignal): Promise<HarnessQuotaSnapshot>;
}
```

`refreshUsage` is the pull path used by commands/cards. Active harness parsers
and sidecars use the service's push port. Both paths enter the same normalizer,
cache, persistence, staleness, and message pipeline.

Adapters, one per `HARNESS_IDS` entry — every adapter declares
`implements IHarnessUsageProvider` explicitly:

- `ClaudeUsageProvider` — status-line sidecar for live windows. Observed totals
  come only from completed ctrlyoke run aggregates.
- `CodexUsageProvider` — documented app-server `account/rateLimits/read` for
  provider-live windows; rollout JSONL `rate_limits` fallback reusing the
  existing `token_count` parse site.
- `CopilotUsageProvider` — observed totals from the shared run rollup; optional
  status-line/TUI research path; GitHub dashboard link fallback.
- `AntigravityUsageProvider` — observed-only until a quota field is found in the
  statusline snapshot.
- `ObservedOnlyUsageProvider` — OpenCode and Qwen. OpenCode passes through its
  observed self-reported cost only through the shared run rollup.

### 3. Observed Usage Store

Persist a versioned workspace-local rollup in
`.ctrlyoke/.usage/observed-usage.json`, fed only by
`WorkflowTokenTotals.byLocalDay` at every terminal run transition (`completed`,
`stopped`, or `error`). This is not a quota source — it records what ctrlyoke
launched or safely observed locally.

The store must be idempotent by durable `(workflowKey, runRef)` identity. A
same-run continuation or repaired terminal transition upserts/replaces that
run's contribution instead of adding it again. Persist the small per-run
contribution ledger keyed by local day so an upsert can subtract the old
contribution and add the new one without scanning run files. Derive ISO weeks
(Monday start) and calendar months from those day keys. Mixed-harness and
multi-day runs apply their `byLocalDay` subtotals independently. Prune
contributions once none of their day keys can affect a retained window so the
file stays bounded. File writes use the project's atomic-write and lock
patterns; malformed data is quarantined/reset with a safe error code, never
allowed to block execution.

### 4. Webview Messages

Add message constants `REQUEST_HARNESS_USAGE`, `REFRESH_HARNESS_USAGE`,
`HARNESS_USAGE_UPDATED`:

```typescript
export interface HarnessUsageUpdatedMessage {
  type: typeof MESSAGE_TYPES.HARNESS_USAGE_UPDATED;
  snapshots: HarnessUsageSnapshot[];
}
```

Register `ctrlyoke.refreshHarnessUsage` and the optional provider-dashboard
command through the existing extension command surface (`package.json` plus
`extension.ts`), and route webview requests through `WebviewMessageRouter` /
the dashboard sink rather than calling core services from React.

---

## Implementation Phases

**Prerequisite:** combined stages 1–3 in
`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`'s
[Recommended Combined Staging Order](PROMPT_TOTAL_TOKEN_USAGE_PLAN.md#recommended-combined-staging-order).
Without normalized per-run `byHarness` / `byLocalDay` totals there is nothing
correct to roll up, and building a parallel token pipeline here would be the
exact duplication both plans warn against.

### Phase 1: Observed Usage Baseline

- [x] Add `UsageTypes.ts` and the matching constants in `DashboardConstants.ts`
- [x] Add the canonical `.usage` path constants plus versioned, atomic
      normalized-provider and observed-rollup stores. The directory name belongs
      in `PATH_CONSTANTS` (`src/utils/ConfigurationUtils.ts`) beside
      `RUNS_DIR`/`TEMP_DIR`; the file paths under it belong in a small
      `UsagePaths` helper mirroring how `WorkflowPaths.ts` owns everything under
      `.runs` — do not build `.usage` paths ad hoc at call sites
- [x] Add `ObservedHarnessUsageStore`, idempotently fed at every terminal state
      by `(workflowKey, runRef)` and `WorkflowTokenTotals.byLocalDay`
- [x] Render usage cards in `HarnessesSection.tsx` showing observed totals
- [x] Tests for local day/ISO-week/month bucketing, mixed-harness attribution,
      same-run continuation replacement, repeated terminal notification,
      corrupt-file recovery, and stale snapshots

### Phase 2: Claude And Codex Provider Signals

- [x] Extract the shared sidecar mechanics out of
      `AntigravityStatuslineSidecar.ts` into `src/core/harness/shared/`
- [x] Add `ClaudeUsageProvider` + a generated Claude status-line command built on
      the extracted sidecar; parse `rate_limits`
- [x] Preserve/forward the user's prior Claude statusline command, release the
      shared settings lease on every teardown path, and persist normalized
      last-known windows only
- [x] Spike a short-lived stdio Codex app-server client and use
      `account/rateLimits/read` when supported; fall back safely on unsupported
      versions/auth modes
- [x] Add the Codex rollout fallback; read `rate_limits` at the existing
      `token_count` parse site and push the normalized signal through an
      injected port
- [x] Map both app-server `windowDurationMins` and rollout `window_minutes`
      through one duration-based window normalizer
- [x] Redaction, epoch-seconds/ISO-to-milliseconds, abort/timeout, app-server
      teardown, multi-bucket/window replacement, settings-lease recovery, and
      provider-schema drift tests

### Phase 3: Copilot Usage

- [ ] Consume Copilot's existing OTel totals only through the shared
      `WorkflowTokenTotals.byLocalDay` rollup; add no Copilot-specific store feed
- [ ] Investigate whether `/statusline quota ai-used` can emit structured
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

- [x] Near-limit warnings before starting a queue: if at least one remaining AI
      attempt is queued and any fresh provider window has `percentUsed` at or
      above a configurable threshold (default recommendation: 80%), warn. Queue
      length supplies context in the message; it is not converted into quota or
      treated as a prediction. Warn, never block — the user may knowingly want
      to burn the remainder.
- [x] Say which window triggered the warning and when it resets; a bare "low
      quota" is not actionable.
- [x] Suppress the warning entirely when `snapshot.quota.source` is
      `unavailable` or the quota snapshot is stale past
      `snapshot.quota.staleAfterMs`, rather than guessing.
- [x] Suggest a fallback only when its comparable provider window is fresh and
      materially less used; never rank an observed-only or stale harness as if
      its missing quota meant zero usage
- [x] User-configurable preferred fallback order

---

## Security And Privacy

Non-negotiables:

- Do not retain raw `/usage`, `/status`, auth output, or provider transcripts.
  A statusline wrapper may use one ctrlyoke temp snapshot as its transport, but
  it must be workspace-scoped, never logged/copied to durable usage storage, and
  deleted on teardown/recovery.
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
  "enterpriseUsageApisEnabled": false,
  "warningPercentUsed": 80,
  "preferredFallbackOrder": []
}
```

---

## Open Questions Left

Decided August 8, 2026:

- **Keep the Claude status-line collector.** Quota-window visibility and the
  pre-queue near-limit warning are wanted features, and the status line is the
  only machine-readable source for `rate_limits` — verified empirically, not
  just from docs: a scan of 25 local transcripts found no `five_hour` /
  `seven_day` / `resets_at` fields anywhere, and a JSON-output invocation of
  Claude's `/usage` command returns only a subscription blurb. The sidecar earns
  its cost (a leased key in the user's global Claude settings, with dead-owner
  recovery) because nothing else answers the question.
- **Enable Claude status-line capture automatically for ctrlyoke-started Claude
  sessions**, matching the Antigravity sidecar precedent, on the condition that
  no raw payload is ever persisted — only normalized numbers, per Security And
  Privacy below. No separate opt-in prompt; the existing usage-tracking setting
  is the off switch.
- **Treat Codex `token_count.rate_limits` as best-effort internal parsing**, not
  a stable contract. Parse defensively, tolerate absent or renamed fields, and
  degrade that harness to `ctrlyoke-observed` rather than erroring when the
  shape drifts. Prefer the documented app-server `account/rateLimits/read`
  result when available. The same defensive rule applies to the Claude
  status-line schema.

Still open:

1. Can Copilot `/statusline quota ai-used` be captured as structured data,
   or only as TUI text? **Recommendation:** update the spike to the current
   `quota` + `ai-used` item names, timebox it, and do not parse ANSI/private TUI
   state. If there is no structured surface, ship observed OTel-derived totals
   plus the GitHub dashboard link.
2. Should observed usage be workspace-local only, or should users opt into a
   user-level aggregate across workspaces? (Workspace-local is the Phase 1
   default either way; this only decides whether the opt-in exists.)
   **Recommendation:** do not add the user-level aggregate in the first
   implementation. It expands privacy, migration, and cross-process locking
   scope without helping the pre-launch quota warning.
3. Does Antigravity expose any quota field at all? Unknown until Phase 4.
   **Recommendation:** remain observed-only unless a documented or stable
   structured field is found; absence must not be rendered as available quota.
4. Do the provider schemas still match at implementation time? Local CLI help
   was rechecked August 9, 2026, and Codex now has a documented app-server
   source, but Claude status-line and the Codex rollout fallback remain
   version-sensitive. **Recommendation:** keep fixture-based drift tests and a
   pre-merge live-schema verification task; degrade safely rather than block the
   core feature.

None of these questions blocks combined stages 1–7. They decide optional
provider enrichment or are explicit verification gates with safe fallbacks.

---

## Acceptance Criteria

- Observed totals come only from terminal, persisted
  `WorkflowTokenTotals.byLocalDay` snapshots; no usage provider reparses output
  events, OTel, or Claude transcripts.
- Repeated terminal notifications and same-run continuations replace one durable
  run contribution rather than double-counting it.
- Mixed-harness runs update the correct harness buckets independently.
- Multi-day runs update the correct local-day buckets instead of assigning all
  usage to their terminal date.
- Quota source and ctrlyoke-observed source are labelled separately; missing
  quota is never interpreted as zero usage or unlimited capacity.
- Codex uses `account/rateLimits/read` when supported and degrades to defensive
  last-known rollout parsing or observed-only without blocking execution.
- Claude's collector preserves the user's prior statusline, shares the
  ownership-aware settings lease, recovers dead owners, and persists only
  normalized windows.
- Every provider timestamp is normalized to epoch milliseconds and every stale
  decision uses `snapshot.quota.fetchedAt` plus the source-specific
  `snapshot.quota.staleAfterMs` value.
- Refresh, provider failures, malformed cache files, and dashboard delivery are
  non-blocking for workflow execution.
- Pre-launch warnings use fresh provider percentages only, name the triggering
  window/reset, and warn rather than block.
- No durable usage file or log contains account identity, credentials, raw
  provider payloads, or transcript content; ephemeral statusline transport files
  are removed on teardown/recovery.
- The full implementation follows the canonical cross-plan staging order in
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`.

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
- Codex app-server account/rate-limit protocol: https://learn.chatgpt.com/docs/app-server
- Codex config/state locations: https://developers.openai.com/codex/config-advanced#config-and-state-locations
- Codex enterprise governance/analytics: https://developers.openai.com/codex/enterprise/governance
- GitHub Copilot models and pricing: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
- GitHub Copilot legacy requests: https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests
- GitHub Copilot usage metrics REST API: https://docs.github.com/en/rest/copilot/copilot-usage-metrics
- GitHub Copilot CLI docs: https://docs.github.com/en/copilot/how-tos/copilot-cli
