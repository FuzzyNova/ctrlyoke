# Copilot Usage-Period Quota Plan

**Status:** Proposed  
**Priority:** P1  
**Researched:** August 16, 2026  
**Verified locally:** GitHub Copilot CLI `1.0.80`; `@github/copilot-sdk`
`1.0.11` contract and package layout  
**Related:** [`HARNESS_USAGE_TRACKING_PLAN.md`](../implemented/HARNESS_USAGE_TRACKING_PLAN.md)

## Outcome

Replace Copilot's observed-only quota adapter with an exact provider-live
monthly quota collector. The collector must obtain the authenticated user's
current quota percentage, used amount, entitlement, and reset time without
starting a Copilot conversation or consuming a model turn.

GitHub now documents `account.getQuota` specifically for warning users before
they exhaust their plan. It is a server-scoped JSON-RPC call, not a session
event and not an OpenTelemetry signal. This supersedes the negative Copilot
research conclusion in `HARNESS_USAGE_TRACKING_PLAN.md`.

## Research Conclusion

### The authoritative source

`account.getQuota({})` returns a `quotaSnapshots` record keyed by runtime quota
type. Common keys are:

- `premium_interactions`
- `chat`
- `completions`

Each documented snapshot includes:

- `entitlementRequests`
- `usedRequests`
- `remainingPercentage`
- `resetDate`
- unlimited-entitlement and post-exhaustion flags
- overage usage and whether overage remains permitted

The map keys are runtime strings, not a closed enum. Unknown keys must be
accepted defensively.

The account-quota RPC is currently marked experimental in the generated SDK
surface and in the CLI's shipped `api.schema.json`, despite having a public
task-oriented documentation page. Treat method availability and response shape
as capabilities, not as guarantees derived from a hardcoded CLI version.

### What process is required

Yes, the normal SDK transport starts a Copilot CLI/runtime subprocess. The
smallest verified lifecycle is:

1. Resolve the same installed `copilot` launcher that ctrlyoke uses for prompts.
2. Spawn it with `--headless --no-auto-update --log-level error --stdio`.
3. Establish a `Content-Length`-framed JSON-RPC connection over stdin/stdout.
4. Send `connect` with an empty parameter object.
5. Send `account.getQuota` with an empty parameter object so the runtime uses
   the user's existing logged-in Copilot credentials.
6. Send `runtime.shutdown`, dispose the connection, and wait briefly for exit.
7. Force-terminate the process tree only if graceful shutdown fails.

No `session.create`, `session.resume`, prompt, model, tool, or permission call is
needed. The quota request is an account/server operation, so the probe creates
no conversation and consumes no model turn.

This sequence was exercised successfully against the installed Copilot CLI
`1.0.80`. The redacted probe returned the three buckets above and the documented
quota fields, then shut down cleanly. It also returned optional fields not yet
present in the public generated type (`hasQuota`, `tokenBasedBilling`, and
`overageEntitlement`), confirming that normalization must ignore unknown fields
and must not require undocumented ones.

### Why OTel remains separate

Copilot OTel remains the source for per-call billing token totals and live
context-window usage during a ctrlyoke run. It does not contain the authenticated
account's monthly quota balance. Do not extend `CopilotLogParser` to look for
account quota, and do not combine context fill, observed tokens, session AI-unit
cost, and monthly entitlement into one number.

## Integration Decision

Implement a narrow `CopilotQuotaClient` over `vscode-jsonrpc` and the user's
installed Copilot CLI. Do not initially add the full `@github/copilot-sdk` as a
production dependency.

Reasons:

- ctrlyoke already requires an installed Copilot CLI for this harness and should
  query the same authenticated runtime the user actually runs;
- the official TypeScript SDK depends on `@github/copilot`, whose platform
  runtime packages are hundreds of megabytes unpacked and would duplicate the
  harness prerequisite;
- shipping a bundled runtime from the machine that builds the VSIX would create
  cross-platform packaging and version-alignment work unrelated to one account
  RPC;
- `vscode-jsonrpc` provides the exact stream framing used by the SDK without
  requiring ctrlyoke to hand-roll an LSP-style frame parser;
- ctrlyoke already owns a comparable short-lived provider process in
  `CodexAppServerClient`, so timeout, cancellation, injectable spawning, and
  cleanup behavior have an established local pattern.

The official SDK remains the protocol reference. Revisit using it directly if
it offers a lightweight client-only package or if ctrlyoke later adopts broader
Copilot SDK functionality that justifies bundling a matching runtime.

Do not connect to an arbitrary long-running TCP server for the default path. A
private stdio child has no port exposure, inherits the correct local auth
context, is easy to bound, and cannot outlive ctrlyoke when cleanup works.

## Architecture

### 1. `CopilotQuotaClient`

Add `src/core/harness/copilot/CopilotQuotaClient.ts`.

Responsibilities:

- accept injected launcher resolution, process spawning, timeout, and clock
  dependencies for deterministic tests;
- call `resolveCliCommand("copilot", serverArgs)` so Windows PowerShell/npm
  shims follow the same resolution rules as normal harness execution;
- pass `windowsVerbatimArguments` when required by the resolved launcher;
- spawn hidden with stdin/stdout piped and stderr captured only into a small,
  bounded diagnostic buffer that is never logged verbatim;
- construct a `vscode-jsonrpc` `MessageConnection` with
  `StreamMessageReader`/`StreamMessageWriter`;
- start listening before sending requests;
- send `connect`, falling back to `ping` only for a legacy
  method-not-found response, matching the official SDK handshake behavior;
- send exactly one `account.getQuota` request;
- validate the result as `unknown` at the provider boundary;
- on every success, failure, abort, and timeout path, attempt
  `runtime.shutdown`, dispose the connection, close stdin, and reap the child;
- use the existing process-tree termination facility after a short grace period
  so a Windows launcher wrapper cannot leave the runtime orphaned.

The client must not call account/auth methods that return credential structures.
In particular, do not call `account.getCurrentAuth`: its generated types can
contain tokens for some auth variants. Authentication failure should be inferred
from the quota RPC error and normalized to a safe status code.

Keep the transport comparison with `CodexAppServerClient` honest: Codex speaks
newline-delimited JSON with a hand-rolled request matcher, while Copilot speaks
`Content-Length`-framed JSON-RPC through `vscode-jsonrpc`. Reuse the shared
*shape* (injected spawn, one bounded deadline, abort race, best-effort teardown)
and factor out only what genuinely single-sources — do not force two different
framings behind one abstraction just to satisfy DRY.

Suggested narrow result:

```typescript
export interface CopilotQuotaProbeResult {
  quota?: HarnessQuotaSnapshot;
  errorCode?: string;
}
```

Keep raw RPC types private to the Copilot module. They are experimental wire
input, not project-wide domain types.

### 2. Copilot quota normalization

Add `src/core/harness/copilot/CopilotUsageNormalization.ts`, following
`CodexUsageNormalization.ts` rather than embedding shape checks in the
provider.

For every valid runtime bucket:

- use a stable ID such as `copilot:premium_interactions`;
- give known keys friendly labels, with `premium_interactions` first;
- preserve valid unknown keys after the known keys with a safe humanized label;
- map documented monthly entitlement buckets to
  `HARNESS_USAGE_WINDOW_KINDS.MONTHLY` and use `UNKNOWN` for an unknown bucket
  whose period cannot be proven;
- set `used = usedRequests`;
- set `limit = entitlementRequests` only when finite and non-negative;
- set `remaining` only when it can be calculated from finite values without
  contradicting the provider percentage;
- set `percentUsed = clamp(100 - remainingPercentage, 0, 100)`;
- parse `resetDate` through the existing usage timestamp normalizer into epoch
  milliseconds;
- set `confidence = EXACT`, `source = PROVIDER_LIVE`, `fetchedAt = now`, and the
  existing provider-live freshness duration;
- use `REQUESTS` for the documented `usedRequests`/`entitlementRequests`
  quantities. Do not relabel them as dollars or convert them to AI credits from
  token counts;
- ignore unknown properties rather than rejecting an otherwise valid bucket.

Add provider-neutral optional fields to `HarnessUsageWindow` only if the UI will
surface them:

```typescript
isUnlimited?: boolean;
overage?: number;
usageAllowedAfterLimit?: boolean;
```

An unlimited bucket must never become `limit: -1`, `percentUsed: 0`, or a false
"100% available" claim. Represent it concretely as `isUnlimited: true` with
`percentUsed` and `limit` **omitted**. That single choice is what makes the
existing code behave correctly with no extra gating: `buildUsageSelectionWarning`
(`UsageSelectionAssist.ts`) and `getHarnessUsageDisplay`
(`webview-react/utils/harnessUsageDisplay.ts`) both already filter on
`percentUsed !== undefined`, so an unlimited bucket is automatically excluded
from near-limit warnings and from the compact badge. The display layer must then
render "Unlimited" for such a window instead of falling through to
"No usage data".

The new optional fields survive persistence without further work —
`normalizeWindow` and `stripPersistedQuota` in `HarnessUsageService.ts` spread
the window/quota objects rather than allow-listing keys — but that is incidental,
so lock it in with a round-trip test rather than assuming it.

Do not assume `usedRequests / entitlementRequests` is a better percentage than
the provider's `remainingPercentage`. The latter is authoritative, especially
while GitHub transitions account types between request-based and token/AI-unit
billing.

### 3. `CopilotUsageProvider`

Replace the inheritance from `ObservedOnlyUsageProvider` with an explicit
`IHarnessUsageProvider` implementation, mirroring `CodexUsageProvider`:

- own one `CopilotQuotaClient`;
- call it from `refreshUsage(signal?)`;
- return normalized provider-live quota on success;
- return an unavailable snapshot with a safe code on unsupported CLI,
  authentication failure, timeout, malformed response, or process failure;
- never throw a provider failure into workflow execution;
- let `HarnessUsageService` preserve the last successful persisted snapshot
  when a later refresh fails.

Do not hardcode a minimum Copilot version as the primary gate. Attempt the
handshake/RPC and handle JSON-RPC method-not-found. Version text may be recorded
in debug diagnostics without account data, but capability is the deciding
signal.

### 4. Refresh and display behavior

Keep the current cache-first behavior:

- opening the harness picker immediately shows the last-known snapshot and then
  refreshes providers in the background;
- explicit refresh calls the provider;
- queue launch reads only cached state and never waits for a subprocess or
  network request;
- a fresh finite Copilot monthly bucket participates in the existing near-limit
  warning using its exact `percentUsed` and reset time;
- a stale, missing, unlimited, or malformed bucket does not trigger a warning.

After a ctrlyoke-started Copilot attempt reaches a terminal state, schedule one
debounced background refresh for Copilot. Do not probe on every OTel event or
model API call. This keeps the displayed monthly balance aligned with newly
consumed usage while retaining the service's single-flight behavior.

Extend `harnessUsageDisplay.ts` so the Copilot tooltip can show the provider's
exact finite totals when present, for example:

```text
37% monthly used (555 / 1,500), resets Sep 1
```

Keep compact badges percentage-only. Display copy must make clear that this is
provider quota, separate from ctrlyoke-observed tokens.

## Failure and Privacy Rules

- Never pass, retrieve, persist, or log a GitHub token. Empty `getQuota` params
  intentionally select the CLI's existing logged-in user.
- Never log the raw quota response, stderr, account identity, home paths, or
  authentication payloads.
- Persist only the already-normalized `HarnessQuotaSnapshot` fields.
- Cap any in-memory stderr capture and map it to generic error codes.
- Treat method-not-found/schema drift as unsupported capability, not as a
  workflow error.
- Preserve a last-known successful snapshot on transient failures and annotate
  it with the safe error code through existing `HarnessUsageService` behavior.
- Honor `AbortSignal` and use one bounded overall deadline covering launcher
  resolution, startup, handshake, quota lookup, and graceful teardown.
- Do not auto-login or open an authentication UI from a background refresh.
- Do not use the undocumented private GitHub HTTP endpoint behind the runtime;
  the CLI JSON-RPC boundary owns auth, endpoint changes, and response decoding.

Safe error codes:

- `HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED` (the existing `"auth-required"`) for
  the authentication case — **not** a `copilot-quota-auth-required` variant.
  `getHarnessUsageDisplay` special-cases exactly that shared constant to render
  "Needs auth"; a Copilot-prefixed code would silently fall through to the
  generic phrase, and Codex already reuses the shared constant the same way.
- `copilot-quota-unsupported`
- `copilot-quota-timeout`
- `copilot-quota-malformed-response`
- `copilot-quota-probe-failed`

Single-source the Copilot-specific codes as one exported `as const` object in
`CopilotUsageNormalization.ts` — a leaf module both the client and the provider
can import without a cycle (the provider imports the client). Do not duplicate
string literals across client, provider, and tests.

## Implementation Phases

Phase order note: normalization now lands **before** the transport client.
`CopilotQuotaClient` returns `{ quota?: HarnessQuotaSnapshot }` and therefore
depends on the normalizer and on the shared status codes, so building the client
first would leave a step that cannot compile or be tested on its own.

### Phase 1: Contract and normalization

- [x] Add `isUnlimited` / `overage` / `usageAllowedAfterLimit` to
      `HarnessUsageWindow` in `src/types/UsageTypes.ts`.
- [x] Add `src/core/harness/copilot/CopilotUsageNormalization.ts` with defensive
      account-quota wire guards, normalization, and the exported status codes.
- [x] Normalize known and unknown buckets in stable order.
- [x] Handle finite, unlimited, exhausted, overage-enabled, missing-reset, and
      partially malformed snapshots.
- [x] Cover the persistence round-trip for the new optional window fields.

### Phase 2: Transport and packaging guard

- [x] Add `vscode-jsonrpc` as the minimal runtime dependency and verify it
      bundles cleanly into the extension, MCP binary, and standalone CLI build.
- [x] Record pre/post `out/extension.js`, `out/mcp-server.js`, and `out/cli.js`
      sizes in this document.

      Production bundle sizes (bytes; measured after a clean production build):

      | Bundle | Before dependency | After dependency | Temporary proof import |
      | --- | ---: | ---: | ---: |
      | `out/extension.js` | 5,364,924 | 5,364,924 | 5,421,181 |
      | `out/mcp-server.js` | 827,129 | 827,129 | 882,994 |
      | `out/cli.js` | 3,920,897 | 3,920,897 | 3,976,691 |

      “Before dependency” was measured with `npm run build:extension` at the
      Phase 2 starting commit. “After dependency” was measured with the
      throwaway import removed. The temporary proof build retained the import
      so the transport implementation was present in every target; the
      development `npm run compile:extension` also succeeded and included all
      three transport symbols in all three bundles. The temporary import was
      then removed.
- [x] Add a production-build assertion that no `@github/copilot-*` platform
      runtime or native Copilot binary is packaged. Assert against
      `package.json` dependencies plus the built bundles under `out/` — do not
      make the guard depend on running `vsce package`, which is not part of the
      normal build or test gate.
- [ ] Convert the verified probe into `CopilotQuotaClient` with dependency
      injection, cancellation, timeout, and process-tree teardown.
- [ ] Verify Windows PowerShell proxy, Windows npm shim, and direct Unix
      executable launcher shapes.

### Phase 3: Provider wiring

- [ ] Replace `CopilotUsageProvider`'s observed-only inheritance with the live
      pull provider.
- [ ] Retain shared observed token rollups unchanged.
- [ ] Refresh once after a completed/stopped/error Copilot attempt through the
      usage service's existing debounce/single-flight path
      (`HarnessUsageService.refreshHarnessUsage` already debounces and
      single-flights per harness, so the seam only needs to call it once per
      terminal attempt).

### Phase 4: Display and selection assist

- [ ] Show exact monthly percentage and reset time in current quota surfaces.
- [ ] Show finite `used / limit` totals in the tooltip/details without changing
      the compact badge contract.
- [ ] Represent unlimited quota truthfully and exclude it from near-limit
      warnings.
- [ ] Confirm fresh Copilot quota participates in selection assist and stale or
      unavailable data does not.

### Phase 5: Documentation cleanup

- [ ] Update the Copilot research/findings and Phase 3 conclusion in
      `HARNESS_USAGE_TRACKING_PLAN.md`; retain the historical OTel finding but
      replace "no collector" with the server-scoped quota RPC.
- [ ] Update harness-provider instructions with the account quota/context/OTel
      separation.
- [ ] Move this plan to `dev/implemented/` when acceptance criteria pass.

## Tests

### Transport tests

- correct launch flags and resolved launcher arguments on each launcher kind;
- `Content-Length` framing split across arbitrary stream chunks;
- `connect` success and legacy method-not-found-to-`ping` fallback;
- successful `account.getQuota` request without any session RPC;
- RPC error, process error, early exit, malformed frame, timeout, and abort;
- graceful `runtime.shutdown` and forced process-tree cleanup fallback;
- stderr remains bounded and absent from returned/logged errors;
- simultaneous refresh requests produce one probe per provider instance.

### Normalization tests

- finite `premium_interactions` percentage, totals, and ISO reset timestamp;
- `chat`/`completions` ordering and independent values;
- `remainingPercentage` is converted to `percentUsed` exactly once;
- unlimited entitlement does not synthesize a finite limit or warning;
- exhausted quota with and without overage permission;
- unknown bucket preservation;
- optional extra runtime fields and unknown fields are tolerated;
- `NaN`, infinities, negative used counts, invalid dates, missing records, and
  non-object payloads are rejected per bucket without crashing the refresh;
- all-invalid results become unavailable instead of a successful empty quota.

### Service/UI tests

- live snapshots persist and reload through the existing provider snapshot
  store;
- a failed refresh preserves the last successful snapshot and adds a safe error
  code;
- the picker renders percentage, totals, reset time, stale state, and unlimited
  state correctly;
- selection assist warns only for a fresh finite near-limit Copilot window;
- observed OTel token totals and provider monthly quota remain independent.

## Acceptance Criteria

- A refresh against an authenticated supported Copilot CLI returns an exact
  provider-live monthly percentage, used amount, entitlement, and reset time.
- The collector starts no session, sends no prompt, and consumes no model turn.
- The subprocess is short-lived and is reaped on success, error, timeout,
  cancellation, and extension teardown.
- The default implementation queries the same installed/authenticated Copilot
  CLI used by the harness and does not ship a duplicate Copilot runtime.
- Unknown quota keys and additive fields do not break known buckets.
- Unlimited and overage states are not misrepresented as ordinary finite
  remaining quota.
- Raw quota/auth payloads and credentials never enter logs or durable storage.
- Provider failure cannot block a workflow or erase a last-known good snapshot.
- Copilot's compact usage badge and pre-launch warning use provider quota;
  observed token totals remain separately labelled.
- Production bundle/VSIX checks prove no platform-specific Copilot binary was
  accidentally packaged.

## References

- GitHub Copilot SDK usage and billing metrics:
  https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing
- GitHub Copilot SDK bundled CLI setup:
  https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/bundled-cli
- GitHub Copilot SDK getting started / external server lifecycle:
  https://docs.github.com/en/copilot/how-tos/copilot-sdk/getting-started
- SDK and CLI JSON-RPC compatibility:
  https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility
- Official TypeScript SDK client source (transport, handshake, shutdown):
  https://github.com/github/copilot-sdk/blob/main/nodejs/src/client.ts
- Official generated TypeScript RPC types:
  https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/rpc.ts
- Official Copilot SDK repository:
  https://github.com/github/copilot-sdk
