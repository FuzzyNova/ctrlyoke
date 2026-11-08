# Code smell ledger

Durable record for the smell-hunt loop (`.ctrlyoke/templates/smell-hunt-loop.ctrlyoke.yaml`).
Each pass reads this before proposing work, so it never re-proposes something already
deferred or ruled out. One bullet per smell: files involved and a one-line reason.

## Passes

- **2026-11-08, pass 1** — hunted the harness layer and shared helpers. Fixed directly:
  `CopilotNotificationMonitor.buildHookConfig` re-implemented the base class's
  `encodePermissionRequestHook`; single-sourced matching JSON type guards and number
  parsers in `src/utils/JsonTypeGuards.ts`. Also routed exact inline
  `instanceof Error ? … : String(…)` source copies through `getErrorMessage` in
  `src/utils/ErrorUtils.ts`, removing five private copies across CLI, core, server and
  utilities while updating source call sites across workers and UI.

## Deferred

_None yet._

## Ruled out

- `isRecord` in `src/core/harness/copilot/CopilotQuotaClient.ts` — deliberately accepts
  arrays (it only probes RPC error objects for `.code`); different meaning from the shared
  plain-object guard.
- `isPlainObject` in `src/core/harness/opencode/OpenCodeInlineConfig.ts` and
  `src/ui/webview-react/utils/structuralSharing.ts` — also check the prototype
  (`Object.prototype` or `null`), which the generic guard does not; those callers need it.
- `scripts/*.mjs` copies of `isPlainObject`, `escapeRegExp`, `sleep`, `formatDuration` —
  standalone build scripts that must not import from `src/`.
- `QwenNotificationMonitor` building its node command without quotes while Copilot inlines
  quoted bash/PowerShell commands — intentional: each harness's hook runner parses the
  command differently (comments in both files explain why).
- `isRecord` in `src/core/harness/antigravity/AntigravityStreamJsonUsage.ts` and
  `src/license/LicenseService.ts` — their local `JsonRecord` aliases carry readonly or
  required fields; replacing them with `Record<string, unknown>` would widen/change the
  type guard contract.
- `instanceof Error` message handling outside the exact shared pattern — stack-preserving
  branches, literal fallbacks, error normalization and type checks have different output
  or purpose. Exact matches in `scripts/recover-runs-from-search-index.mjs` and test files
  were left outside this source refactor's scope; `src/utils/ErrorUtils.ts` retains the
  shared helper's own implementation.
