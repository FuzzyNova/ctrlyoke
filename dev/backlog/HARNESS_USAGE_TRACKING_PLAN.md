# Harness Usage Tracking Plan

**Status:** Researched / ready for design  
**Last researched:** June 15, 2026  
**Local CLI versions checked:** Claude Code `2.1.177`, Codex CLI `0.139.0`, GitHub Copilot CLI `1.0.62`

---

## Executive Summary

FlightPath can provide a useful unified usage display, but the implementation should use different collection strategies per harness:

1. **Claude Code:** use status-line JSON for live quota windows when a Claude session is running; parse local transcripts for observed token/cost history; enterprise/admin APIs are opt-in only.
2. **Codex CLI:** parse local session JSONL `token_count` events for both observed tokens and last-known rate-limit windows; no standalone `codex status` command exists in the checked version.
3. **GitHub Copilot CLI:** use CLI session surfaces and JSON/session output for observed usage; personal monthly AI credit balance appears in GitHub/Copilot UI and CLI TUI surfaces, but no documented personal REST/GraphQL quota API was found.
4. **All other harnesses:** start with FlightPath-observed token usage only.

The MVP should be **observed usage plus last-known provider quota**. It should not try to fabricate exact remaining quota when the provider only exposes session-local or UI-only data.

---

## Research Findings

### Claude Code

Confirmed surfaces:

- `claude --help` lists `-p/--print`, `--output-format json|stream-json`, `--no-session-persistence`, `--max-budget-usd`, `--session-id`, `--resume`, and other automation flags.
- `claude auth status` is machine-readable JSON and reports login/auth/subscription state, but includes account identifiers that must be redacted if logged.
- Official commands docs list `/usage`; `/cost` and `/stats` are aliases. It shows session cost, plan usage limits, activity stats, and breakdowns by skill/subagent/plugin/MCP on paid plans.
- `claude -p "/usage" --output-format json --max-turns 1` exits quickly with zero API turns and zero cost on this machine, but it only returned a short subscription message, not quota bars or reset windows. Do not rely on this as the usage data source.
- Official status-line docs are the best live source: a configured status-line command receives JSON on stdin with `cost`, `context_window`, and `rate_limits.five_hour` / `rate_limits.seven_day`. The docs state `rate_limits` appears only for Claude.ai subscribers after the first API response and each window can be absent.
- Local transcript files under `~/.claude/projects/<project-key>/*.jsonl` include assistant records with `message.usage` containing input/output/cache token fields, model, service tier, timestamps, cwd, version, and session ID. This is reliable for observed usage, not authoritative remaining quota.
- Claude Agent SDK exposes per-run cost/usage accounting, but it does not expose personal subscription quota remaining.
- Anthropic Admin APIs exist for usage/cost, rate limits, and Claude Code analytics, but they require admin/API-key contexts and are not a default personal Claude Pro path.

Implementation implications:

- Add a **Claude status-line collector**. Generate a tiny status-line script/command that writes the JSON payload to a FlightPath temp file. Use it only for live sessions FlightPath starts or sessions where the user opts in.
- Parse `rate_limits` from the status-line payload for provider quota:
  - `five_hour.used_percentage`
  - `five_hour.resets_at`
  - `seven_day.used_percentage`
  - `seven_day.resets_at`
- Parse transcript JSONL for observed token/cost rollups. Deduplicate repeated assistant `message.id` values because Claude transcripts can emit multiple content records for the same API response.
- Use `claude auth status` only for capability/auth state, with strict redaction of email/org/account fields.
- Do not parse the human `/usage` screen as the primary integration.

Confidence: high for status-line/transcript paths; medium for using status-line as a background quota probe because it requires a live API response before rate limits appear.

### Codex CLI

Confirmed surfaces:

- `codex --help` does not list a `status` top-level command in `0.139.0`.
- `codex login status` reports authentication mode only.
- `codex doctor --json` emits redacted install/auth/config/state diagnostics, but no quota.
- `codex exec --json` exists for machine-readable non-interactive runs.
- Official CLI docs document JSON output for several commands, but not a standalone quota/status command.
- Local `~/.codex/sessions/**/rollout-*.jsonl` files contain `event_msg` entries whose payload type is `token_count`. These include:
  - `info.total_token_usage`
  - `info.last_token_usage`
  - `info.model_context_window`
  - `rate_limits.primary.used_percent`
  - `rate_limits.primary.window_minutes`
  - `rate_limits.primary.resets_at`
  - `rate_limits.secondary.used_percent`
  - `rate_limits.secondary.window_minutes`
  - `rate_limits.secondary.resets_at`
  - `rate_limits.plan_type`
  - optional `credits`
- On this machine, sampled Codex session records included a 300-minute primary window and a 10080-minute secondary window.
- `~/.codex` also contains `history.jsonl`, `logs_2.sqlite`, `state_5.sqlite`, `models_cache.json`, and session rollout files. The rollout JSONL is easier and less invasive to parse than SQLite.

Implementation implications:

- Add a **Codex session-log collector** that tails the current run's rollout file and extracts the newest `token_count` event.
- Treat `rate_limits.primary` and `rate_limits.secondary` as **last-known provider quota**, not an always-fresh global status. It updates when Codex emits token-count events.
- Use `codex exec --json` / FlightPath's existing Codex parser for FlightPath-launched run token usage.
- Do not shell out to `codex exec "/status"` as a quota probe by default; that would likely consume model quota and still may not produce stable machine-readable status.
- Consider a later optional investigation of `logs_2.sqlite`, but prefer rollout JSONL first because it already contains the needed rate-limit fields.

Confidence: high for local session-log parsing after Codex activity; high that no standalone `codex status` exists in checked CLI; medium on long-term stability of internal rollout schema.

### GitHub Copilot CLI

Confirmed surfaces:

- `copilot --help` lists a `billing` help topic.
- `copilot help billing` says:
  - footer continuously shows remaining AI credit budget, or remaining premium requests on the legacy billing platform
  - `/statusline` supports `ai-credits` for monthly AI credit usage and `ai-used` for session usage
  - legacy billing can use `quota`
  - `/usage` shows current session AI credit usage, token breakdown, and usage-limit progress when limits apply
  - `/context` shows context-window token usage
- `copilot help commands` lists `/usage`, `/context`, `/statusline`, `/footer`, `/model`, and other interactive commands.
- `copilot -p "/usage" --output-format json --stream off` could not be validated in this environment because the local token could not be validated over the available network. This is an auth/network failure, not evidence the command cannot work.
- GitHub docs show legacy premium requests for Pro/Pro+ and request multipliers, but newer Copilot CLI help now describes AI credits. Subagent research found current individual monthly AI credit allowances in GitHub docs: Pro `1,500`, Pro+ `7,000`, Max `20,000`, with `1 AI credit = $0.01`.
- GitHub REST Copilot metrics endpoints are organization/enterprise oriented and require org/enterprise permissions. The older metrics endpoints were closed April 2, 2026 in favor of usage metrics reports.
- No documented personal REST/GraphQL endpoint for "my remaining monthly AI credits" was found.
- VS Code's authentication API can obtain GitHub sessions/tokens with consent, but no public VS Code API was found that exposes Copilot quota from the Copilot extension.

Implementation implications:

- Add a **Copilot CLI observed-usage collector** using existing Copilot JSON/session output and/or CLI emitted stats.
- Investigate a **Copilot status-line collector** similar to Claude only if Copilot can run a status-line command that receives monthly credit fields in JSON. The help topic confirms status-line item names but not a public JSON schema.
- For personal account quota, prefer:
  - show "Open GitHub usage dashboard" link
  - show local/session usage and last-known CLI TUI data when available
  - avoid undocumented GitHub private endpoints
- Add optional enterprise/org metrics integration only when a user supplies an authorized GitHub token and chooses org/enterprise scope.

Confidence: high for CLI TUI/session surfaces; high that documented REST APIs are admin/org oriented; medium-high that no documented personal credit API exists.

### Existing VS Code Extensions

Searches for VS Code extensions around "Copilot quota", "Copilot usage", "premium requests", "Claude usage", and "Codex status" did not find a mature unified quota panel. Absence of evidence is not proof none exists, but FlightPath still has a strong product reason to own this because harness choice is already part of workflow execution.

---

## Product Shape

Add a compact **Usage** surface near existing harness controls:

- Footer harness picker chip: `63% 5h`, `24% week`, `observed only`, `needs auth`, or `stale`.
- Settings drawer usage cards with details per harness.
- Command: `FlightPath: Refresh Harness Usage`.
- Optional command: `FlightPath: Open Provider Usage Dashboard`.

Each harness card should show:

- provider display name
- data source: `provider-live`, `provider-log`, `flightpath-observed`, `enterprise-api`, or `unavailable`
- freshness timestamp
- active windows, if known
- reset time, if known
- observed FlightPath token totals for today/week/month
- last safe error code

Usage lookup must never block workflow execution.

---

## Data Model

Create a normalized usage contract in `src/types/UsageTypes.ts`:

```typescript
export type HarnessUsageSource =
  | "provider-live"
  | "provider-log"
  | "flightpath-observed"
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
  since: number;
}

export interface HarnessUsageSnapshot {
  harnessId: string;
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

Important: model multiple windows. Claude exposes five-hour and seven-day windows via status line. Codex session logs expose primary/secondary windows. Copilot may expose monthly credits and session usage.

---

## Architecture

### 1. HarnessUsageService

Add `HarnessUsageService` under `src/flightpath/orchestration/` or `src/flightpath/harness/shared/usage/`.

Responsibilities:

- maintain an in-memory cache keyed by harness ID
- debounce refreshes
- expose `refreshHarnessUsage(harnessId)` and `refreshAllHarnessUsage()`
- merge provider snapshots with FlightPath-observed token stats
- emit dashboard updates
- avoid writing account-specific details to logs

### 2. Provider Adapters

```typescript
export interface IHarnessUsageProvider {
  readonly harnessId: HarnessId;
  refreshUsage(signal?: AbortSignal): Promise<HarnessUsageSnapshot>;
}
```

Adapters:

- `ClaudeUsageProvider`
  - status-line temp-file collector for live provider windows
  - transcript parser for observed local history
- `CodexUsageProvider`
  - rollout JSONL parser for provider-log windows and token counts
- `CopilotUsageProvider`
  - session/stat parser for observed usage
  - optional status-line/TUI research path
  - GitHub dashboard link fallback
- `ObservedOnlyUsageProvider`
  - OpenCode, Qwen, Gemini, and unsupported harnesses

### 3. Observed Usage Store

Persist a small workspace-local rollup in `.flightpath/.usage/observed-usage.json`.

This is not a quota source. It records what FlightPath launched or safely observed locally.

### 4. Webview Messages

Add message constants:

- `REQUEST_HARNESS_USAGE`
- `REFRESH_HARNESS_USAGE`
- `HARNESS_USAGE_UPDATED`

Payload:

```typescript
export interface HarnessUsageUpdatedMessage {
  type: typeof MESSAGE_TYPES.HARNESS_USAGE_UPDATED;
  snapshots: HarnessUsageSnapshot[];
}
```

---

## Implementation Phases

### Phase 1: Observed Usage Baseline

- [ ] Add `UsageTypes.ts`
- [ ] Add `ObservedHarnessUsageStore`
- [ ] Record token stats after each prompt/finalStep completion
- [ ] Render usage cards showing FlightPath-observed totals
- [ ] Add tests for rollup bucketing, corrupt-file recovery, and stale snapshots

### Phase 2: Claude And Codex Provider Signals

- [ ] Add `ClaudeUsageProvider`
- [ ] Add a generated Claude status-line command/script that captures JSON and parses `rate_limits`
- [ ] Parse Claude transcript JSONL with assistant-message deduplication
- [ ] Add `CodexUsageProvider`
- [ ] Parse Codex rollout JSONL `event_msg.payload.type === "token_count"`
- [ ] Map Codex primary/secondary windows into normalized rolling/weekly windows by `window_minutes`
- [ ] Add redaction tests for `claude auth status`

### Phase 3: Copilot Usage

- [ ] Parse Copilot CLI JSON/session output for session AI credit/token usage
- [ ] Investigate whether `/statusline ai-credits ai-used` can emit a machine-readable payload or only TUI text
- [ ] Add dashboard link for personal GitHub Copilot usage when personal API is unavailable
- [ ] Add optional enterprise/org usage metrics integration behind explicit auth and scope prompts

### Phase 4: Selection Assist

- [ ] Add near-limit warnings before starting a large queue
- [ ] Add fallback harness suggestions based on stale/fresh usage data
- [ ] Let users configure preferred fallback order

---

## Security And Privacy

Non-negotiables:

- Do not store raw `/usage`, `/status`, status-line payloads, auth status output, or provider transcripts.
- Do not log emails, org IDs, org names, account IDs, access tokens, session tokens, or billing identifiers.
- Store only normalized numbers, reset timestamps, source/freshness, and generic status/error codes.
- Keep observed usage workspace-local by default.
- Do not request broad GitHub scopes for Copilot usage.
- Never call a model-consuming command as an automatic quota probe.

Potential setting:

```json
"flightpath.usageTracking": {
  "enabled": true,
  "providerRefreshEnabled": true,
  "persistObservedUsage": true,
  "enterpriseUsageApisEnabled": false
}
```

---

## Open Questions Left

1. Can Copilot `/statusline ai-credits ai-used` be captured as structured data, or only as TUI text?
2. Does Codex guarantee `token_count.rate_limits` rollout events as a stable contract, or should FlightPath treat this as best-effort internal parsing?
3. Should Claude status-line capture be enabled automatically for FlightPath-started Claude sessions, or only after user opt-in?
4. Should observed usage be workspace-local only, or should users be able to opt into a user-level aggregate across workspaces?

---

## References

- Claude Code commands: https://code.claude.com/docs/en/commands
- Claude Code status line JSON schema: https://code.claude.com/docs/en/statusline
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
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
