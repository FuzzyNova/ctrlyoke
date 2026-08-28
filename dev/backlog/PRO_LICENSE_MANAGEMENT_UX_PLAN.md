# Pro License Management UX Plan

**Created:** August 28, 2026
**Status:** Proposed.
**Builds on:** [`../implemented/PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) (IMPLEMENTED — `LicenseService`, both activation flows, gate sites, remote-access trial).
**Cross-cutting with:** [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md) — every new affordance in this plan must be reachable from a dashboard message, not a native VS Code dialog, so it survives the eventual `ctrlyoke server` standalone target.

---

## Why this plan exists

`PRO_LICENSE_PLAN.md` shipped the licensing *engine* — `LicenseService`, Keygen
integration, offline verification, the remote-access trial, and gate
enforcement — but its only user-facing surface is four Command Palette
entries (`ctrlyoke.activatePro`, `ctrlyoke.activateOfflinePro`,
`ctrlyoke.deactivatePro`, `ctrlyoke.manageLicense`), each driven by native
`showInputBox`/`showOpenDialog`/`showQuickPick` prompts. There is no page in
the dashboard where a user can see their license status, paste a key, import
an offline file, or manage which machines are activated. This plan adds that
surface, entirely inside `GlobalSettingsDrawer.tsx`, and fixes two real gaps
found while auditing `ServerSection.tsx`'s existing gates.

---

## Current-state audit

Read before implementing — several things the initial ask assumed are
missing already exist; the actual gaps are narrower.

### Already built (do not re-build)

| Capability                                                                                                              | Where                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LicenseService` takes a platform-neutral `SecretStore`, not `vscode.ExtensionContext`                                  | `src/license/LicenseService.ts:172-181` — already satisfies the decoupling plan's Capability Boundaries for this service.                                                                                                                                                                                               |
| `LicenseAccessState { isPro, hasRemoteAccess }` pushed to every dashboard client on load and live on entitlement change | `WebviewSettingsSync.resolveLicenseAccess`/`sendLicenseAccessUpdate`, wired from `LicenseService.onDidChangeEntitlement` in `CtrlYokeWebviewProvider.ts:175-180`; consumed client-side in `useMessageHandler.ts:485-486,555-556,573-574` into `settingsStore.licenseAccess`.                                            |
| Bind-address reach gate enforced at the actual socket, not just the UI                                                  | `CtrlYokeHostedServer.enforceRemoteBindBeforeListen()` (`src/server/CtrlYokeHostedServer.ts:2208-2218`) coerces any non-loopback `bindAddress` back to `127.0.0.1` before `listen()` when the entitlement lacks remote access — this is exactly `PRO_LICENSE_PLAN.md` §297's "enforce at `listen()`, not the dropdown." |
| `ServerSection.tsx` UI-level gates for remote/TLS/QR/icon color                                                         | The `0.0.0.0` bind option is already `disabled` (`ServerSection.tsx:215-216`), the whole HTTPS/TLS `<fieldset>` is already `disabled` when `!hasRemoteAccess` (`:568-570`), the QR button is already `disabled` (`:332`), and icon-color inputs are already `disabled` unless `isPro` (`:507,530`).                     |
| Settings-write-time gate for TLS + icon-color paths                                                                     | `WebviewSettingsSync.handleUpdateGlobalSetting` (`:1325-1360`) rejects `REMOTE_TLS_SETTING_KEYS` writes and icon-color writes with a typed upsell (`reportProUpsell`) when the entitlement doesn't cover them.                                                                                                          |

**Why the original ask read these as broken:** the 14-day remote-access
trial makes `hasRemoteAccess` `true` for every new install, so the bind
selector, TLS fieldset, and QR button are all genuinely *enabled* during the
trial — only `isPro` (never granted by the trial) keeps the icon-color
inputs locked. That reads as "only icon color is gated," but it is the
designed trial behavior, not a missing gate. The plan below still closes two
real gaps found in the same audit (next section) and adds the trial
countdown so this stops being ambiguous to the user.

### Real gaps this plan fixes

1. **`server.bindAddress` has no write-time gate.** `REMOTE_TLS_SETTING_KEYS`
   (`WebviewSettingsSync.ts:110-114`) covers `server.tls.enabled/certPath/keyPath`
   and the icon-color keys are checked separately, but `"server.bindAddress"`
   is checked nowhere in `handleUpdateGlobalSetting`. The dropdown option is
   disabled client-side, but a direct edit to `.ctrlyoke/settings.json` (or a
   future non-drawer writer) persists `"0.0.0.0"` with no server-side
   rejection — it is only ever corrected at the next `listen()` call, and
   silently, in memory.
2. **The `listen()`-time correction never round-trips back to the setting.**
   `enforceRemoteBindBeforeListen()` sets `this.bindAddress = "127.0.0.1"` on
   the in-memory server instance only. The persisted setting still reads
   `"0.0.0.0"`, so the (disabled) dropdown keeps showing the LAN option as
   selected forever, and the correction silently re-happens on every future
   launch instead of ever being reconciled. This is the literal ask —
   "auto switch to localhost on launch if they manually tried to change the
   setting in the settings file" — which today only half-happens (runtime
   yes, persisted setting no).
3. **No dashboard UI to actually manage a license.** Confirmed: no license
   affordance exists anywhere under `src/ui/webview-react/components/settings/`
   or `GlobalSettingsDrawer.tsx`'s tab list (`GlobalSettingsDrawer.tsx:33-54`).
   All four license commands are Command-Palette-only.
4. **No machine-management UX.** `LicenseService` can activate/release *this*
   machine (`activateMachine`/`releaseMachine`,
   `LicenseService.ts:496-537,623-635`) but has no way to list or remotely
   deactivate *other* machines on the same license — the only path today when
   a user hits the 10-machine cap is the generic rejection message in
   `toActivationError` (`:662-677`): "...or at its 10-machine limit," with no
   recovery short of the Keygen web dashboard.
5. **No "Pro Feature" visual treatment.** Per-row/per-section Pro badges and
   the requested brand-colored callout border don't exist; gating today is
   communicated only through `disabled` state plus a plain-text upsell
   paragraph.

---

## Decision

Build the license management surface as **one new tab in
`GlobalSettingsDrawer`**, driven entirely by typed dashboard messages routed
through the existing `WebviewMessageRouter` → `WebviewSettingsSync` →
`LicenseService` chain — the same pattern `server.enabled`/cert
generation/token regeneration already use (`WebviewMessageRouter.ts:1812-1833`).
No new native VS Code dialogs are added for anything that can instead be a
React form in the drawer; the four existing commands become thin facades
that either call the same service methods directly (kept for
Command-Palette convenience and muscle memory) or simply focus the panel and
open the new tab.

This keeps the feature fully usable from the hosted/standalone browser
dashboard once `ctrlyoke server` ships (`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`
Stage 10), since it never depends on `vscode.window.showInputBox` or
`showOpenDialog`. `LicenseService` itself already satisfies that plan's
capability boundaries (constructor-injected `SecretStore`); this plan only
adds new *public methods* to it, not new VS Code coupling.

**Important scoping note for the UI copy:** a Pro license activates the
*machine running the ctrlyoke extension host* (wherever the secret store
lives), not the browser tab used to submit the key. A user opening the
dashboard from their phone to activate Pro is still activating their desktop
machine. The License tab must say this explicitly (see Phase 3).

---

## Goals

- A user can view license status (tier, source, expiry, trial countdown),
  activate with a key, import an offline license file, and deactivate — all
  without leaving the dashboard or touching the Command Palette.
- A user who hits the machine limit can see their active machines and
  deactivate one from the same screen, then retry activation, without
  leaving ctrlyoke or visiting the Keygen portal.
- `ServerSection.tsx`'s Pro-gated rows get a clear, consistent "Pro Feature"
  visual treatment (badge + brand-colored callout border), and the two real
  gating gaps above are closed.
- A prominent, always-visible "Activate Pro" affordance in the settings
  drawer header routes straight to the new tab, and disappears once Pro is
  active.
- Every new interaction works identically in the VS Code panel and the
  hosted/standalone browser dashboard.

## Non-Goals

- Phase 2 sign-in/device-code activation (`activateWithSignIn`) — still
  future work per `PRO_LICENSE_PLAN.md` §Phase 2.
- Building a Keygen admin UI. Machine management here is scoped to *this
  license's* machines via the license-scoped Keygen API, not general account
  administration.
- Changing pricing, the trial length, or the EULA — those are commercial/legal
  decisions tracked in `PRO_LICENSE_PLAN.md`, not this UX plan.
- Rewriting `CustomSelect`/`SettingToggleRow`/`ActionButton` — reuse the
  existing shared components (`src/ui/webview-react/components/shared/`) as-is.

---

## Architecture

```text
GlobalSettingsDrawer (header)
  "Activate Pro" button ──(setActiveTab("license"))──► License tab

License tab (new LicenseSection.tsx)
  status card, activate form, import-file form, machine list
        │  postMessage(ACTIVATE_LICENSE_KEY / IMPORT_LICENSE_FILE /
        │              DEACTIVATE_LICENSE / REQUEST_LICENSE_MACHINES /
        │              DEACTIVATE_LICENSE_MACHINE)
        ▼
WebviewMessageRouter (table.set — same pattern as ENABLE_SERVER etc.)
        │
        ▼
WebviewSettingsSync (new license-focused handlers, or a small
                      LicenseSettingsHandlers delegate alongside it)
        │
        ▼
LicenseService (extension-host singleton, src/license/LicenseService.ts)
        │  new: listMachines(), deactivateMachine(machineId)
        │  existing: activateWithKey, importLicenseFile, deactivate,
        │            getEntitlement, hasRemoteAccess
        ▼
Keygen API (License-scoped Authorization header, same as today)
```

Responses flow back as typed messages (`LICENSE_MACHINES_UPDATED`,
`LICENSE_ACTION_RESULT`, plus the existing `LicenseAccessState` broadcast for
status) rather than reusing the generic `GLOBAL_SETTING_UPDATED`/upsell path
used for plain setting writes, because license actions are RPC-shaped
(activate/import/deactivate a specific machine) rather than "write this
settings.json path."

---

## Phase 1 — `LicenseService`: machine management + richer activation errors

File: `src/license/LicenseService.ts`.

1. **`listMachines(key: string): Promise<LicenseMachineSummary[]>`**
   - Resolve the license id from the key via the existing `validateKey()`
     (already does this for activation).
   - `GET /machines?license={id}` with `Authorization: License <key>`
     (same `keygenHeaders()` helper, same base-URL pattern as
     `checkoutLicense`/`activateMachine`). Keygen's current API reference
     exposes license machines through the account-wide machines listing with
     a `license` filter; its license relationship metadata links to the same
     resource but the relationship URL is not the listing endpoint used here.
   - Map each machine resource to a new `LicenseMachineSummary` (id,
     `name`/`platform` attributes, `created` timestamp) and flag whichever
     entry matches the locally stored `LICENSE_MACHINE_ID_SECRET_KEY` as
     `isThisMachine: true` so the UI can label it and disable its own
     deactivate button (deactivating "this machine" belongs to the existing
     `deactivate()` flow, which also clears local secrets — don't let the
     machine-list row silently desync local state from the server).

2. **`deactivateMachine(key: string, machineId: string): Promise<void>`**
   - Thin public wrapper around the existing private `releaseMachine(machineId, key)`
     (`:623-635`) — it is already generic over `machineId`, it just isn't
     exposed. If the deactivated machine is the caller's own
     (`machineId === stored activation`), also clear local secrets exactly
     like `deactivate()` does, so the local cached entitlement doesn't keep
     claiming Pro after the server-side activation is gone.

3. **Typed activation-limit error.** Extend `toActivationError()`
   (`:662-677`) so a Keygen `TOO_MANY_MACHINES` validation code — confirmed
   against Keygen's API reference: `TOO_MANY_MACHINES` fires when "the
   validated license has exceeded its policy's machine limit," distinct from
   `NO_MACHINE`/`NO_MACHINES` (node-locked/floating policies with zero
   machines, already handled) — throws a distinguishable
   `LicenseActivationLimitError extends UserFacingLicenseError`
   carrying the resolved `licenseId`. The UI catches this specific error type
   to switch straight into the machine-management view instead of showing a
   dead-end rejection message — this is the "remote deactivation ... for
   when they've hit their machine limit" flow from the request. Keygen's
   validation response uses `TOO_MANY_MACHINES`; machine creation can report
   the same condition as a 422 with `MACHINE_LIMIT_EXCEEDED`, so the service
   recognizes both at the activation rejection boundary.

4. **Trial countdown exposure.** Add `getRemoteAccessTrialEndsAt(): Promise<number | null>`
   — returns `null` when already Pro or when no `trialState` is configured,
   otherwise the same `startedAt + REMOTE_ACCESS_TRIAL_MS` computation
   `hasRemoteAccess()` already performs (`:207-231`), factored out so both
   methods share it instead of duplicating the lazy-init logic. Extend
   `LicenseAccessState` (`WebviewMessageTypes.ts:405-408`) with
   `trialEndsAt: number | null` and populate it alongside `isPro`/
   `hasRemoteAccess` everywhere `resolveLicenseAccess`/the inline factory in
   `CtrlYokeWebviewProvider.ts:169-172` builds one.

No changes to the signing/verification path, offline-grace logic, or the
webhook/Netlify side — this phase is additive to the existing class only.

---

## Phase 2 — Dashboard message types

File: `src/types/DashboardConstants.ts` (`MESSAGE_TYPES`), consumed by
`WebviewMessageRouter.ts` and the webview.

New message types, modeled directly on the existing `ENABLE_SERVER`/
`GENERATE_SERVER_CERT` pattern (`WebviewMessageRouter.ts:1812-1833`):

| Message (webview → extension) | Payload                 | Handler                                                                              |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `ACTIVATE_LICENSE_KEY`        | `{ key: string }`       | `licenseService.activateWithKey(key)`                                                |
| `IMPORT_LICENSE_FILE`         | `{ blob: string }`      | `licenseService.importLicenseFile(blob)`                                             |
| `DEACTIVATE_LICENSE`          | `{}`                    | `licenseService.deactivate()`                                                        |
| `REQUEST_LICENSE_MACHINES`    | `{}`                    | `licenseService.listMachines(storedKey)`                                             |
| `DEACTIVATE_LICENSE_MACHINE`  | `{ machineId: string }` | `licenseService.deactivateMachine(storedKey, machineId)`, then re-run `listMachines` |

| Message (extension → webview) | Payload                                                             | Sent                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LICENSE_MACHINES_UPDATED`    | `LicenseMachineSummary[]`                                           | After `REQUEST_LICENSE_MACHINES` and after a successful `DEACTIVATE_LICENSE_MACHINE`.                                                                                                                                                                                    |
| `LICENSE_ACTION_RESULT`       | `{ action: string; status: "success" \| "error"; message: string }` | After every license action, success or failure — this is the client-scoped typed result the drawer's `ActionButton` feedback slots consume (see Phase 3), replacing the native `notifyUserFeedback` toasts the VS Code commands currently use for these same operations. |

No separate `LICENSE_STATUS_UPDATED` message (see Open Question 1,
resolved): the status card's tier/source/expiry/trial fields ride the
existing `LicenseAccessState` broadcast instead — `sendLicenseAccessUpdate`
already fires on every `onDidChangeEntitlement` and already reaches every
client (`CtrlYokeWebviewProvider.ts:175-180`), so activate/import/deactivate
just need to trigger that same emitter (which they already do —
`LicenseService.activateWithKey`/`importLicenseFile`/`deactivate` all call
`this.changes.fire(...)`) rather than inventing a parallel push channel.

Add handlers in `WebviewMessageRouter.ts` next to the server ones
(`:1812-1833`), delegating into a small new set of methods on
`WebviewSettingsSync` (or a sibling `LicenseSettingsHandlers` class if
`WebviewSettingsSync` is judged too large already — check its current line
count before deciding; follow whichever keeps single-responsibility without
a premature split). These handlers need the stored license key to call
`listMachines`/`deactivateMachine` — read it via `secretStore.get(LICENSE_KEY_SECRET_KEY)`
through the same `LicenseService` instance rather than threading the raw
secret store into a second place.

Implementation uses the sibling `LicenseSettingsHandlers` class because
`WebviewSettingsSync` is already large. `LicenseService.getStoredLicenseKey()`
keeps the credential-store access inside the service. When activation fails
with `LicenseActivationLimitError`, the typed result keeps `status: "error"`
and uses the distinct `action: "licenseActivationLimit"` identifier so the
future drawer can open machine management without parsing user-facing copy.

**Client-scoped, not broadcast**, matching `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`
Stage 6/Phase 5's `WebviewClientContext` pattern: `LICENSE_ACTION_RESULT` and
`LICENSE_MACHINES_UPDATED` reply only to the requesting client
(`ctx.postMessage`, not `ctx.emit`/broadcast) — one browser tab's failed key
paste must not flash an error in every other connected client. The
`LicenseAccessState` broadcast that carries status *should* stay a broadcast,
since Pro status is genuinely global — this is just the existing
`sendLicenseAccessUpdate` behavior, unchanged.

---

## Phase 3 — License settings tab

New file: `src/ui/webview-react/components/settings/LicenseSection.tsx`,
registered in the barrel (`../settings` index used by
`GlobalSettingsDrawer.tsx:14-29`) and added to `ALL_TABS`
(`GlobalSettingsDrawer.tsx:33-54`) as `{ id: "license", label: "License", icon: "codicon-key" }`,
placed near the top of the tab list (e.g. right after "General") since it's
now a primary, not buried, destination. Add its render branch in the
`effectiveActiveTab` switch (`:228-296`) — it needs no `fullSettings` guard
since it doesn't read `FullGlobalSettings`, following the same pattern as
`SecretsSection`/`AgentSkillsManagerSection` which render unconditionally
(`:252-254,276-281`).

### Layout

1. **Status card** (always visible): tier badge (Free/Pro), source
   (online activation / offline license file), expiry (or "Perpetual"),
   and — when on trial and not yet Pro — a countdown ("Remote access trial:
   9 days left") sourced from the new `trialEndsAt` field. When Free and no
   trial has started yet, this card doubles as the entry point ("Your
   14-day remote-access trial starts the first time you enable it" — cross-
   reference actual trial-start semantics from Phase 1 item 4 rather than
   inventing new copy).

2. **Activate with key** — a single `LocalTextInput` (masked, like the
   existing `password: true` VS Code prompt) + `ActionButton` posting
   `ACTIVATE_LICENSE_KEY`, using the pending/success/error slots
   `ActionButton` already supports (`ActionButton.tsx`) fed by
   `LICENSE_ACTION_RESULT`. On a `LicenseActivationLimitError` result
   (Phase 1 item 3), skip the plain error state and instead surface the
   machine list inline (section 4) with a "Free up a slot, then retry"
   framing — no separate modal.

3. **Import offline license file** — a `<textarea>` for pasting the
   `-----BEGIN LICENSE FILE-----` blob (works identically in panel and
   browser) plus, **panel-only** (guarded by `!isStandalone`, matching the
   existing `!isStandalone &&` convention throughout `ServerSection.tsx`), a
   "Browse…" button that still uses the native file picker via the existing
   `ctrlyoke.activateOfflinePro` command path for convenience — browser
   clients get drag-and-drop-into-textarea or copy/paste only, since there
   is no standalone file-picker port yet per the decoupling plan's Phase 3
   item 6 ("headless CLI/server paths ... explicit defaults or unsupported
   results for operations that require user input"). Link to
   `docs/pro/index.md`'s air-gapped instructions (or the air-gapped
   activation example linked from `PRO_LICENSE_PLAN.md` if the docs page
   doesn't exist yet).

4. **Machine list** (Pro/online-activated only; hidden entirely when Free —
   there's nothing to list): a compact table fetched via
   `REQUEST_LICENSE_MACHINES` on tab mount, columns: name/platform,
   activated date, "This machine" tag on the caller's own row, and a
   `Deactivate` `ActionButton` per row (disabled on the caller's own row —
   that path is the dedicated "Deactivate Pro License" flow in item 5, not
   a row action, so a user can't accidentally strand themselves mid-list).
   This is the machine-limit recovery surface from the request.

5. **Deactivate this machine** — a plain confirm-then-`ActionButton`
   posting `DEACTIVATE_LICENSE`, replacing the current QuickPick
   confirmation (`extension.ts:597-627`) with an inline confirm (reuse
   whatever confirm pattern `WorktreesSection`/other destructive settings
   actions already use in this codebase, for consistency — audit before
   inventing a new one).

6. **Pricing link** — `LICENSE_UI.PRICING_URL` (`DashboardConstants.ts:68`),
   already the single source used everywhere else in `ServerSection.tsx`.

### Scoping copy

Per the Decision section above, add a one-line note near the activate form:
_"Activating applies to the machine running ctrlyoke, not this browser."_
Only needs to render when `isStandalone` is true (panel users are already
on that machine).

---

## Phase 4 — "Activate Pro" header affordance

File: `GlobalSettingsDrawer.tsx`, title bar (`:159-195`).

Add a centered button between the scope toggle and the exit button —
`licenseAccess.isPro ? null : <button onClick={() => setActiveTab("license")}>Unlock Pro Features</button>`,
reading `licenseAccess` from `useSettingsStore` exactly as `ServerSection.tsx`
already does (`ServerSection.tsx:49`). Style it with the new brand-color
token (Phase 5) so it reads as a distinct call-to-action rather than another
toolbar icon button, but keep it text+icon sized to fit the existing 30px
title bar row height (`h-[30px]`, `:160`) — no layout changes to the bar
itself. Once Pro, this button disappears entirely (not just disabled) so the
header stays uncluttered for paying users; the License tab remains reachable
normally from the tab list for status/machine management.

---

## Phase 5 — `ServerSection.tsx` gating fixes and Pro Feature styling

### 5.1 Close the two real gaps (see audit)

1. Add `"server.bindAddress"` to a settings-write gate in
   `WebviewSettingsSync.handleUpdateGlobalSetting` (`:1325-1360`). Simplest
   correct fix: extend the existing `isRemoteTlsSetting` check (or rename it
   `isRemoteAccessSetting`) to also cover the bind-address path when the
   incoming `value` is a non-loopback address — a *write* of `"127.0.0.1"`
   must still be allowed unconditionally (downgrading is never gated), only
   a write attempting a non-loopback value needs `hasRemoteAccess`. Reuse
   `isLoopbackBindAddress()` from `CtrlYokeHostedServer.ts:2422-2427` (export
   it, or move it to a shared location both files can import — do not
   duplicate the loopback-address list).
2. **Decided: fallback banner, not a settings rewrite** (Open Question 2,
   resolved). Make `enforceRemoteBindBeforeListen()`
   (`CtrlYokeHostedServer.ts:2208-2218`) surface its correction the same way
   `portFallback` already does, rather than silently rewriting
   `.ctrlyoke/settings.json`. Concretely, mirror the `portFallback` shape end
   to end:
   - Add a `bindAddressFallback: { requestedBindAddress: string; actualBindAddress: string } | undefined`
     field alongside wherever `portFallback` is tracked and surfaced to the
     webview (trace `portFallback`'s producer — likely a field set in
     `CtrlYokeHostedServer` and read by `extension.ts`'s
     `webviewProvider.setRunningServerUrl(url, availableIps, portFallback)`
     call at `extension.ts:1349` — and add the bind-address equivalent at the
     same seam).
   - Populate it inside `enforceRemoteBindBeforeListen()` when it coerces
     away from a non-loopback value, instead of (or alongside) the current
     `notifyRemoteAccessBlocked()` one-shot toast (`:2220-2224`).
   - In `settingsStore.ts`, add `bindAddressFallback` next to the existing
     `portFallback` state (`:...` — same store, same pattern).
   - In `ServerSection.tsx`, render it exactly like the existing
     `portFallbackForCurrentSetting` banner (`:149-152,423-434`): only while
     it still describes the *currently configured* `bindAddress` (so editing
     the dropdown back to loopback — or any further edit — clears the stale
     warning), with copy like "ctrlyoke started on localhost only — a Pro
     license or active trial is required for All Interfaces (0.0.0.0)."
   This keeps the user's hand-edited file intent visible (never silently
   rewritten) while still delivering the "auto switch to localhost on
   launch" behavior the request asked for — the effective bind is corrected
   every launch, and the user is told why, exactly like the port-conflict
   case.

### 5.2 Per-row "Pro Feature" callout on the bind selector

**Decided (Open Question 3, resolved):** reuse `SelectOption.description`
rather than adding a new badge slot to `CustomSelect`. `CustomSelect.tsx`
already renders a per-option secondary line for exactly this purpose —
`option.description`, shown as muted `text-xxs text-description-fg` under
the label in both the visible-option row (`CustomSelect.tsx:188-195`) and
the hidden-option row (`:249-256`), truncated via the existing
`truncateOptionDescription` helper (`:20-27`). There is no `badge`/`meta`
slot on `SelectOption` (`:12-18`), and adding one would touch three render
paths (closed-trigger label at `:301`, visible-option row, hidden-option
row) to support a single call site — `CustomSelect` is used across roughly
a dozen other settings dropdowns, so a bespoke badge prop built for one Pro
row is the kind of premature, single-caller abstraction the project's
coding principles ask to avoid. `description` is a closer semantic fit
anyway (secondary explanatory text, not a status pill), and needs zero
`CustomSelect` changes.

Set `description: "Pro feature — unlocks with a Pro license or an active remote-access trial"`
on the `0.0.0.0` entry in `bindAddressOptions` (`ServerSection.tsx:209-217`).
This is visible while the dropdown is open (browsing options), which is the
moment a non-Pro user is actually looking at that row — the existing
below-the-select upsell paragraph (`:466-478`) still covers the closed-state
case. If a future call site wants a stronger visual (e.g. a colored pill),
revisit `CustomSelect` then, once there's a second real caller to justify
the shared API surface — not preemptively for this one.

### 5.3 Brand-colored "Pro Feature" callout border

Add a theme-independent brand token to
`src/ui/webview-react/tailwind.config.js`'s `colors` block, following the
existing theme-independent-constant convention (`favorite: "#e5c014"`,
`"bash-expand-link": "#569cd6"`, `tailwind.config.js:269-272`):

```js
"pro-brand": "#3994BC",
```

Wrap the Icon Colors section (`ServerSection.tsx:484-564`) and the
HTTPS/TLS section (`:567-732`, the `<fieldset>`) each in a container with
`border border-pro-brand rounded` and a small label above the border reading
"Pro Feature" in `text-pro-brand`, sized/positioned like a fieldset legend.
Do **not** apply this treatment to the bind-address row (5.2 already
labels it) or to the standalone-only cert-download block (`:735-773`) — it's
a sub-view of the already-bordered TLS story, bordering it again would nest
borders pointlessly.

---

## Phase 6 — Command facades

`src/extension.ts` commands stay registered (Command Palette discoverability
matters, and `package.json`'s existing four entries are fine as-is), but
change what they *do*:

- **`ctrlyoke.manageLicense`** (`:629-655`): replace the `showQuickPick`
  body with `await workflowOrchestrator.openPanel(); webviewProvider.openGlobalSettingsTab("license");`
  — the exact pattern `ctrlyoke.openSecretsSettings` already uses
  (`:494-500`). Widen `openGlobalSettingsTab`'s parameter type
  (`CtrlYokeWebviewProvider.ts:1313`) from the literal `"secrets"` to
  `"secrets" | "license"` (or generalize it to accept any tab id already in
  `ALL_TABS` — check whether a shared tab-id union type exists yet; if not,
  this is a reasonable place to introduce one rather than stringly-typing
  further).
- **`ctrlyoke.activatePro`** and **`ctrlyoke.activateOfflinePro`**: leave
  their native-dialog bodies as-is for now — they're a legitimate quick path
  for panel users who don't want to open the drawer, and the underlying
  `licenseService.activateWithKey`/`importLicenseFile` calls are already
  shared with the new dashboard path, so there's no duplicated logic, only a
  duplicated entry point. Optionally (not required) have them finish by also
  calling `openGlobalSettingsTab("license")` so the result is visible in the
  status card immediately.
- **`ctrlyoke.deactivatePro`**: same treatment as `manageLicense` — the
  QuickPick confirmation can stay, or be simplified to route into the new
  tab's confirm control. Low priority; either is correct.

No `package.json` changes are required by this plan — the four commands in
`#selection:package.json:100-118` remain valid entries.

---

## Testing Strategy

- **`LicenseService` unit tests** (extend `src/test/unit/LicenseService.test.ts`):
  `listMachines()` parses a multi-machine Keygen response and flags the
  caller's own machine correctly; `deactivateMachine()` calls the right
  endpoint and clears local secrets only when deactivating the caller's own
  machine id; a `TOO_MANY_MACHINES`-coded validate response throws
  `LicenseActivationLimitError` with the license id attached;
  `getRemoteAccessTrialEndsAt()` matches `hasRemoteAccess()`'s existing
  window math exactly (same fixture clock).
- **`WebviewSettingsSync`/router tests**: each new message type resolves to
  the right `LicenseService` call; `LICENSE_ACTION_RESULT`/
  `LICENSE_MACHINES_UPDATED` reply only to the requesting client (two-tab
  isolation test, same shape as `CoreFeedbackMigration.test.ts:25-45`);
  `LICENSE_STATUS_UPDATED` does broadcast to all clients.
- **`handleUpdateGlobalSetting` bind-address gate test**: a non-loopback
  `server.bindAddress` write is rejected without remote access and accepted
  with it; a loopback write is always accepted regardless of entitlement.
- **`enforceRemoteBindBeforeListen` fallback-banner test**: after a coerced
  start, `bindAddressFallback` is populated with the requested/actual
  values, reaches the webview the same way `portFallback` does, and the
  persisted `server.bindAddress` setting itself is left untouched (never
  silently rewritten) — only the in-memory bind and the surfaced banner
  reflect the correction.
- **React tests** (`src/ui/webview-react/test/components/settings/`): new
  `LicenseSection.test.tsx` covering the activate/import/deactivate/machine-
  list flows against a mocked `vscode` API, plus a render test confirming
  the drawer header's "Unlock Pro Features" button is absent when
  `licenseAccess.isPro` is true.
- **Manual verification**: run the dev host (`npm run dev:host:start`),
  activate against a real test key from `dev/test_keys.md` (gitignored, per
  `PRO_LICENSE_PLAN.md`'s Verification Plan), confirm the machine list shows
  the activation, deactivate it from the list, confirm re-activation
  succeeds — this is the actual "hit the machine limit, recover without
  leaving ctrlyoke" path end to end.

---

## Open Questions

All four resolved 2026-08-28:

1. ~~**Fold `LICENSE_STATUS_UPDATED` into the existing `sendLicenseAccessUpdate`
   broadcast, or keep them separate?**~~ **Resolved: fold them.** No separate
   message type — extend `LicenseAccessState` with `source`/`expiresAt`/
   `trialEndsAt` and let the status card read the existing broadcast. See
   Phase 2's note under the message table.
2. ~~**Settings-file rewrite vs. fallback banner for the bind-address
   correction.**~~ **Resolved: fallback banner**, matching `portFallback`
   exactly (`bindAddressFallback`, same producer/store/UI seam). See Phase
   5.1 item 2 for the full plumbing trace.
3. ~~**`CustomSelect` badge slot vs. label-suffix fallback.**~~ **Resolved:
   neither — reuse the existing `SelectOption.description` field.** It
   already renders exactly this kind of secondary explanatory text with no
   component changes; a bespoke badge prop for one call site would be a
   premature abstraction across a widely shared component. See Phase 5.2.
4. ~~**Exact Keygen validation code for the machine-limit case.**~~
   **Resolved: `TOO_MANY_MACHINES`**, confirmed against Keygen's API
   reference — fires when "the validated license has exceeded its policy's
   machine limit," distinct from `NO_MACHINE`/`NO_MACHINES` (node-locked or
   floating policy with zero associated machines) and from the per-resource
   `TOO_MANY_CORES`/`TOO_MUCH_MEMORY`/`TOO_MUCH_DISK`/`TOO_MANY_PROCESSES`
   variants, none of which apply to ctrlyoke's plain machine-count policy.
   See Phase 1 item 3.

---

## Related Documents

- [`../implemented/PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) — the licensing engine this plan builds a UI on top of.
- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md) — why every new interaction here is message-routed rather than a native dialog.
- Keygen: [licenses/machines relationship API](https://keygen.sh/docs/api/machines/) · [validate-key response codes](https://keygen.sh/docs/api/licenses/#licenses-actions-validate) (`TOO_MANY_MACHINES` etc. — confirmed 2026-08-28, see Open Question 4).
