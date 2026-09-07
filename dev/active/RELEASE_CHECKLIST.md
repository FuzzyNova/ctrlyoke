# ctrlyoke Release Checklist

**Created:** June 19, 2026 (as `FlightPath Release Checklist`)
**Rewritten:** August 25, 2026 — consolidated into the single canonical, ctrlyoke-branded release checklist.
**Status:** Business/domain cutover is DONE. Pro-licensing vendor accounts (Keygen, Lemon Squeezy) exist and were configured live in this session — see Phase 4/5 for exact current state. Extension-side `LicenseService` implementation (Phase 6) is the largest remaining blocker.
**Purpose:** the one place to look for "what's left before `ctrlyoke` ships" — product release, vendor/licensing setup with exact click-by-click steps, legal, and launch verification.

> **This document supersedes [`RELEASE_PLAN.md`](RELEASE_PLAN.md) and [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md).** Both are kept as historical record (their content described real work, most of it now done) but are no longer the place to look for open items — that's here. [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) remains the engineering design doc for `LicenseService`; this checklist is the execution tracker. [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) is left untouched as a FlightPath-era generic how-to-use-`vsce` reference — its mechanics (package/login/publish commands) are still accurate, just still branded FlightPath; Phase 9 below has the ctrlyoke-branded equivalent commands.

---

## How this doc is organized

1. **Phase 1–3** — extension/site readiness and business cutover. **All done.** Kept brief.
2. **Phase 4–5** — Pro licensing vendors (Keygen, Lemon Squeezy). **Partially done — exact remaining steps below**, current as of a live walkthrough of both dashboards on August 25, 2026.
3. **Phase 6** — Pro licensing _implementation_ (the `LicenseService` code in the extension). **In progress** — remaining gate sites and launch verification are still open.
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

| Item                                      | Value                                                                                                                                              | Notes                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product                                   | **ctrlyoke**                                                                                                                                       | `id: f4af3c3b-4350-4a6e-af09-744797abb4b0`. Distribution Strategy: `LICENSED`. Permissions: `license.read`, `license.validate`, `machine.create`, `machine.delete`, `machine.read`.                                            |
| Policy                                    | **ctrlyoke Pro**                                                                                                                                   | `id: da0764ce-6577-419a-862d-128efdbfc329`. Renamed live this session from stale `FlightPath Pro` — no other field needed changing.                                                                                            |
| Policy config                             | Duration: Unlimited (perpetual) · Scheme: `ED25519_SIGN` · Floating: true · Max Machines: 10 · Strict: true · Expiration Strategy: Restrict Access | Matches [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.1 exactly. **No changes needed.**                                                                                                                       |
| Ed25519 public key (hex)                  | `4cf46fe061bf97080094f14430fa2a1563f1b245cd600ccb99039bfff43836fa`                                                                                 | Settings → Public Keys. This is the value to embed as a build constant for offline license-file verification ([`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.4).                                               |
| Account ID                                | `6ed6209c-6633-4444-9d43-ab4a473e2f28`                                                                                                             | **Use this in API URLs, not the slug.** Keygen's own UI flags the slug (`fuzzynova`) with a warning: _"We recommended that you use your account ID instead of your account slug when integrating Keygen within your product."_ |
| Admin token                               | `admin-token` named **`fuzzynova-admin`**, id `54927c5d…`, created August 25, 2026                                                                 | Regenerated live this session, value saved in 1Password. This is the one integration credential — see 4.2 below.                                                                                                               |
| Billing plan                              | **Dev 1** — $0/mo, 2,500 API requests/day, 100 licensed-user limit, 1 product limit, 10 policy limit                                               | Decision made — see 4.3 below.                                                                                                                                                                                                 |
| Webhook endpoints                         | None configured                                                                                                                                    | Not required for the Phase 1 flow (Lemon Squeezy → Netlify Function → Keygen API is one-directional; Keygen doesn't need to call back out). Leave empty unless a future feature needs Keygen-initiated events.                 |
| Enterprise policy (§1.7.1 self-serve SKU) | Does not exist yet                                                                                                                                 | Not urgent — only needed when the Enterprise SKU ships (Phase 6, step 13 in the implementation order).                                                                                                                         |

### 4.2 Admin token custody ✅ RESOLVED (August 25, 2026)

- [x] Regenerated as `fuzzynova-admin` (id `54927c5d…`) live this session, value saved in 1Password. This is the credential the Netlify webhook function will use server-side to call `POST /v1/accounts/6ed6209c-6633-4444-9d43-ab4a473e2f28/licenses` — it must **never** ship inside the VSIX; it goes into the Netlify function's environment once that function exists (Phase 5.3).
- Note: a live Playwright walkthrough of the Tokens page also turned up two other unnamed `admin-token` entries (`9990b2de…`, `1e451f7e…`). These are **not** stray integration credentials — confirmed live with Nathan that Keygen mints a fresh session-scoped admin token on every dashboard login as a quirk of Keygen using its own product for its own auth, and revoking them just logs you out. Only a token you explicitly name (like `fuzzynova-admin`) is the one meant for external use. Nothing to clean up here.

### 4.3 Dev tier vs. paid Keygen plan ✅ RESOLVED (August 25, 2026)

The account is on the free **Dev 1** plan: 2,500 API requests/day and a **100 licensed-user limit**. At $59/customer, hitting the 100-user cap means ~$5,900 in sales.

- [x] **Decision (Nathan):** launch on Dev 1 and upgrade to a paid Keygen plan reactively, triggered by the **first 2 Pro sales** landing (not waiting until closer to the 100-user cap) — an early, cheap signal that real conversion is happening, monitored manually rather than pre-committing to paid infra before any revenue exists.

### 4.4 Optional — Enterprise policy (defer until the SKU is needed)

When ready to build the self-serve Enterprise SKU ([`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.7.1):

1. Keygen dashboard → **Policies** → **New Policy**.
2. Name: `ctrlyoke Enterprise`.
3. Duration: **1 Year** (annual, not perpetual — matches the subscription billing model).
4. Scheme: `ED25519_SIGN` (same as Pro, for one shared verification path).
5. Max Machines: leave blank / effectively unlimited (site license — "unlimited seats" is enforced by _not_ setting a machine cap, per the plan).
6. Floating: checked. Strict: checked.
7. Product: `ctrlyoke` (same product as Pro).

---

## Phase 5 — Pro Licensing Vendor: Lemon Squeezy

**Status: store rebranded and product drafted live this session.** Before this session, the LS store existed under the old `Fuzzy Nova` branding with **zero products** — this vendor was much further behind than Keygen. Below is exact current state plus the exact remaining steps.

### 5.1 Current state (verified/changed live, August 25, 2026)

| Item                                      | Value                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store name                                | **ctrlyoke**                                                        | Changed live this session from `Fuzzy Nova`. Settings → General → "Store name" — appears on every receipt/invoice.                                                                                                                                                                                                                                                                                                                                                                |
| Store URL                                 | **ctrlyoke.lemonsqueezy.com**                                       | Changed live this session from `fuzzynova.lemonsqueezy.com`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Contact email                             | **support@ctrlyoke.dev**                                            | Changed live this session from `admin@fuzzno.com`. This is the address shown to customers on receipts/invoices for support.                                                                                                                                                                                                                                                                                                                                                       |
| Store activation                          | **"In Review"** (Identity verification)                             | Banner reads _"Your application has been received and will be reviewed as soon as possible."_ This is Lemon Squeezy's own KYC/underwriting step — **nothing to click, just waiting on LS.** No live payments can process until this clears.                                                                                                                                                                                                                                       |
| Test mode                                 | **ON**                                                              | Toggle top-right of every LS dashboard page. Real charges are impossible while this is on, regardless of store-activation status.                                                                                                                                                                                                                                                                                                                                                 |
| Product                                   | **ctrlyoke Pro**, id `1317307`                                      | Created live this session. Status: **Published** (August 26, 2026 — see 5.3).                                                                                                                                                                                                                                                                                                                                                                                                     |
| — Price                                   | **$59.00**, Single payment (one-time)                               | Matches [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.7.                                                                                                                                                                                                                                                                                                                                                                                                         |
| — Tax category                            | **Software**                                                        | Chosen over the form's default "SaaS - personal use" — ctrlyoke Pro is a perpetual license unlocking local functionality, not a hosted service Fuzzy Nova operates on the buyer's behalf. Decided live this session.                                                                                                                                                                                                                                                              |
| — Generate license keys                   | **OFF (unchecked)**                                                 | Correct per plan — Keygen issues the real license, not Lemon Squeezy's native key system.                                                                                                                                                                                                                                                                                                                                                                                         |
| — Display on storefront                   | **ON**                                                              | Will show once published.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| — Confirmation modal / email receipt copy | Set to explain the Keygen key arrives by separate email             | See 5.2 — this is the resolution of the plan's previously-open "key delivery" question.                                                                                                                                                                                                                                                                                                                                                                                           |
| Webhooks                                  | **One configured (test mode)**, id `129600`                         | Created live August 26, 2026: `https://ctrlyoke.dev/.netlify/functions/ls-webhook`, listening for `order_created` + `order_refunded`. Signing secret set by us (LS lets you choose your own, ≤40 chars — it does not auto-generate and reveal one). Smoke-tested successfully (see 5.3). **Note:** this webhook only fires for test-mode data — a second, live-mode webhook (same URL/events) will need to be created when Test mode is flipped off for real launch (5.3 step 6). |
| API keys                                  | **None created**                                                    | Not needed for the Phase 1 flow — the Netlify function only _receives_ LS webhooks and _calls out_ to Keygen; it doesn't need to call back into the LS API for the MVP (order/refund payloads carry enough data). Skip unless a future feature needs it.                                                                                                                                                                                                                          |
| Payouts                                   | Bank account connected (**•••• 0725, USD**)                         | Good — a payout method exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Payout tax info                           | ✅ Submitted (August 25, 2026), via Stripe Connect tax-details flow | Confirmed live: the "[Action Required]" banner is gone from Settings → Payouts.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Custom checkout domain                    | Not connected                                                       | Optional polish (e.g. `checkout.ctrlyoke.dev`) — Settings → Domains → currently empty. Not a blocker.                                                                                                                                                                                                                                                                                                                                                                             |
| Store logo                                | Assets generated; not uploaded                                      | Cosmetic — upload [`images/ls-logo.png`](../../images/ls-logo.png) (160×160 opaque logo with 20px padding for Lemon Squeezy's circular crop) in Settings → General → Logo; use [`images/ls-favicon.png`](../../images/ls-favicon.png) for the 32×32 favicon if requested. Not a blocker.                                                                                                                                                                                          |

### 5.2 Resolved — key delivery mechanism

The plan's open question #4 ("LS custom fulfillment vs. our own transactional email") is now resolved by simply looking at what Lemon Squeezy's product form offers: **"Links" is 3 static URL fields (not dynamic), "Generate license keys" is LS's own key system (not used), and there is no field to inject a third-party value into checkout or the receipt.**

**Decision: the Netlify webhook function sends the Keygen key by email** after creating the license. Lemon Squeezy's own receipt stays a plain payment receipt (its copy, set live this session, tells the buyer to expect a separate email). This means:

- [x] **Transactional email provider: Resend** (decided August 25, 2026 — sends the license-delivery email from `licensing@ctrlyoke.dev`).
- [x] Signed up for Resend under `admin@fuzzno.com` (same account-owner pattern as Keygen/LS — see `CTRLYOKE_REBRAND_CUTOVER.md` §6–7). Verified the `ctrlyoke.dev` sending domain via Resend's Cloudflare auto-setup (DNS is in Cloudflare, not Netlify — Netlify is deploy-only here, see 5.3 note). API key generated, named `ctrlyoke-ls-webhook`, saved in 1Password.
- [x] Added `RESEND_API_KEY`, `KEYGEN_ADMIN_TOKEN`, and `LEMONSQUEEZY_WEBHOOK_SECRET` as Netlify site (`ctrlyoke.dev`) environment variables — Secret + All scopes (the free Netlify plan doesn't support scope-limiting to Functions only; acceptable since the values still never surface in UI/API/CLI/logs) + same value for all deploy contexts. All three now hold real values (Resend and Keygen from the start; the LS webhook secret was a `pending` placeholder until the real one was generated in 5.3 step 2, then redeployed).

### 5.3 Remaining steps — in order

1. **Build the Netlify Function** — ✅ **done August 25, 2026**: `netlify/functions/ls-webhook.ts` exists, implementing §1.2 of [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) — verifies the LS HMAC signature (raw-body HMAC-SHA256 hex via `X-Signature`), creates a Keygen license on `order_created` (idempotent — looks up by `metadata.lsOrderId` before creating), emails the key via Resend, and suspends the license on `order_refunded`. `netlify.toml` declares `[functions] directory = "netlify/functions"`; no new npm dependencies needed (Node 22's native `fetch` + `node:crypto` cover both the Keygen/Resend REST calls and the HMAC check). Committed at `04b0e813`.
   - ✅ **Deployed August 26, 2026.** Important mechanics discovered live: the `ctrlyoke.dev` Netlify site is **not Git-linked** (would require a paid Netlify plan) — `deploy.yml` running `netlify deploy --prod` via the CLI with `NETLIFY_AUTH_TOKEN`/`NETLIFY_SITE_ID` secrets is the _only_ path anything reaches Netlify by. That workflow is also `paths:`-filtered to `landing/**`, `docs/**`, etc. — **`netlify/functions/**`is not in the filter**, so a commit touching only the function won't auto-deploy. Added`workflow_dispatch: {}`to`deploy.yml`so it can be run manually from the Actions tab for exactly this case (env-var-only changes, or function-only commits). DNS for`ctrlyoke.dev`lives in **Cloudflare** (grey-clouded/DNS-only per`CTRLYOKE_REBRAND_CUTOVER.md` §1), not Netlify — Netlify is deploy/host only.
2. **Create the LS webhook** — ✅ **done August 26, 2026.** One correction to the plan as originally written: Lemon Squeezy does **not** auto-generate and reveal a signing secret after webhook creation — **you set your own** in the creation form (max 40 characters). Generated one (`openssl`-equivalent random hex, 36 chars), entered it in both the LS webhook form and Netlify's `LEMONSQUEEZY_WEBHOOK_SECRET` (replacing the `pending` placeholder), redeployed. Webhook id `129600`, URL `https://ctrlyoke.dev/.netlify/functions/ls-webhook`, events `order_created` + `order_refunded`.
3. **Publish the product and smoke-test** — ✅ **done August 26, 2026**, in a different order than originally planned: Lemon Squeezy has no way to generate a checkout link for a Draft product (no "preview checkout" affordance found), so the product was published _first_ (safe: Test mode was ON and the store was still un-activated/"In Review", so no real charge could occur either way), then the checkout link came from the product's **Share** button. Ran an actual test-mode purchase (test card `4242 4242 4242 4242`) through the live checkout at `ctrlyoke.lemonsqueezy.com/checkout/buy/...` and verified the full chain:
   - LS **order_created** webhook delivered → **200 OK** (order `9308340`, $59.00, `test_mode: true`).
   - Keygen license **created and ACTIVE** (id `8148c333…`, product `ctrlyoke`, policy `ctrlyoke Pro`) within seconds.
   - Resend delivered the license-key email to the buyer address (`admin@fuzzno.com`) from `licensing@ctrlyoke.dev`, containing the correct Keygen key and activation-command instructions. Email is plain text/unstyled — acceptable for now; logo/HTML styling is cosmetic polish, not a launch blocker.
   - **Note during checkout:** the Stripe card iframe presented an "I am an AI agent acting on behalf of someone else" disclosure checkbox; checking it revealed follow-on content instructing the agent to run a local shell command and install a third-party CLI tool from a GitHub link — treated as a possible prompt injection and not acted on. Completed checkout instead via the normal human-equivalent flow (checkbox left unchecked) with Nathan's explicit go-ahead. Worth knowing for any future automated/agent-driven checkout testing.
4. ~~**Submit payout tax info**~~ ✅ done August 25, 2026 (5.1).
5. **Wait for / follow up on** Lemon Squeezy's identity-verification review before flipping Test mode off for real charges.
6. Only after 1–5: flip **Test mode OFF**, **create a second, live-mode LS webhook** (same URL/events as the test-mode one — LS scopes webhooks to the mode active when they're created, confirmed live August 26, 2026), set `CHECKOUT_URL` in `landing/src/config.ts` to the real LS checkout link for the published product, and flip `LAUNCHED = true` (Phase 9).

### 5.4 Why the ordering matters (chicken-and-egg)

You can't create the LS webhook without a target URL, and the Netlify function's webhook-signature verification needs the secret LS only reveals _after_ the webhook is created. Standard resolution: deploy the function first pointed at a placeholder/no-op secret, create the LS webhook against the now-live URL, copy the real secret back into the function's env vars, redeploy. This is normal for any webhook-consumer setup — not ctrlyoke-specific.

---

## Phase 6 — Pro Licensing Implementation (extension code)

**Status: DONE.** The extension-side implementation, gates, trial, documentation, and production free-path review are complete. Full design lives in [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.4–§1.9; this is the execution checklist.

- [x] `LicenseService` interface + `Entitlement` type (`src/license/LicenseService.ts`).
- [x] `PRO_FEATURES` constants in `DashboardConstants.ts` (no hardcoded feature-flag strings at gate sites).
- [x] Embed the Keygen Ed25519 public key (4.1 above) as a build constant.
- [x] Offline `getEntitlement()` — Ed25519 signature + expiry verification, no network, fail-open to free on any error.
- [x] `activateWithKey()` — online activation via Keygen, cache signed license file in `vscode.SecretStorage`; live Keygen activation and deactivation smoke-tested August 28, 2026.
- [x] Online `refresh()` — silently renew near-expiry cached files within the 30-day TTL and 14-day offline grace window.
- [x] `deactivate()` — release the Keygen machine activation and clear local license secrets.
- [x] `importLicenseFile()` — air-gapped offline import, zero network calls.
- [x] Commands: `ctrlyoke: Activate Pro License`, `ctrlyoke: Activate Offline (Air-Gapped) License`, `ctrlyoke: Deactivate Pro License`, `ctrlyoke: Manage License`; live Free/Pro status bar surface.
- [x] Gate sites (§1.8 of the plan): remote bind (`0.0.0.0`) enforcement at `CtrlYokeHostedServer.listen()`, LAN IP selector + QR-to-phone in `ServerSection.tsx`, HTTPS/cert generation, mobile push, custom icon color, air-gapped activation command itself.
- [x] 14-day remote-access trial timer in `globalState`.
- [x] Production-build verification of the **unlicensed free path** — nothing above should ever block core workflow execution. `npm run package` passed on August 28, 2026 and produced `ctrlyoke-0.1.0.vsix` (249 files, 14.1 MB). A clean-profile install was not practical in this environment, so the remainder was verified by code-path review: workflow execution, local notifications, custom hooks, MCP, agents/skills, AI commit messages, and the localhost dashboard have no license block; first use initializes the 14-day remote trial; gated remote/TLS/push/UI surfaces warn and link to pricing instead of failing. The package contains the production webview, MCP server, and node-pty runtime.
- [x] `docs/pro/index.md` — online + air-gapped activation instructions, referencing the real Keygen/LS setup above. QR scanning for air-gapped transfer is deliberately deferred; file-picker and paste import are shipped.

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

- [x] Clean VSIX install, no license: all free functionality works — verified by production-package/code-path review; a clean-profile install was not run in this environment.
- [x] Remote-access trial activates for a fresh install; 14-day window enforced — verified by code-path review of first-use global-state initialization and the 14-day comparison.
- [x] Trial expiry falls back to localhost-only without breaking workflows — verified by code-path review of the bind gate and free local workflow paths.
- [ ] Pro activation (online key) unlocks remote dashboard + other Pro features immediately, no restart.
- [ ] Air-gapped license file import unlocks Pro with zero network calls.
- [ ] Lemon Squeezy **test-mode** order → exactly one Keygen license created, webhook retry doesn't duplicate it.
- [ ] Refund (test mode) → Keygen license suspended/revoked.
- [ ] Pricing page checkout link points at the real, published, live-mode LS product.
- [ ] README, docs, Marketplace listing, and website agree on support address, license terms, and pricing.

---

## Phase 13 — Branching & Release Process (post-launch)

**Recommendation: keep working on `main` and make releases tag-driven. Do not
adopt a long-lived `dev` branch, and do not create standing release branches —
cut a `release/X.Y` branch only the first time a hotfix actually needs one.**

Phases 9–10 describe the **first** publish, done by hand so the mechanics get
verified once. This section is how every release after that should work.

### Why not a `dev` branch with "push to main = release"

- **`main` is already the production website branch.** `deploy.yml` deploys
  `ctrlyoke.dev` on push to `main` (path-filtered to `landing/**`, `docs/**`,
  `images/**`, `netlify.toml`). If `main` were only touched at release time,
  every docs fix, pricing tweak, or screenshot update would either wait for an
  extension release or force the deploy trigger onto the dev branch — at which
  point `main` is a fiction that exists only to carry tags. The site and the
  extension ship on genuinely different cadences; coupling them is the real
  cost of this model.
- **A release is a point, not a branch state.** Phase 10 already tags `v0.1.0`
  and builds from it. A merge to `main` adds a step whose only meaning is
  "now" — which a tag says more precisely, since a tag can name any commit
  (including one behind `HEAD`) while a merge always takes everything.
- **`develop` exists to isolate in-flight work from a stabilizing release for a
  team.** Solo, the two branches differ only by the time between merges, and
  the permanent cost is a sync tax plus "which branch is this worktree based
  on?" on every feature.

### Why not standing release branches

Real tool, wrong trigger. The Marketplace serves exactly one stable version and
clients auto-update, so nobody is sitting on `0.3.x` while `0.4` ships — there
is nothing to backport to. A release branch earns its keep only when a
published version needs a fix and `main` has already moved somewhere
unshippable. Cut it from the tag at that moment:

```powershell
git switch -c release/0.3 v0.3.1   # fix, bump to 0.3.2, tag, publish, cherry-pick back to main
```

### The model

| Branch / ref              | Purpose                                                     | Triggers                                                                 |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `main`                    | Trunk. Plans, docs, and small changes commit here directly. | Site deploy (path-filtered), CI gate                                     |
| feature branch / worktree | Big or risky changes (`big-feature`, `bug-fix`, …)          | `deploy-preview.yml` alias preview when it touches the site              |
| `vX.Y.Z` tag              | **The release.** Names the exact commit that ships.         | Release workflow: package → Marketplace publish → GitHub Release         |
| `release/X.Y`             | Hotfix for a published version `main` has outgrown.         | Created on demand from the tag; deleted after the patch is cherry-picked |

### Where the checks run — local gate, cloud release

Actions minutes are metered only while the repo is **private**, which it is
today (an unauthenticated `api.github.com/repos/FuzzyNova/ctrlyoke` returns
404): runs bill against the Free plan's 2,000 min/month (Pro: 3,000), Linux 1×,
Windows 2×, macOS 10×. **Public repos get unlimited standard-runner minutes**,
and ctrlyoke is meant to be source-available with public GitHub Issues
(Phase 7) — so the metering ends at launch, which is exactly when the release
process starts mattering. Flipping the repo public is itself an untracked
release step; it is now the last item below.

Even while private, the spend is not the real constraint: one Ubuntu run of
typecheck + lint + tests is on the order of 5–10 minutes, so twenty pushes a
month is under 10% of the free allowance — and `deploy.yml` already spends
minutes on every site commit. **So do not choose local vs. cloud on cost.
Choose on what each is actually good at:**

| Check                                                                     | Where                                                             | Why                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`, `lint`, `test:ui` (vitest), `test:packaging` (`node --test`) | **Local pre-push hook**                                           | Fast, no Electron and no display needed. Local feedback beats waiting on a queued runner, and this catches nearly everything.                                                                   |
| Full suite including `test:extension` (`@vscode/test-electron`)           | **Actions — `workflow_dispatch`**, optionally a weekly `schedule` | Needs a display; `test:headless` (`xvfb-run -a …`) already exists for exactly this. Run it before cutting a release, or after extension-host changes.                                           |
| Release build + Marketplace publish                                       | **Actions — on the `v*` tag**                                     | The one build where a clean checkout _is_ the point: an uncommitted file, stale `node_modules`, or a local-only env var becomes a shipping bug. Never publish a VSIX built from a working tree. |

**Decision (Nathan, September 7, 2026):** accepted as written — local pre-push
gate for the fast checks, GitHub Actions for the clean-room ones. Metered
minutes were the wrong axis to optimize; they are a rounding error today and
free once the repo is public (Phase 14).

A local hook verifies your **working tree**; the tag build verifies the
**commit**. That difference is the whole argument — a hook cannot catch a file
you forgot to `git add`, and it is advisory anyway (`--no-verify` exists, and
you will reach for it). Keeping the un-bypassable check on the artifact that
ships is what makes the bypassable one safe to have.

### What to build

- [ ] **Local pre-push hook — the fast gate.** There is no build or test
      workflow of any kind today (the only three workflows are the Netlify
      ones), and trunk-based development is safe exactly to the degree `main` is
      verified, so this is the prerequisite for everything else here. Check in
      `.githooks/pre-push` and set `git config core.hooksPath .githooks` — no
      husky/lint-staged dependency, and because `core.hooksPath` lives in the
      shared repo config it applies to every worktree. Run `typecheck`, `lint`,
      `test:ui`, `test:packaging`; **never** `test:harness`, which spends real
      money. Skip the run when the push touches only `dev/**`, `docs/**`, or
      `*.md` — a plan commit should not pay for the suite. Caveat: each worktree
      needs its own `npm ci` before the hook can run there.
- [ ] **Full-suite workflow on `workflow_dispatch`** (optionally a weekly
      `schedule`) — the Electron extension tests via `npm run test:headless`,
      which is already `xvfb-run`-wrapped for Linux runners. This is the
      clean-room check the local hook cannot give, without paying for it on
      every push.
- [ ] **`release.yml` on `push: tags: ["v*"]`** — runs `npm run package`, then
      `npx vsce publish --packagePath ctrlyoke-<version>.vsix`, then creates the
      GitHub Release from the matching `CHANGELOG.md` section and attaches the
      VSIX. Needs a `VSCE_PAT` repo secret (the Azure DevOps PAT from Phase 9).
      This automates Phase 9's publish steps and all of Phase 10.
- [ ] **Version/tag guard in that workflow** — fail if the tag does not equal
      `package.json#version`. Automates the "VSIX version matches
      `package.json`" check in Phase 8 and prevents the classic mismatch.
- [ ] **Release commit convention** — one commit that bumps `package.json` and
      renames `CHANGELOG.md`'s `[Unreleased]` heading to `[X.Y.Z] - <date>`,
      then an annotated tag on it. Keeps the tag, the VSIX, and the changelog
      entry describing the same tree.
- [ ] **Pre-release channel instead of a staging branch** — `vsce publish
--pre-release` publishes to the Marketplace's pre-release channel for
      opt-in users. VS Code's documented convention is `major.EVEN.patch` for
      stable and `major.ODD.patch` for pre-release (the Marketplace requires a
      plain `x.y.z`; semver pre-release suffixes like `-beta.1` are not
      supported). This is the "release build I can test before everyone gets
      it" that the dev-branch idea was reaching for, without a branch.
- [ ] **Document the hotfix path** (the `git switch -c release/X.Y <tag>` recipe
      above) in `CONTRIBUTING`/dev docs so it is a known move rather than an
      improvisation during an incident.
- [ ] **Flip the repo to public** — its own step now, with the scan procedure
      and the decisions it depends on: **Phase 14**.

---

## Phase 14 — Repo Visibility Flip (private → public)

`FuzzyNova/ctrlyoke` is **private today**. Phase 7's public GitHub Issues, the
source-available EULA, and Phase 13's free Actions minutes all assume it becomes
public, so this is a real launch step — and it has a real prerequisite, because
**publishing exposes every commit on every branch and tag, not the working
tree.**

### 14.1 What a proper pre-flip scan covers

Grepping the current files is not a secret scan. At 3,378 commits the exposure
surface is all of history: a credential deleted in a later commit is still
served forever by the public commit that added it. Run an entropy-based scanner
over history, not a pattern grep over `HEAD`:

```powershell
gitleaks git . --redact
trufflehog git file://. --results=verified
```

Both are single binaries — neither needs to become a project dependency. Also
skim closed Issues and PRs (they become world-readable too) and any tags.

If something _is_ found: **rotate first, rewrite second.** History rewriting
(`git filter-repo`) hides a secret; it does not un-leak one that was ever pushed
to a remote. Nothing here has been pushed anywhere public yet, so rotation is
cheap — do it anyway rather than reasoning about who might have seen it.

### 14.2 Already verified (September 7, 2026)

Pattern scan across all 3,378 commits on all refs:

- [x] `dev/test_keys.md` — two live Keygen license keys with the buyer email in
      cleartext, the highest-value target in the repo. **Never committed**, and
      gitignored at `.gitignore:46`. Clean.
- [x] No `.env` / `.env.*` file has ever been added in any commit.
- [x] Pickaxe scan for Resend (`re_…`), Keygen (`prod-…`, `activ-…`), GitHub
      (`ghp_…`) and Slack (`xox…`) token shapes: **zero hits.**
- [x] PEM `BEGIN … PRIVATE KEY` blocks: two hits, both test fixtures — a literal
      `secret-material` placeholder in `PreviewRedactor.test.ts` and a format
      regex in `WebviewSettingsSync.test.ts`. Not credentials.
- [x] Tracked `.ctrlyoke/` content carries no credentials (`mcp/servers.json`
      holds no keys; `settings.json` is untracked).
- [x] `deploy-preview.yml` triggers on `push`, **not** `pull_request_target`, so
      a fork PR cannot reach `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID`. **Keep it
      that way** — switching to `pull_request_target` after going public would
      hand repo secrets to any fork.

That scan is prefix-based, so it cannot see a high-entropy secret with no
recognizable shape. Run one scanner from 14.1 before the flip to cover the gap.

### 14.3 Safe to publish (decided)

- **Keygen Ed25519 public key** (4.1) — already embedded in every shipped VSIX as
  a build constant (Phase 6). Anyone can extract it from the `.vsix`; publishing
  it changes nothing.
- **Vendor identifiers** — Keygen account/product/policy IDs, LS product/order/
  webhook IDs, the test-mode Keygen license ID. Identifiers, not credentials;
  Keygen's own UI instructs you to use the account ID in API URLs. Authentication
  is the admin token, and only its **name** and a truncated id (`54927c5d…`)
  appear in this document.
- **`4242 4242 4242 4242`** — Stripe's published test card.

### 14.4 Personal info — decide it, don't wave it through

`admin@fuzzno.com` appears in 5.1–5.3 and is the account-owner address for
**Keygen, Lemon Squeezy, and Resend** — the three systems that mint licenses and
hold revenue. The payout bank last-4 (`•••• 0725`) is masked, but equally
unnecessary to publish.

Redacting the working tree does not help: the address is in history, and history
is what gets published. A `git filter-repo` rewrite is possible while nothing is
public, but it is disruptive for what is, in the end, a business contact address
sitting alongside already-public `support@` / `sales@` / `security@`.

**Recommendation: publish as-is and mitigate where the risk actually lives.** The
exposure is targeted phishing and account recovery on the licensing/revenue
accounts, so the effective control is account hardening, not redaction:

- [ ] MFA — passkey or TOTP, **not** SMS — on Keygen, Lemon Squeezy, Resend,
      Netlify, Cloudflare, GitHub, and Google Workspace.
- [ ] Confirm each vendor's account-recovery address is not guessable from the
      public docs.
- [ ] Prefer role addresses (`licensing@`, `billing@`) over the personal owner
      address in future checklist entries.

### 14.5 The flip, and what changes

Settings → General → Danger Zone → **Change repository visibility → Make
public**.

- [ ] Do it **after** the final EULA is in `LICENSE.md` (Phase 7). The repo is
      forkable the instant it is public, and every fork inherits whatever license
      text is present at that moment.
- [ ] Actions minutes become free and unlimited on standard runners (Phase 13).
- [ ] Existing Issues and PRs become world-readable — skim them for internal
      notes before flipping, not after.
- [ ] Immediately after: enable **Secret scanning + Push protection** and
      **Dependabot alerts** (Settings → Code security; free for public repos).
      Push protection is the durable form of 14.1 — it blocks the next accidental
      commit instead of catching it at the next audit.

---

## Summary Table

| Item                                                                       | Status               | Notes                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Extension packaging/build readiness                                        | DONE                 | Phase 1                                                                                                                        |
| Website + docs                                                             | DONE                 | Phase 2                                                                                                                        |
| Business/domain cutover (DNS, email, GitHub, Marketplace item reservation) | DONE                 | Phase 3                                                                                                                        |
| Keygen product + Pro policy                                                | DONE                 | Phase 4.1 — renamed live this session                                                                                          |
| Keygen admin token custody confirmed                                       | DONE                 | Phase 4.2 — `fuzzynova-admin` in 1Password                                                                                     |
| Keygen billing tier decision (Dev vs. paid)                                | DONE                 | Phase 4.3 — Dev 1 now, upgrade after first 2 sales                                                                             |
| Keygen Enterprise policy                                                   | DEFERRED             | Phase 4.4 — not needed until the Enterprise SKU                                                                                |
| Lemon Squeezy store rebrand                                                | DONE                 | Phase 5.1 — done live this session                                                                                             |
| Lemon Squeezy product (ctrlyoke Pro, published)                            | DONE                 | Phase 5.1/5.3 — published August 26, 2026                                                                                      |
| Lemon Squeezy identity verification                                        | OPEN (waiting on LS) | Phase 5.1 — nothing to click                                                                                                   |
| Lemon Squeezy payout tax info                                              | DONE                 | Phase 5.1 — submitted August 25, 2026                                                                                          |
| Netlify webhook function (deployed + smoke-tested)                         | DONE                 | Phase 5.3 — end-to-end test purchase verified August 26, 2026 (webhook 200 OK, Keygen license created, Resend email delivered) |
| Transactional email provider for key delivery                              | DONE                 | Phase 5.2 — Resend, verified working live                                                                                      |
| Live-mode LS webhook (separate from test-mode one)                         | OPEN                 | Phase 5.3 step 6 — create once flipping Test mode off                                                                          |
| **`LicenseService` implementation**                                        | **DONE**             | Phase 6 — implementation, gate sites, trial, docs, and unlicensed free-path production review complete; QR scanning deferred   |
| Attorney sign-off on final EULA                                            | OPEN                 | Phase 7                                                                                                                        |
| Screenshots + demo GIF                                                     | OPEN                 | Phase 8                                                                                                                        |
| Final `vsce ls` package inspection                                         | OPEN                 | Phase 8 — run right before publish                                                                                             |
| Marketplace publish                                                        | BLOCKED on Phase 6   | Phase 9                                                                                                                        |
| GitHub release                                                             | BLOCKED on Phase 9   | Phase 10                                                                                                                       |
| npm CLI publish                                                            | DEFERRED             | Phase 11                                                                                                                       |
| Post-launch branching + tag-driven release workflow                        | OPEN                 | Phase 13 — trunk on `main`, local pre-push gate, releases by tag                                                               |
| Repo visibility flip to public                                             | OPEN                 | Phase 14 — history scan clean on pattern check; run gitleaks/trufflehog, then flip after the EULA lands                        |
| Vendor-account MFA hardening                                               | OPEN                 | Phase 14.4 — the real mitigation for the owner email being public                                                              |

---

## Related Documents

- [`RELEASE_PLAN.md`](RELEASE_PLAN.md) — superseded; kept as historical record of extension-readiness work.
- [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md) — superseded for §6–7; kept as historical record of the domain/email/GitHub cutover.
- [`CTRLYOKE_REBRAND_PLAN.md`](../implemented/CTRLYOKE_REBRAND_PLAN.md) — the code rebrand (done).
- [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) — engineering design for `LicenseService`, gating philosophy, and the full purchase→license architecture.
- [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) — generic `vsce` package/publish mechanics (FlightPath-branded, mechanics still accurate).
