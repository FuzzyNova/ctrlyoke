# ctrlyoke Release Checklist

**Created:** June 19, 2026 (as `FlightPath Release Checklist`)
**Rewritten:** August 25, 2026 — consolidated into the single canonical, ctrlyoke-branded release checklist.
**Status:** Business/domain cutover is DONE. Pro-licensing vendor accounts (Keygen, Lemon Squeezy) exist and were configured live in this session — see Phase 4/5 for exact current state. Extension-side `LicenseService` implementation (Phase 6) is the largest remaining blocker.
**Purpose:** the one place to look for "what's left before `ctrlyoke` ships" — product release, vendor/licensing setup with exact click-by-click steps, legal, and launch verification.

> **This document supersedes [`RELEASE_PLAN.md`](RELEASE_PLAN.md) and [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md).** Both are kept as historical record (their content described real work, most of it now done) but are no longer the place to look for open items — that's here. [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) remains the engineering design doc for `LicenseService`; this checklist is the execution tracker. [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) is left untouched as a FlightPath-era generic how-to-use-`vsce` reference — its mechanics (package/login/publish commands) are still accurate, just still branded FlightPath; Phase 9 below has the ctrlyoke-branded equivalent commands.

---

## How this doc is organized

1. **Phase 1–3** — extension/site readiness and business cutover. **All done.** Kept brief.
2. **Phase 4–5** — Pro licensing vendors (Keygen, Lemon Squeezy). **Partially done — exact remaining steps below**, current as of a live walkthrough of both dashboards on August 25, 2026.
3. **Phase 6** — Pro licensing *implementation* (the `LicenseService` code in the extension). **Not started** — the single largest remaining blocker.
4. **Phase 7–12** — legal, final packaging, marketplace publish, GitHub release, npm (deferred), launch verification.

---

## Phase 1 — Release Foundation ✅ DONE

- [x] Package metadata, extension display name, repository URL, icon, categories, marketplace publisher — all `ctrlyoke` / `fuzzynova` / `FuzzyNova/ctrlyoke` / `ctrlyoke.dev`.
- [x] Source-available under a custom commercial EULA — decision made, draft exists (`LICENSE_DRAFT.md`), attorney review still open (Phase 7).
- [x] Seven harnesses, Antigravity CLI swap, `gemini-cli` fully removed.
- [x] Pre-publish security review complete.

Full detail: [`RELEASE_PLAN.md`](RELEASE_PLAN.md) §1, §2.1–2.2, §2.5, §2.10 (kept as historical record of this work).

---

## Phase 2 — Website & Docs ✅ DONE

- [x] `ctrlyoke.dev` Astro site live: home, `/pricing`, `/terms`, `/privacy`, `/docs/` (VitePress merged).
- [x] Netlify deploy pipeline (`deploy.yml`, `deploy-preview.yml`) green.
- [x] Pre-launch `LAUNCHED` flag in `landing/src/config.ts` still gates checkout CTAs — flip at go-live (Phase 9).

---

## Phase 3 — ctrlyoke Business & Domain Cutover ✅ DONE

Everything in [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md) §1–5 is complete and verified:

- [x] `ctrlyoke.dev` DNS + Netlify primary domain; `flightpath.dev` → `ctrlyoke.dev` 301 redirect live.
- [x] Google Workspace: `support@`, `billing@`, `security@`, `sales@`, `privacy@`, `licensing@` all on `@ctrlyoke.dev`, SPF/DKIM/DMARC configured.
- [x] GitHub repo renamed `FuzzyNova/flightpath` → `FuzzyNova/ctrlyoke`.
- [x] VS Code Marketplace publisher item `fuzzynova.ctrlyoke` reserved (published-then-unpublished to lock the name; real publish is Phase 9).

**Remaining from that doc — folded into Phase 4/5 below, not tracked separately anymore:** Lemon Squeezy and Keygen "create fresh under ctrlyoke" (§6–§7 of the cutover doc). Treat those two sections of `CTRLYOKE_REBRAND_CUTOVER.md` as superseded by this checklist.

---

## Phase 4 — Pro Licensing Vendor: Keygen

**Status: mostly configured.** A live walkthrough of `app.keygen.sh` on August 25, 2026 found the product and policy already existed (pre-dating this session) and just needed a rename; below is the exact current state plus what's still open.

### 4.1 Current state (verified live)

| Item | Value | Notes |
| --- | --- | --- |
| Product | **ctrlyoke** | `id: f4af3c3b-4350-4a6e-af09-744797abb4b0`. Distribution Strategy: `LICENSED`. Permissions: `license.read`, `license.validate`, `machine.create`, `machine.delete`, `machine.read`. |
| Policy | **ctrlyoke Pro** | `id: da0764ce-6577-419a-862d-128efdbfc329`. Renamed live this session from stale `FlightPath Pro` — no other field needed changing. |
| Policy config | Duration: Unlimited (perpetual) · Scheme: `ED25519_SIGN` · Floating: true · Max Machines: 10 · Strict: true · Expiration Strategy: Restrict Access | Matches [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) §1.1 exactly. **No changes needed.** |
| Ed25519 public key (hex) | `4cf46fe061bf97080094f14430fa2a1563f1b245cd600ccb99039bfff43836fa` | Settings → Public Keys. This is the value to embed as a build constant for offline license-file verification ([`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) §1.4). |
| Account ID | `6ed6209c-6633-4444-9d43-ab4a473e2f28` | **Use this in API URLs, not the slug.** Keygen's own UI flags the slug (`fuzzynova`) with a warning: *"We recommended that you use your account ID instead of your account slug when integrating Keygen within your product."* |
| Admin token | `admin-token`, id `247871a7…`, created ~2 months ago | Value is **not recoverable** from the dashboard (shown once at creation) — see 4.2 below. |
| Billing plan | **Dev 1** — $0/mo, 2,500 API requests/day, 100 licensed-user limit, 1 product limit, 10 policy limit | See 4.3 below — this is a real pre-launch decision, not just a "leave it" item. |
| Webhook endpoints | None configured | Not required for the Phase 1 flow (Lemon Squeezy → Netlify Function → Keygen API is one-directional; Keygen doesn't need to call back out). Leave empty unless a future feature needs Keygen-initiated events. |
| Enterprise policy (§1.7.1 self-serve SKU) | Does not exist yet | Not urgent — only needed when the Enterprise SKU ships (Phase 6, step 13 in the implementation order). |

### 4.2 Open item — confirm admin token custody

- [ ] **Confirm you still have the `admin-token` value saved somewhere** (password manager, or already in a `.env`/secrets file). Keygen never shows a token value again after creation, so if it's lost, the fix is: Keygen dashboard → **API Tokens** → **New Token ▾** → create a new admin-scoped token, then revoke the old `247871a7…` one so there's only one live admin credential. This token is what the Netlify webhook function will use server-side to call `POST /v1/accounts/6ed6209c-6633-4444-9d43-ab4a473e2f28/licenses` — it must **never** ship inside the VSIX.

### 4.3 Open decision — Dev tier vs. paid Keygen plan

The account is on the free **Dev 1** plan: 2,500 API requests/day and a **100 licensed-user limit**. Keygen's Dev tier is intended for building/testing, not necessarily unlimited production traffic — confirm at [Keygen pricing](https://keygen.sh/pricing/) (billing page shows an "Open Billing Portal" button — **Settings → Billing**) whether Dev tier is safe to launch on or whether it needs upgrading before the 100th Pro customer activates. At $59/customer, hitting the 100-user cap means ~$5,900 in sales — plausible within the first weeks/months post-launch, so this is worth deciding **before** launch, not after a customer gets rejected.

- [ ] Decide: launch on Dev 1 and upgrade reactively when approaching the 100-user cap, or upgrade proactively before publishing.

### 4.4 Optional — Enterprise policy (defer until the SKU is needed)

When ready to build the self-serve Enterprise SKU ([`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) §1.7.1):

1. Keygen dashboard → **Policies** → **New Policy**.
2. Name: `ctrlyoke Enterprise`.
3. Duration: **1 Year** (annual, not perpetual — matches the subscription billing model).
4. Scheme: `ED25519_SIGN` (same as Pro, for one shared verification path).
5. Max Machines: leave blank / effectively unlimited (site license — "unlimited seats" is enforced by *not* setting a machine cap, per the plan).
6. Floating: checked. Strict: checked.
7. Product: `ctrlyoke` (same product as Pro).

---

## Phase 5 — Pro Licensing Vendor: Lemon Squeezy

**Status: store rebranded and product drafted live this session.** Before this session, the LS store existed under the old `Fuzzy Nova` branding with **zero products** — this vendor was much further behind than Keygen. Below is exact current state plus the exact remaining steps.

### 5.1 Current state (verified/changed live, August 25, 2026)

| Item | Value | Notes |
| --- | --- | --- |
| Store name | **ctrlyoke** | Changed live this session from `Fuzzy Nova`. Settings → General → "Store name" — appears on every receipt/invoice. |
| Store URL | **ctrlyoke.lemonsqueezy.com** | Changed live this session from `fuzzynova.lemonsqueezy.com`. |
| Contact email | **support@ctrlyoke.dev** | Changed live this session from `admin@fuzzno.com`. This is the address shown to customers on receipts/invoices for support. |
| Store activation | **"In Review"** (Identity verification) | Banner reads *"Your application has been received and will be reviewed as soon as possible."* This is Lemon Squeezy's own KYC/underwriting step — **nothing to click, just waiting on LS.** No live payments can process until this clears. |
| Test mode | **ON** | Toggle top-right of every LS dashboard page. Real charges are impossible while this is on, regardless of store-activation status. |
| Product | **ctrlyoke Pro**, id `1317307` | Created live this session. Status: **Draft** (not published — see 5.3). |
| — Price | **$59.00**, Single payment (one-time) | Matches [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) §1.7. |
| — Tax category | **Software** | Chosen over the form's default "SaaS - personal use" — ctrlyoke Pro is a perpetual license unlocking local functionality, not a hosted service Fuzzy Nova operates on the buyer's behalf. Decided live this session. |
| — Generate license keys | **OFF (unchecked)** | Correct per plan — Keygen issues the real license, not Lemon Squeezy's native key system. |
| — Display on storefront | **ON** | Will show once published. |
| — Confirmation modal / email receipt copy | Set to explain the Keygen key arrives by separate email | See 5.2 — this is the resolution of the plan's previously-open "key delivery" question. |
| Webhooks | **None configured** | Blocked on the Netlify function existing (see 5.4 — chicken-and-egg: need the function's URL before creating the LS webhook, and need the webhook's signing secret before finishing the function). |
| API keys | **None created** | Not needed for the Phase 1 flow — the Netlify function only *receives* LS webhooks and *calls out* to Keygen; it doesn't need to call back into the LS API for the MVP (order/refund payloads carry enough data). Skip unless a future feature needs it. |
| Payouts | Bank account connected (**•••• 0725, USD**) | Good — a payout method exists. |
| Payout tax info | **NOT submitted — "[Action Required] Submit your tax information to avoid payout delays"** | Settings → Payouts → **"Submit your tax information"** link → Payouts → Tax details. Do this regardless of launch timing; it gates actually receiving money, not just going live. |
| Custom checkout domain | Not connected | Optional polish (e.g. `checkout.ctrlyoke.dev`) — Settings → Domains → currently empty. Not a blocker. |
| Store logo | Still the default letter-avatar | Cosmetic — Settings → General → Logo → upload the ctrlyoke icon PNG whenever convenient. Not a blocker. |

### 5.2 Resolved — key delivery mechanism

The plan's open question #4 ("LS custom fulfillment vs. our own transactional email") is now resolved by simply looking at what Lemon Squeezy's product form offers: **"Links" is 3 static URL fields (not dynamic), "Generate license keys" is LS's own key system (not used), and there is no field to inject a third-party value into checkout or the receipt.**

**Decision: the Netlify webhook function sends the Keygen key by email** after creating the license. Lemon Squeezy's own receipt stays a plain payment receipt (its copy, set live this session, tells the buyer to expect a separate email). This means:

- [ ] Pick a transactional email provider for the Netlify function to send from (Resend, Postmark, or SES — not yet chosen; any of the three work fine from a Netlify Function).
- [ ] Add that provider's API key as a Netlify environment variable alongside the Keygen admin token and LS webhook secret.

### 5.3 Remaining steps — in order

1. **Build the Netlify Function** (`netlify/functions/ls-webhook.ts`) per [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) §1.2–§1.4 — this is engineering work, tracked under Phase 6, not a dashboard click. It needs to exist (deployed, with a stable URL) before step 2.
2. **Create the LS webhook**, once the function URL exists:
   - Lemon Squeezy dashboard → **Settings → Webhooks** → **+** (currently empty).
   - URL: the deployed Netlify function URL (e.g. `https://ctrlyoke.dev/.netlify/functions/ls-webhook`).
   - Events to subscribe: `order_created` (issue the license), `order_refunded` (revoke it). Add `subscription_payment_success` / `subscription_cancelled` / `subscription_expired` later, only once the Enterprise annual SKU exists.
   - Save — Lemon Squeezy will show a **signing secret** exactly once. Copy it into the Netlify function's environment as `LEMONSQUEEZY_WEBHOOK_SECRET` immediately; it's used to verify the HMAC signature on every incoming webhook call.
3. **Publish the product** (Products → ctrlyoke Pro → **Publish product** button) once the webhook is live and has been smoke-tested with a **test-mode** purchase (Test mode toggle stays ON for this) — confirm the function fires, creates a Keygen license, and the email actually arrives.
4. **Submit payout tax info** (5.1 — independent of the above, do whenever).
5. **Wait for / follow up on** Lemon Squeezy's identity-verification review before flipping Test mode off for real charges.
6. Only after 1–5: flip **Test mode OFF**, set `CHECKOUT_URL` in `landing/src/config.ts` to the real LS checkout link for the published product, and flip `LAUNCHED = true` (Phase 9).

### 5.4 Why the ordering matters (chicken-and-egg)

You can't create the LS webhook without a target URL, and the Netlify function's webhook-signature verification needs the secret LS only reveals *after* the webhook is created. Standard resolution: deploy the function first pointed at a placeholder/no-op secret, create the LS webhook against the now-live URL, copy the real secret back into the function's env vars, redeploy. This is normal for any webhook-consumer setup — not ctrlyoke-specific.

---

## Phase 6 — Pro Licensing Implementation (extension code)

**Status: NOT STARTED.** This is the largest remaining blocker — everything in Phase 4/5 above just gets the *vendor side* ready; the extension itself has no license gating built yet. Full design lives in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) §1.4–§1.9; this is the execution checklist.

- [ ] `LicenseService` interface + `Entitlement` type (`src/license/LicenseService.ts`).
- [ ] `PRO_FEATURES` constants in `DashboardConstants.ts` (no hardcoded feature-flag strings at gate sites).
- [ ] Embed the Keygen Ed25519 public key (4.1 above) as a build constant.
- [ ] Offline `getEntitlement()` — Ed25519 signature + expiry verification, no network, fail-open to free on any error.
- [ ] `activateWithKey()` — online activation via Keygen, cache signed license file in `vscode.SecretStorage`.
- [ ] `importLicenseFile()` — air-gapped offline import, zero network calls.
- [ ] Commands: `ctrlyoke: Activate Pro License`, `ctrlyoke: Activate Offline (Air-Gapped) License`, `ctrlyoke: Deactivate Pro License`, `ctrlyoke: Manage License`.
- [ ] Gate sites (§1.8 of the plan): remote bind (`0.0.0.0`) enforcement at `CtrlYokeHostedServer.listen()`, LAN IP selector + QR-to-phone in `ServerSection.tsx`, HTTPS/cert generation, mobile push, custom icon color, air-gapped activation command itself.
- [ ] 14-day remote-access trial timer in `globalState`.
- [ ] Production-build verification of the **unlicensed free path** — nothing above should ever block core workflow execution.
- [ ] `docs/pro/index.md` — online + air-gapped activation instructions, referencing the real Keygen/LS setup above.

---

## Phase 7 — Legal & Support

- [x] Attorney-drafted EULA + Privacy Policy exist as canonical `LICENSE.md` / `PRIVACY.md`.
- [x] Effective-date placeholders (`[DATE]`) replaced with real dates.
- [ ] **Final attorney sign-off** on the custom commercial EULA text itself (draft exists at `LICENSE_DRAFT.md` — confirm it's actually been reviewed, not just drafted).
- [ ] `package.json#license` → `SEE LICENSE IN LICENSE.md` once the final EULA replaces the current placeholder text.
- [ ] Publish `ctrlyoke.dev/terms` plain-language summary (the legal page itself is already live rendering `LICENSE.md` directly).
- [ ] Keep public GitHub Issues for community reports; `support@ctrlyoke.dev` stays private for Pro/Enterprise support (both already exist).

---

## Phase 8 — Final Package Inspection

Run immediately before publishing (not before — confirm against the final, licensing-gated build):

```powershell
npm run package
npx vsce ls
```

Confirm:

- [ ] `out/ui/webview-react/` assets included.
- [ ] `out/mcp-server.js` included.
- [ ] `out/cli.js` **not** included.
- [ ] `node_modules/node-pty/` included.
- [ ] `.ctrlyoke/`, `.agents/`, local logs, prompts, test logs, dev-only files **not** included.
- [ ] Generated VSIX version matches `package.json` (currently `0.1.0`).
- [ ] `npm audit` — no new production advisories since the last check (dev-only findings tracked in `DEPENDENCY_UPGRADE_PLAN.md` are fine to carry).

**Also still open from the original plan, unrelated to licensing:**

- [ ] **Screenshots + demo GIF** for README/Marketplace — promoted to a release blocker (Nathan, July 4, 2026). Capture last, after Phase 6 UI (license status surface, upsell prompts) is final, since those are now part of the dashboard's first impression.
- [ ] Confirm dev-only command `ctrlyoke: Developer Tools` stays hidden unless `ctrlyoke.devMode` is set.

---

## Phase 9 — Marketplace Publish

- [x] Publisher `fuzzynova` confirmed, item id `fuzzynova.ctrlyoke` reserved (published-then-unpublished during the cutover).
- [ ] Generate/verify an Azure DevOps PAT with Marketplace **Manage** scope (see [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) §"Create a Personal Access Token" — mechanics unchanged, just ignore the FlightPath naming in that doc).
- [ ] `npx vsce login fuzzynova`
- [ ] `npm run package && npx vsce publish` (or `npx vsce publish --packagePath ctrlyoke-0.1.0.vsix`)
- [ ] Post-publish: confirm listing loads, README renders, CHANGELOG tab shows `0.1.0`, install into a clean profile, run one workflow.
- [ ] Flip `LAUNCHED = true` and set the real `CHECKOUT_URL` in `landing/src/config.ts` (only after Phase 5 checkout is verified end-to-end).

---

## Phase 10 — GitHub Release

- [ ] Tag `v0.1.0`.
- [ ] Create GitHub Release from the `CHANGELOG.md` `[0.1.0]` entry.
- [ ] Attach the final `ctrlyoke-0.1.0.vsix`.
- [ ] Confirm the release URL is under `FuzzyNova/ctrlyoke` (already renamed — just a sanity check).

---

## Phase 11 — npm CLI Package (deferred)

Not a Marketplace-release blocker. `package.json#bin.ctrlyoke` → `./out/cli.js` already exists and is excluded from the VSIX. Revisit packaging decision (root package with a `files` allowlist vs. dedicated CLI package) after the extension ships.

---

## Phase 12 — Launch Verification

- [ ] Clean VSIX install, no license: all free functionality works.
- [ ] Remote-access trial activates for a fresh install; 14-day window enforced.
- [ ] Trial expiry falls back to localhost-only without breaking workflows.
- [ ] Pro activation (online key) unlocks remote dashboard + other Pro features immediately, no restart.
- [ ] Air-gapped license file import unlocks Pro with zero network calls.
- [ ] Lemon Squeezy **test-mode** order → exactly one Keygen license created, webhook retry doesn't duplicate it.
- [ ] Refund (test mode) → Keygen license suspended/revoked.
- [ ] Pricing page checkout link points at the real, published, live-mode LS product.
- [ ] README, docs, Marketplace listing, and website agree on support address, license terms, and pricing.

---

## Summary Table

| Item | Status | Notes |
| --- | --- | --- |
| Extension packaging/build readiness | DONE | Phase 1 |
| Website + docs | DONE | Phase 2 |
| Business/domain cutover (DNS, email, GitHub, Marketplace item reservation) | DONE | Phase 3 |
| Keygen product + Pro policy | DONE | Phase 4.1 — renamed live this session |
| Keygen admin token custody confirmed | OPEN | Phase 4.2 |
| Keygen billing tier decision (Dev vs. paid) | OPEN | Phase 4.3 |
| Keygen Enterprise policy | DEFERRED | Phase 4.4 — not needed until the Enterprise SKU |
| Lemon Squeezy store rebrand | DONE | Phase 5.1 — done live this session |
| Lemon Squeezy product (ctrlyoke Pro, draft) | DONE (draft) | Phase 5.1 |
| Lemon Squeezy identity verification | OPEN (waiting on LS) | Phase 5.1 — nothing to click |
| Lemon Squeezy payout tax info | **OPEN — ACTION REQUIRED** | Phase 5.1 |
| Netlify webhook function + LS webhook wiring | OPEN | Phase 5.3 — engineering work |
| Transactional email provider for key delivery | OPEN (undecided) | Phase 5.2 |
| **`LicenseService` implementation** | **OPEN — largest remaining blocker** | Phase 6 |
| Attorney sign-off on final EULA | OPEN | Phase 7 |
| Screenshots + demo GIF | OPEN | Phase 8 |
| Final `vsce ls` package inspection | OPEN | Phase 8 — run right before publish |
| Marketplace publish | BLOCKED on Phase 6 | Phase 9 |
| GitHub release | BLOCKED on Phase 9 | Phase 10 |
| npm CLI publish | DEFERRED | Phase 11 |

---

## Related Documents

- [`RELEASE_PLAN.md`](RELEASE_PLAN.md) — superseded; kept as historical record of extension-readiness work.
- [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md) — superseded for §6–7; kept as historical record of the domain/email/GitHub cutover.
- [`CTRLYOKE_REBRAND_PLAN.md`](../implemented/CTRLYOKE_REBRAND_PLAN.md) — the code rebrand (done).
- [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) — engineering design for `LicenseService`, gating philosophy, and the full purchase→license architecture.
- [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) — generic `vsce` package/publish mechanics (FlightPath-branded, mechanics still accurate).
