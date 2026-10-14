# ctrlyoke Release Checklist

**Created:** June 19, 2026 (as `FlightPath Release Checklist`)
**Rewritten:** August 25, 2026 — consolidated into the single canonical, ctrlyoke-branded release checklist.
**Status:** Business/domain cutover is DONE. Pro-licensing vendor accounts (Keygen, Lemon Squeezy) are fully configured — Lemon Squeezy's identity verification cleared September 7, 2026. Extension-side `LicenseService` implementation (Phase 6) is DONE. Attorney sign-off on the EULA also landed September 7, 2026, which unblocked Marketplace publish (Phase 9). Phase 14 (repo visibility flip) cleared every pre-flip gate the same day — entropy-based secret scan clean, Issues/PRs/tags skim clean, all vendor + Microsoft/Azure DevOps accounts MFA-hardened — and is now ready to execute whenever Nathan chooses to trigger the actual toggle. Phase 13's CI/release automation and GitHub public-contribution scaffolding (pre-push hook, full-suite + release workflows, `CONTRIBUTING.md`/`SECURITY.md`/issue+PR templates) were also built September 7, 2026. Phase 7's self-serve Enterprise legal (`DPA.md`, `ENTERPRISE_TERMS.md`, `TRUST_PAGE.md`) cleared attorney review and went live on `ctrlyoke.dev` September 17, 2026, alongside the signed IP Assignment Agreement. The `VSCE_PAT` secret landed September 8, 2026, so `release.yml` can publish. **As of September 23, 2026 the largest remaining release blocker is Phase 8 (screenshots/demo GIF, then final package inspection).** Business-side work (LLC vendor re-association to Fuzzy Nova LLC + the Mercury account/card, trademark filing) is tracked outside this repo in the Fuzzy Nova LLC business Drive (`Formation & Legal/LLC_FORMATION_GUIDE.md`, `Trademark & IP/TRADEMARK_FILING_GUIDE.md`); only its release-gating touchpoints are mirrored here. **2026-10-10 audit (repo-verifiable items only):** `package.json` is `0.1.2`. Tags `v0.1.1` (release run failed twice) and `v0.1.2` (release run green, 2026-09-25) exercised `release.yml` end to end: Marketplace publish to the still-private listing, a GitHub Release with the VSIX attached, and npm staging. `npm view ctrlyoke version` returns `0.1.2`. `full-suite.yml` runs under Xvfb but has failed on every weekly schedule since 2026-09-14. The repo is still private (`gh api`). Also fixed: moved-doc links (`CTRLYOKE_REBRAND_CUTOVER.md`, `CLI_DISTRIBUTION_PLAN.md`, and `DEPENDENCY_UPGRADE_PLAN_2026_10.md` are now in `dev/implemented/`), "seven harnesses" changed to six, the stale Phase 6 "in progress" label, the dev-menu visibility check, and the Enterprise PO line.
**Purpose:** the one place to look for "what's left before `ctrlyoke` ships" — product release, vendor/licensing setup with exact click-by-click steps, legal, and launch verification.

> **This document supersedes [`RELEASE_PLAN.md`](../implemented/RELEASE_PLAN.md) and [`CTRLYOKE_REBRAND_CUTOVER.md`](../implemented/CTRLYOKE_REBRAND_CUTOVER.md).** Both are kept as historical record (their content described real work, most of it now done) but are no longer the place to look for open items — that's here. [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) remains the engineering design doc for `LicenseService`; this checklist is the execution tracker. [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) is left untouched as a FlightPath-era generic how-to-use-`vsce` reference — its mechanics (package/login/publish commands) are still accurate, just still branded FlightPath; Phase 9 below has the ctrlyoke-branded equivalent commands.

---

## How this doc is organized

1. **Phase 1–3** — extension/site readiness and business cutover. **All done.** Kept brief.
2. **Phase 4–5** — Pro licensing vendors (Keygen, Lemon Squeezy). **Partially done — exact remaining steps below**, current as of a live walkthrough of both dashboards on August 25, 2026.
3. **Phase 6** — Pro licensing _implementation_ (the `LicenseService` code in the extension). **Done** (see Phase 6).
4. **Phase 7–12** — legal, final packaging, marketplace publish, GitHub release, npm (deferred), launch verification.
5. **Pre-Release Compatibility Window** (just before the Summary Table) — backlog plans and bugs that are cheap to land now but would need shims, migrations, or changed behavior for existing workflows if done after launch.

---

## Phase 1 — Release Foundation ✅ DONE

- [x] Package metadata, extension display name, repository URL, icon, categories, marketplace publisher — all `ctrlyoke` / `fuzzynova` / `FuzzyNova/ctrlyoke` / `ctrlyoke.dev`.
- [x] Source-available under a custom commercial EULA — decided; the attorney-approved text is in `LICENSE.md` (Phase 7, signed off September 7, 2026).
- [x] Six harnesses (`HARNESS_IDS`), Antigravity CLI swap, `gemini-cli` fully removed.
- [x] Pre-publish security review complete.

Full detail: [`RELEASE_PLAN.md`](../implemented/RELEASE_PLAN.md) §1, §2.1–2.2, §2.5, §2.10 (kept as historical record of this work).

---

## Phase 2 — Website & Docs ✅ DONE

- [x] `ctrlyoke.dev` Astro site live: home, `/pricing`, `/terms`, `/privacy`, `/docs/` (VitePress merged).
- [x] Netlify deploy pipeline (`deploy.yml`, `deploy-preview.yml`) green.
- [x] Pre-launch `LAUNCHED` flag in `landing/src/config.ts` still gates checkout CTAs — flip at go-live (Phase 9).

---

## Phase 3 — ctrlyoke Business & Domain Cutover ✅ DONE

Everything in [`CTRLYOKE_REBRAND_CUTOVER.md`](../implemented/CTRLYOKE_REBRAND_CUTOVER.md) §1–5 is complete and verified:

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
| Enterprise policy (§1.7.1 self-serve SKU) | **`ctrlyoke Enterprise`**, id `1700d3bb-06b7-4087-96ce-e08aa6c6a817`                                                                               | Created September 8, 2026 — see 4.4 item 1 for full config. 1-year duration, 3000 max machines, otherwise mirrors `ctrlyoke Pro`.                                                                                              |

### 4.2 Admin token custody ✅ RESOLVED (August 25, 2026)

- [x] Regenerated as `fuzzynova-admin` (id `54927c5d…`) live this session, value saved in 1Password. This is the credential the Netlify webhook function will use server-side to call `POST /v1/accounts/6ed6209c-6633-4444-9d43-ab4a473e2f28/licenses` — it must **never** ship inside the VSIX; it goes into the Netlify function's environment once that function exists (Phase 5.3).
- Note: a live Playwright walkthrough of the Tokens page also turned up two other unnamed `admin-token` entries (`9990b2de…`, `1e451f7e…`). These are **not** stray integration credentials — confirmed live with Nathan that Keygen mints a fresh session-scoped admin token on every dashboard login as a quirk of Keygen using its own product for its own auth, and revoking them just logs you out. Only a token you explicitly name (like `fuzzynova-admin`) is the one meant for external use. Nothing to clean up here.

### 4.3 Dev tier vs. paid Keygen plan ✅ RESOLVED (August 25, 2026)

The account is on the free **Dev 1** plan: 2,500 API requests/day and a **100 licensed-user limit**. At $59/customer, hitting the 100-user cap means ~$5,900 in sales.

- [x] **Decision (Nathan):** launch on Dev 1 and upgrade to a paid Keygen plan reactively, triggered by the **first 2 Pro sales** landing (not waiting until closer to the 100-user cap) — an early, cheap signal that real conversion is happening, monitored manually rather than pre-committing to paid infra before any revenue exists.

### 4.4 Enterprise SKU (self-serve site license) — full build-out

**Status: in progress; promoted from a deferred stub to a real execution
checklist September 8, 2026** (Nathan wants this in for this release, not a
later one). The design itself is not new — everything below implements the
already-resolved decisions in [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md)
§1.7.1 / Open Question 6. Nothing here re-opens a design question; this is
the "how" for a "what" that's already decided.

**Price (Nathan, revised October 14, 2026): $4,499/yr**, flat, unlimited
internal seats. The first pick was $5,999/yr (a straight 100x of the $59
individual price). Lemon Squeezy's product form rejected any price above
$5,000.00 for this store, likely a new-account/low-volume risk limit (the
store's identity verification only cleared September 7, 2026), so it was set
to $5,000 on September 8. That was then lowered to $4,499. A common corporate
cost-center rule lets software and subscriptions up to $5,000 skip higher
approval, and LS adds sales tax on top of the listed price: the store-wide
"Tax-inclusive pricing" setting is off. So $5,000 lands over the cutoff as
soon as any tax applies. $4,499 leaves about 11.1% of tax headroom. See
`PRO_LICENSE_PLAN.md` §1.7.1 and Open Question 6. It is still well under the
~$10k line where buyers start expecting a PO/procurement process, so it stays
self-serve.

1. **Keygen Enterprise policy** ✅ **done September 8, 2026**, created live via the
   Keygen dashboard (Nathan signed in, agent drove the form):
   - [x] Name: `ctrlyoke Enterprise`, id `1700d3bb-06b7-4087-96ce-e08aa6c6a817`.
   - [x] Duration: **1 Year** (`31556952`s — annual, not perpetual, matches the
         subscription billing model).
   - [x] Scheme: `ED25519_SIGN` (same as Pro, one shared verification path).
   - [x] **Max Machines: 3000** — a real finite number in the plan's 2,000–5,000
         range, not blank/unlimited. Correction applied to the old stub here,
         which said "leave blank / effectively unlimited" — that directly
         contradicted the plan's own resolved decision (§1.7.1):
         `activateWithKey()` is self-serve with no human review, so an uncapped
         policy turns one leaked key into an unbounded liability instead of a
         bounded, detectable one. "Unlimited seats" stays the marketing line; the
         policy field itself is finite.
   - [x] Floating: true. Strict: true.
   - [x] Product: `ctrlyoke` (same product as Pro — second policy on the same
         product, id `f4af3c3b-4350-4a6e-af09-744797abb4b0`).
   - [x] Every other field mirrors the `ctrlyoke Pro` policy exactly (verified
         field-by-field against the live Pro policy before submitting): Auth
         Strategy `LICENSE`, Expiration Strategy `RESTRICT_ACCESS`, Expiration
         Basis `FROM_CREATION`, Renewal Basis `FROM_EXPIRY`, Transfer Strategy
         `KEEP_EXPIRY`, Machine Uniqueness `UNIQUE_PER_LICENSE`, Machine Matching
         `MATCH_ANY`, Component Uniqueness `UNIQUE_PER_MACHINE`, Component
         Matching `MATCH_ANY`, Machine Leasing `PER_LICENSE`, Process Leasing
         `PER_MACHINE`, Overage `NO_OVERAGE`, Heartbeat Cull `DEACTIVATE_DEAD`,
         Heartbeat Resurrection `NO_REVIVE`, Heartbeat Basis `FROM_FIRST_PING`,
         Heartbeat Duration `null`, Require Heartbeat `false`.

2. **Lemon Squeezy: second product — `ctrlyoke Enterprise`** ✅ **created
   September 8, 2026** as a **test-mode draft**, product id `1347884` (store
   was in Test mode at creation time — see the note on test-vs-live below):
   - [x] Created as a **subscription**, billing interval **1 Year** (LS
         defaulted to this automatically once Subscription was selected).
   - [x] Price: originally **$5,000.00/yr** (LS rejected $5,999 with "must not
         be greater than $5,000.00").
   - [ ] Change the test-mode product's price to **$4,499.00/yr** (October 14,
         2026 revision; see the price note above this list). Do this before
         copying the product to live mode so the copy carries the new price.
         The currency-masked Price field quirk below applies.
   - [x] Tax category: **Software** (same as the Pro product, 5.1).
   - [x] Generate license keys: **OFF** — Keygen issues the real license, same
         as Pro (this was already LS's default, unchanged).
   - [x] Display on storefront: **ON** (LS default, unchanged, matches Pro).
   - [x] Pricing shape: **flat unlimited**, no size tiers (tiers explicitly
         deferred per §1.7.1's "Open choice" note).
   - [x] Confirmation modal customized to match Pro's pattern (title "Welcome
         to ctrlyoke Enterprise!", message explaining the license key arrives
         by separate email, same "ctrlyoke: Activate Pro License" command
         reference as the Pro product's copy).
   - [ ] Reuse the existing `ls-webhook` endpoint/secret — no second webhook
         needed for a second product; LS fires the same event types regardless
         of which product was purchased. Not yet verified against this product
         specifically (needs item 3's routing logic + item 7's test purchase).

   **Test mode vs. live, and why this stayed in test mode:** Lemon Squeezy
   scopes products (and webhooks — see 5.3/5.4) separately per Test/Live
   mode; a product created in Test mode does not exist in the live store and
   has to be deliberately copied over once ready to sell. Nathan confirmed
   the store is currently in Test mode; built here rather than live so item
   7's verification (test purchase, simulated renewal/cancellation) can run
   safely, matching the same test-mode-first approach documented for the Pro
   product in 5.3. **Copying this product to live mode is still open** and
   should happen alongside 5.3 step 6 (flip Test mode off, create the live
   webhook) — not yet done.
   - **Implementation note (agent-driven form quirk):** the Price field is a
     currency-masked input that mishandles a bulk `fill()`/paste-style value
     set — it concatenated digits instead of replacing them (typing "5000.00"
     over an existing "5,999" produced "59995000" = $59,995,000/yr). Fixed by
     setting the native input value via JS and dispatching real `input`/
     `change` events. Worth knowing for any future automated Lemon Squeezy
     form filling.

3. **Netlify function (`netlify/functions/ls-webhook.ts`) — extend, don't fork**
   ✅ **code done September 8, 2026** (not yet deployed/tested live — see the note
   below this list):
   - [x] Route by `variant_id`: `KEYGEN_POLICY_BY_LS_VARIANT` maps LS's two variant
         ids (Pro `2059579`, Enterprise `2105478` — pulled live from the LS
         dashboard's Inertia page payload via Playwright, since neither the REST
         API nor the checkout-link UUID exposes the plain numeric id used in
         webhook payloads) to the Pro/Enterprise Keygen policy ids. `order_created`
         reads `variant_id` off `data.attributes.first_order_item` (confirmed
         against LS's published Order object schema) and throws (→ 500, LS
         retries) on an unrecognized variant rather than silently defaulting to
         Pro. The Enterprise policy's own 1-year/`FROM_CREATION` duration is what
         gives a fresh Enterprise license its 1yr expiry — no separate expiry is
         set explicitly at issuance.
   - [x] Handle LS **subscription events**. Verified against LS's published event
         list (`docs.lemonsqueezy.com/help/webhooks/event-types`) rather than
         assumed: - `subscription_created` (Subscription object — has `product_id`/
         `variant_id`/`order_id` directly, unlike Order) → looks up the license
         already created by `order_created` via `metadata.lsOrderId ==
subscription.order_id` and stamps `metadata.lsSubscriptionId` onto it,
         so renewal events can find it later. LS doesn't guarantee this fires
         after `order_created` completes (only "alongside" it) — a race throws
         and lets LS's webhook retry catch it up, the same idempotent-retry
         shape as everything else here. - `subscription_payment_success` sends a **Subscription Invoice**
         object, not the Subscription object — it has `subscription_id` and
         `billing_reason` (`initial`/`renewal`/`updated`) but no product info.
         It fires on every payment including the first, so only
         `billing_reason: "renewal"` calls Keygen's `/actions/renew` (extends
         expiry by the policy's duration from current expiry, honoring
         `Renewal Basis: FROM_EXPIRY`); `initial` is a no-op since
         `order_created` already created the license, and `updated` is a
         plan-change proration, not a renewal cycle. - `subscription_cancelled` / `subscription_expired` → explicit no-op
         case (not just falling through to `default`), documenting that this
         is deliberate: `Restrict Access` expiration already locks the license
         out at term end.
   - [x] Idempotency: license creation still keys off `metadata.lsOrderId`
         (unchanged). Renewals additionally key off `metadata.lastRenewedInvoiceId`
         (the subscription-invoice id) so a retried `subscription_payment_success`
         doesn't double-extend expiry. **Keygen metadata writes replace the whole
         object** (confirmed against Keygen's Metadata API docs), so every writer
         (`updateLicenseMetadata`) now fetches the license first and merges in
         JS rather than PATCHing a partial object that would clobber
         `buyerEmail`/`buyerName`/`lsOrderId`.
   - [x] `sendLicenseEmail`'s subject/body no longer say "Pro" — it's shared by
         both policies now that Enterprise also flows through `createLicense`.
   - [x] `npx tsc -p netlify/tsconfig.json --noEmit` and `npx prettier --check`
         both pass. TypeScript doesn't narrow a discriminated union through a
         nested path like `payload.meta.event_name` (the union only narrows on a
         top-level discriminant), so the handler parses the body as `unknown`
         and casts to the concrete per-event interface inside each `switch`
         case instead of relying on inference — each cast is guarded by the
         `eventName` switch itself, not a blind structural cast.

   ✅ **deployed and wired live September 8, 2026:** committed at `f387238f`,
   pushed to `main`, deployed via a manual `workflow_dispatch` run of
   `deploy.yml` (function-only changes aren't in the push-triggered paths
   filter — same mechanic as 5.3 step 1), run
   [`34250687935`](https://github.com/FuzzyNova/ctrlyoke/actions/runs/34250687935)
   succeeded. The test-mode LS webhook (`129600`) now also subscribes to
   `subscription_created`, `subscription_payment_success`,
   `subscription_cancelled`, and `subscription_expired` (was `order_created`
   - `order_refunded` only) — 6 events total, confirmed via LS's own "Webhook
     settings saved!" confirmation. Item 7 below covers the actual test purchase
     and renewal/cancellation verification this made possible.

4. **Abuse detection — machine-count alerting**
   - [ ] Subscribe to Keygen's `machine.created` webhook (this is the first
         _inbound_ Keygen webhook — 4.1 confirms none exist today; direction is
         Keygen → Netlify, the reverse of the LS → Netlify → Keygen purchase flow).
   - [ ] On receipt, compare the license's current activation count against an
         alert threshold well under the 2,000–5,000 policy cap (e.g. a few hundred)
         and notify (email/Slack) rather than block. Detection only, per the plan —
         response stays the manual Keygen-dashboard suspend/reissue action that
         already exists today; no new admin tooling required.
   - [x] **Hid self-service "Activated Machines" management for Enterprise**
         (September 11, 2026) — the shared, floating Enterprise key means any
         employee who activates it can otherwise see and deactivate every
         other employee's machine through the same table a solo Pro user uses
         to manage their own devices. `LicenseSection.tsx` now hides that
         section whenever `LicenseAccessState.isEnterprise` is true (set in
         `LicenseService.ts` by comparing the license file's `policy`
         relationship id against `KEYGEN_ENTERPRISE_POLICY_ID`) and shows a
         note pointing to `support@ctrlyoke.dev` instead. Freeing a slot or
         raising an org's cap above 3,000 stays a manual Keygen-dashboard
         action by us — same as this item's alerting response, and consistent
         with the deliberately-manual PO fallback in item 6 below.

5. **Self-serve legal — click-through Terms + DPA + trust page**
   ✅ **second-pass attorney-review drafts completed September 8, 2026**, all three as standalone
   root-level `*_DRAFT.md` files (matching the old `LICENSE_DRAFT.md` /
   `PRIVACY.md`-drafting precedent — not yet attorney-reviewed, not yet wired
   into `ctrlyoke.dev`, not yet renamed to their final filenames):
   - [x] [`ENTERPRISE_TERMS_DRAFT.md`](../../ENTERPRISE_TERMS.md) (now `ENTERPRISE_TERMS.md`) — drafted
         as a **standalone document that supplements `LICENSE.md`** rather than
         amending it, since `LICENSE.md` §6(d) already grants the Enterprise
         license itself. The second pass fixes the single-legal-entity scope,
         makes checkout/order acceptance explicit (activation alone is not the
         Enterprise clickwrap), discloses the real 3,000-machine ceiling and a
         no-per-seat-fee increase path, aligns cancellation/refunds/dunning with
         Lemon Squeezy's buyer terms and actual webhook behavior, corrects the
         false "then-current list price" renewal promise (Lemon Squeezy keeps an
         existing subscription's price unless it is deliberately changed), and
         adds document precedence, notices, liability, and B2B-only language.
   - [x] [`DPA_DRAFT.md`](../../DPA.md) (now `DPA.md`) — standard controller/processor
         structure. The second pass adds the missing controller/processor role
         split, Customer obligations, unlawful-instruction notice, complete
         Article 28 assistance/deletion/audit mechanics, CCPA service-provider
         restrictions, downstream-equivalent Sub-processor obligations, and
         workable EU SCC Module 2/3, UK Addendum, and Swiss adaptations with
         the commercial selections substantially completed. Annexes distinguish
         the actual Customer-directed Sub-processors (Keygen, Netlify, Resend)
         from vendors used for Fuzzy Nova's independent-controller activity
         (for example, telemetry and merchant-of-record processing), and
         document specific technical and organizational measures instead of
         generic assurances.
   - [x] [`TRUST_PAGE_DRAFT.md`](../../TRUST_PAGE.md) (now `TRUST_PAGE.md`) — architecture
         summary, what is/isn't collected, provider table (six vendors,
         Resend included), licensing-security section (offline Ed25519
         verification, the actual 3,000-machine cap, fast suspend/reissue),
         accurate Marketplace signature language, vulnerability-reporting
         pointer to `SECURITY.md`, and an honest "no SOC 2/ISO yet,
         minimal-data-by-design instead" compliance-posture paragraph.
   - [x] `PRIVACY.md` Resend gap fixed in the September 8, 2026 version 1.1
         attorney-review changes: Resend is now disclosed both where the data is
         collected/used and in the provider table, Netlify's webhook-processing
         role is explicit, and the misleading all-vendors-as-"Sub-processors"
         heading is corrected to account for independent controllers such as the
         merchant of record. Keep the planned Azure Application Insights
         telemetry disclosure — telemetry implementation is a high-priority
         pre-attorney-review dependency and will be present before these files
         are sent.
   - [x] These three together are what let a buyer's legal team self-serve their
         review without a custom MSA — the entire point of keeping this zero-touch
         (§1.7.1). Skipping any one of them risks pulling every enterprise deal
         into a manual sales/legal cycle.
   - [x] **Before sending to the attorney:** finish the telemetry implementation;
         use VS Code's telemetry trace to verify every custom and library-added
         field against `PRIVACY.md`; confirm Azure's 90-day retention and default
         IP-masking configuration; add `telemetry.json` for inspectable event
         declarations; confirm the Article 28 agreements and transfer terms in
         place with Keygen, Netlify, and Resend; and give the attorney the three
         drafts plus the `PRIVACY.md` v1.1 changes in one review packet.
   - [ ] **Before accepting a live Enterprise order:** make the Enterprise Terms,
         EULA, and Privacy Policy conspicuous at checkout with affirmative assent
         by an authorized representative on behalf of the named legal entity;
         collect that entity's legal name and business address; retain the
         accepted document versions, timestamp, and order/customer identifiers;
         configure a 30-day annual renewal notice (Lemon Squeezy's built-in
         reminder is only seven days); and verify the cancellation path and legal
         links in a live-mode checkout.
   - [x] **Done September 17, 2026:** attorney review of all three drafts and
         `PRIVACY.md` v1.1 complete and approved (same Phase 7 attorney who signed
         off on `LICENSE.md`/`PRIVACY.md`). `LICENSE.md` already named
         **Fuzzy Nova LLC**, not the DBA, so no conforming update was needed there.
         The three drafts were renamed to their final filenames — `DPA.md`,
         `ENTERPRISE_TERMS.md`, `TRUST_PAGE.md` — and wired into `ctrlyoke.dev` as
         `landing/src/pages/dpa.astro`, `enterprise-terms.astro`, and `trust.astro`,
         the same way `terms.astro`/`privacy.astro` render
         `LICENSE.md`/`PRIVACY.md` via `import { Content } from "..."`. The site
         nav/footer link to all three; `pricing.astro` gained a real Enterprise
         tier card (now $4,499/yr) and links to the Trust page, Enterprise Terms, and
         DPA for buyer security/legal review.

6. **PO fallback**
   - [ ] `sales@ctrlyoke.dev` already exists (Phase 3) — confirm it's monitored.
   - [x] Add one line on the Enterprise pricing card: "Need an invoice or PO?
         Email sales@ctrlyoke.dev." No automation required; kept deliberately rare
         by design, not a funnel to build out. _Verified 2026-10-10:_ the
         Enterprise card in `landing/src/pages/pricing.astro` lists "PO /
         invoicing available" under a "Contact sales" `mailto:sales@ctrlyoke.dev`
         button, and the Enterprise FAQ says to email sales@ to request a PO.

7. **Verification** ✅ **purchase + renewal + expiry paths verified September 8,
   2026** (machine-count alerting below is still open — that's item 4, not yet built):
   - [x] Live test-mode purchase of the Enterprise product — same shape as the Pro
         smoke test in 5.3, plus the subscription-specific paths Pro doesn't have.
         Product had to be flipped from Draft to Published first (same "no
         checkout link for a Draft product" constraint hit in 5.3). Full chain
         confirmed on Keygen license `59561958-e0ca-4127-a658-c0bc9b9734ba`: - `order_created` (order `9415949`) → 200 → license created under the
         **Enterprise** policy (not Pro), confirming variant-based routing works
         against a real purchase, not just code review. - `subscription_created` (subscription `2511452`) → 200 → license
         metadata gained `lsSubscriptionId: "2511452"` while `lsOrderId`,
         `buyerEmail`, `buyerName` all survived the merge (proves
         `updateLicenseMetadata`'s fetch-then-merge, not LS's simulator, since
         this ran against the real purchase). - `subscription_payment_success` (invoice `8404222`, `billing_reason:
"initial"`) → 200, correctly ignored (no renewal on the invoice that
         accompanies the purchase itself). - License: policy **ctrlyoke Enterprise**, product **ctrlyoke**, status
         **ACTIVE**, expiry **2027-09-08 (1 year out)**, machine cap **0 of
         3000** — matches the policy's own duration, no explicit expiry needed
         at issuance as designed. - Both emails arrived: LS's payment receipt and the Resend
         license-key email (confirmed by Nathan directly).
   - [x] Renewal and no-op-cancellation paths, tested **two different ways**
         because LS's dashboard "Simulate event" tool for `subscription_created`
         to `subscription_expired` (found live on a subscription's detail page —
         `/subscriptions/{id}` → **Simulate event**, not just the more limited
         event list `docs.lemonsqueezy.com/help/webhooks/simulate-webhook-events`
         documents) turned out to just **replay the subscription's real,
         already-existing invoice** rather than fabricate a new one — so it
         can't produce a `billing_reason: "renewal"` payload on a subscription
         that has only ever had its initial invoice. Re-running it against
         `subscription_payment_success` reliably replayed invoice `8404222`
         (`billing_reason: "initial"`) and got 200/"Ignored (not a renewal)"
         both times — a correct but redundant re-test of the same no-op path
         above, not a renewal test. - **Renewal**, tested by hand-crafting a real subscription-invoice
         payload (`billing_reason: "renewal"`, real `subscription_id: 2511452`,
         synthetic invoice id) and POSTing it directly to
         `https://ctrlyoke.dev/.netlify/functions/ls-webhook` with a correct
         `X-Signature` (HMAC-SHA256 over the raw body using the real webhook
         signing secret from the LS dashboard) — the same mechanism LS itself
         uses, just invoked directly since neither LS's UI nor its documented
         simulate-event list can generate this specific payload shape on
         demand. Result: 200, and the Keygen license's expiry moved from
         **2027-09-08 to 2028-09-08** — exactly +1 year, honoring the policy's
         `Renewal Basis: FROM_EXPIRY`. Re-posting the identical signed payload
         a second time returned 200 but left expiry at 2028-09-08 unchanged,
         confirming the `lastRenewedInvoiceId` idempotency guard. - **Cancellation/expiry no-op**, tested via LS's real "Simulate event"
         → `subscription_expired` against the live subscription. 200 response;
         Keygen license confirmed unchanged (expiry still 2028-09-08, status
         still `ACTIVE`, `Suspended: false`) — verifies the explicit no-op
         branch actually does nothing, not just that it returns 200.
   - [ ] Confirm the machine-count alert path works end-to-end against a scratch
         policy temporarily capped low (a handful of test activations), before
         relying on it at the real 2,000–5,000 threshold.

**Not a launch blocker for Phases 6–12** — this is an independent checklist
that can land before or after the individual-Pro Marketplace publish; nothing
above gates the existing release-blocker chain.

---

## Phase 5 — Pro Licensing Vendor: Lemon Squeezy

**Status: store rebranded and product drafted live this session.** Before this session, the LS store existed under the old `Fuzzy Nova` branding with **zero products** — this vendor was much further behind than Keygen. Below is exact current state plus the exact remaining steps.

### 5.1 Current state (verified/changed live, August 25, 2026)

| Item                                      | Value                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store name                                | **ctrlyoke**                                                        | Changed live this session from `Fuzzy Nova`. Settings → General → "Store name" — appears on every receipt/invoice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Store URL                                 | **ctrlyoke.lemonsqueezy.com**                                       | Changed live this session from `fuzzynova.lemonsqueezy.com`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Contact email                             | **support@ctrlyoke.dev**                                            | Changed live this session from `admin@fuzzno.com`. This is the address shown to customers on receipts/invoices for support.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Store activation                          | **Approved** (September 7, 2026)                                    | Lemon Squeezy's identity-verification/KYC review cleared. Live payments can now process once Test mode is flipped off (5.3 step 6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Test mode                                 | **ON**                                                              | Toggle top-right of every LS dashboard page. Real charges are impossible while this is on, regardless of store-activation status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Product                                   | **ctrlyoke Pro**, id `1317307`                                      | Created live this session. Status: **Published** (August 26, 2026 — see 5.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| — Price                                   | **$59.00**, Single payment (one-time)                               | Matches [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| — Tax category                            | **Software**                                                        | Chosen over the form's default "SaaS - personal use" — ctrlyoke Pro is a perpetual license unlocking local functionality, not a hosted service Fuzzy Nova operates on the buyer's behalf. Decided live this session.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| — Generate license keys                   | **OFF (unchecked)**                                                 | Correct per plan — Keygen issues the real license, not Lemon Squeezy's native key system.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| — Display on storefront                   | **ON**                                                              | Will show once published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| — Confirmation modal / email receipt copy | Set to explain the Keygen key arrives by separate email             | See 5.2 — this is the resolution of the plan's previously-open "key delivery" question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Webhooks                                  | **One configured (test mode)**, id `129600`                         | Created live August 26, 2026: `https://ctrlyoke.dev/.netlify/functions/ls-webhook`, listening for `order_created` + `order_refunded` (+ `subscription_created`, `subscription_payment_success`, `subscription_cancelled`, `subscription_expired` added September 8, 2026 for the Enterprise SKU — see 4.4 item 3). Signing secret set by us (LS lets you choose your own, ≤40 chars — it does not auto-generate and reveal one). Smoke-tested successfully (see 5.3). **Note:** this webhook only fires for test-mode data — a second, live-mode webhook (same URL/events) will need to be created when Test mode is flipped off for real launch (5.3 step 6). |
| API keys                                  | **None created**                                                    | Not needed for the Phase 1 flow — the Netlify function only _receives_ LS webhooks and _calls out_ to Keygen; it doesn't need to call back into the LS API for the MVP (order/refund payloads carry enough data). Skip unless a future feature needs it.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Payouts                                   | Fuzzy Nova LLC **Mercury** account (USD)                            | Switched from the personal account (•••• 0725) on October 14, 2026, along with Payout invoice info (now the LLC) and the card on file (now the Mercury card). |
| Payout tax info                           | ✅ Submitted (August 25, 2026), via Stripe Connect tax-details flow | Confirmed live: the "[Action Required]" banner is gone from Settings → Payouts. **Re-done for Fuzzy Nova LLC on October 14, 2026:** the Stripe Express legal entity is now Company with the LLC's EIN, and the EIN is verified. Details and the exact legal-name string that verified are in the Drive `Formation & Legal/LLC_FORMATION_GUIDE.md` §7.1.1. |
| Custom checkout domain                    | Not connected                                                       | Optional polish (e.g. `checkout.ctrlyoke.dev`) — Settings → Domains → currently empty. Not a blocker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Store logo                                | Assets generated; not uploaded                                      | Cosmetic — upload [`images/ls-logo.png`](../../images/ls-logo.png) (160×160 opaque logo with 20px padding for Lemon Squeezy's circular crop) in Settings → General → Logo; use [`images/ls-favicon.png`](../../images/ls-favicon.png) for the 32×32 favicon if requested. Not a blocker.                                                                                                                                                                                                                                                                                                                                                                       |

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
5. ~~**Wait for / follow up on** Lemon Squeezy's identity-verification review~~ ✅ **approved September 7, 2026.**
6. **Go live: switch Lemon Squeezy out of Test mode and move the products over.** Now unblocked. Every item here is a manual LS-dashboard action for Nathan, not something to do silently, because flipping Test mode off enables real charges. LS keeps products and webhooks separate per mode (confirmed live August 26, 2026): nothing built in Test mode exists in the live store until it is copied or recreated there. Do the items in this order. **Do not share a live checkout link until the variant-id redeploy below has shipped.** Until then, `ls-webhook.ts` throws `Unrecognized LS variant_id` on every live order, so the buyer is charged and never gets a license.
   - [ ] **Before copying:** change the test-mode Enterprise product's price to **$4,499.00/yr** (4.4 item 2) so the live copy carries the new price.
   - [ ] **Flip Test mode OFF.**
   - [ ] **Copy both products to live mode** (`ctrlyoke Pro` and `ctrlyoke Enterprise`). Then check each live copy field by field against the test product, without assuming the copy carried everything over. Pro should be **$59.00**, single payment. Enterprise should be **$4,499.00**, a subscription billed every **1 Year**. On both, check that the tax category is **Software**, Generate license keys is **OFF**, Display on storefront is **ON**, the confirmation modal and receipt copy say the key arrives by separate email, and the status is **Published**, not Draft (a Draft product has no checkout link; see step 3).
   - [ ] **Confirm store-wide "Tax-inclusive pricing" is still OFF** in live mode (Settings → General). The $4,499 tax headroom depends on it.
   - [ ] **Record the live ids:** each live product id and its default variant id (Settings → Products, or the product's edit page).
   - [ ] **Update `LS_VARIANT_ID` in `netlify/functions/ls-webhook.ts`** to the live variant ids. The current Pro `2059579` / Enterprise `2105478` are the test-mode variants. Once this ships, test-mode orders stop routing: they throw the same unrecognized-variant error. That's fine after launch. If test-mode purchases are needed again later, map both sets of ids in `KEYGEN_POLICY_BY_LS_VARIANT`.
   - [ ] **Redeploy the function** with a manual `workflow_dispatch` run of `deploy.yml`. `netlify/functions/**` is not in its `paths:` filter (see step 1).
   - [ ] **Create the live-mode webhook** at `https://ctrlyoke.dev/.netlify/functions/ls-webhook`, with the same 6 events as test webhook `129600` (`order_created`, `order_refunded`, `subscription_created`, `subscription_payment_success`, `subscription_cancelled`, `subscription_expired`) and **the same signing secret** as the test webhook. Netlify's `LEMONSQUEEZY_WEBHOOK_SECRET` holds one value, so a different live secret would fail HMAC verification on every live event. Netlify won't reveal a Secret-scoped env var after it's saved, so the value has to come from wherever it was stored when it was generated (step 2). If it can't be recovered, set a new one in both the live webhook and Netlify and redeploy; the test webhook then stops verifying, which doesn't matter after launch.
   - [ ] **Live smoke test, Pro:** buy Pro once with a real card. Confirm that the live webhook delivered with **200** (LS → Settings → Webhooks → recent deliveries) and the payload shows `test_mode: false`, that a Keygen license was created on the **`ctrlyoke Pro`** policy, and that the Resend email arrived with a key that activates in the extension. Then refund the order and confirm the license is **suspended**. Cost: LS's fee (~$3.45) is not returned on refund.
   - [ ] **Live smoke test, Enterprise routing:** a real $4,499 purchase-and-refund would lose ~$225 in fees. Use a single-use **100%-off discount code** limited to the Enterprise product instead, if LS allows a $0 subscription checkout. Confirm the license lands on the **`ctrlyoke Enterprise`** policy with a 1-year expiry. Then cancel the subscription, suspend or delete the license in Keygen, and delete the discount code. If LS won't do a $0 checkout, watch the first real Enterprise order's delivery and license policy by hand instead.
   - [ ] **Check that tax is really added on top in live mode.** Test-mode checkouts for both products showed no tax even though "Tax-inclusive pricing" is off. That is most likely because of the test billing address, not proof that test mode skips tax. Before relying on the $4,499 headroom, start a checkout with a billing address that should be taxed (for example a UK/EU consumer, or a US state that taxes SaaS) and confirm the total. Abandoning at the payment step is enough; the tax line shows before payment.
   - [ ] **Clean up Keygen:** delete or suspend the smoke-test licenses. They count against the Dev-tier 100-license cap; see the Verification Plan in `PRO_LICENSE_PLAN.md`.
   - [ ] **Update this checklist's records with the live values:** the 5.1 table's Products and Webhooks rows (live product ids, live webhook id), 4.4 item 2's "copying this product to live mode is still open" note, 4.4 item 3's variant-id citation, and the Phase-status table's "live-mode product copy" open item.
   - [ ] **Grab the live checkout links** from each live product's **Share** button. The test-mode links stop being sellable. Keep the Pro link ready for `CHECKOUT_URL` in Phase 9. The Enterprise card in `landing/src/pages/pricing.astro` currently links only to `mailto:sales@ctrlyoke.dev`. Decide whether it should also get a self-serve "Buy" link, since a self-serve checkout is the whole point of §1.7.1's zero-touch design. Either way, it waits for 4.4 item 5's live-checkout assent setup ("Before accepting a live Enterprise order").
   - **Deliberately still held:** setting `CHECKOUT_URL` in `landing/src/config.ts` and flipping `LAUNCHED = true` (Phase 9) — those put a real "Buy" link in front of the public before the extension itself is Marketplace-published, which is still blocked on Phase 7's attorney EULA sign-off. Do those two together with the rest of Phase 9, not now.

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
- [x] `docs/pro/mobile-setup.md` — phone setup guide (HTTPS, certificate trust, PWA install). Shared computer steps first (`images/screenshots/desktop-server-setup-*`), then separate iPhone/iPad and Android sections, each with per-step screenshots and an animated overview (`images/screenshots/{ios,android}-pwa-setup-*`). See `dev/backlog/SCREENSHOTS_AND_MEDIA_PLAN.md` #7.

---

## Phase 7 — Legal & Support

- [x] Attorney-drafted EULA + Privacy Policy exist as canonical `LICENSE.md` / `PRIVACY.md`.
- [x] Effective-date placeholders (`[DATE]`) replaced with real dates.
- [x] **Final attorney sign-off** on the custom commercial EULA text — approved September 7, 2026. (`LICENSE_DRAFT.md` no longer exists as a separate file; it was merged straight into `LICENSE.md`, which already carries a real effective date and no placeholder text.)
- [x] `package.json#license` → already reads `SEE LICENSE IN LICENSE.md` — verified live September 7, 2026, no change needed now that the EULA is final.
- [ ] **Appoint DataRep as the EU/EEA and UK GDPR Article 27 representative
      before intentionally offering paid plans in those markets or enabling
      telemetry for users there.** This is a sales/monitoring launch gate, not a
      requirement to hire two lawyers: DataRep supplies the EU appointment
      through its Irish entity and the separate UK appointment through DataRep
      UK under one service. Current plan and purchase procedure (verified
      September 17, 2026):
  1. Start with DataRep's [free representative
     consultation](https://www.datarep.com/consultation/) and send them links or
     copies of `PRIVACY.md` and, if useful, `DPA.md`. Ask them to confirm in
     writing that Fuzzy Nova LLC's planned EU/EEA and UK sales plus routine
     product telemetry require both appointments, and that the selected package
     expressly includes both legal mandates. Do not rely only on a checkout-page
     description.
  2. If DataRep confirms the current facts, buy its [Small Company — No
     Sensitive Data package](https://www.datarep.com/product/small-company-package/),
     currently **€150/year** for no more than **1,000 EU/EEA/UK data subjects**.
     DataRep's [current service page](https://www.datarep.com/service/eu-gdpr-article-27-representative-service/)
     says the UK appointment is included at no extra cost. Count identifiable
     prospects, website/license users, support and sales
     correspondents, and telemetry subjects — not only paying customers. If the
     real count or data categories do not meet those limits, buy the package
     DataRep recommends instead.
  3. Complete DataRep's one-page questionnaire with the exact controller name
     **Fuzzy Nova LLC**, Texas address, `privacy@ctrlyoke.dev`, product/website
     description, countries targeted, data-subject estimate, processing/data
     categories, retention, transfers, and vendors. Use the final Privacy Policy
     and the processing inventory in the DPA annexes as inputs, but answer from
     actual production behavior. Disclose any changed or special-category data
     rather than selecting the cheaper tier on assumption.
  4. Before considering this done, obtain and retain privately (do not commit
     contracts or account credentials) the executed EU and UK appointment
     letters/certificates, effective and renewal dates, exact legal entity names,
     postal addresses, email/web-form details, chosen EU contact country, request
     forwarding/SLA instructions, and the wording DataRep requires customers to
     publish. Confirm `privacy@ctrlyoke.dev` is monitored. Maintain the Article 30
     record of processing DataRep must be able to provide to authorities; the
     representative is a contact point, not an outsourced compliance program or
     DPO.
  5. **Immediately after the appointments become effective, update the legal
     documents from DataRep's executed paperwork — never guess the entity or
     contact details:**
     - In `PRIVACY.md`, increment the version and `Last Updated` date and add a
       clearly labelled **EU/EEA representative** and **UK representative** under
       Section 14 (`Contact`). For each, reproduce DataRep's exact legal entity
       name, postal address, email/web request route, covered territory, and
       instructions for data subjects and supervisory authorities. Keep Fuzzy
       Nova's controller identity and `privacy@ctrlyoke.dev` alongside them.
     - In `TRUST_PAGE.md`, add the two representative contacts to `## Contact` and a
       short, factual statement in `## Compliance posture`; update its date. Do
       not list DataRep in the infrastructure-vendor table merely because it is
       the statutory representative.
     - Do **not** add DataRep automatically to `DPA.md`'s Customer Personal
       Data Sub-processor list: the Article 27 appointment supports Fuzzy Nova's
       own statutory obligations and is not, by itself, Customer-directed
       processing under the DPA. `LICENSE.md` and
       `ENTERPRISE_TERMS.md` likewise need no representative clause unless
       DataRep or reviewing counsel identifies a specific reason. If the
       appointment changes any actual data flow, update every affected document
       and the DPA annexes consistently.
     - Render `/privacy` and `/trust` locally, verify all representative links and
       line breaks, search the repository for stale privacy version/contact text,
       and include the appointment details in the pending attorney-review packet.
       The website already imports the canonical Markdown; do not create a second
       hand-maintained copy of either document.
  6. At least eight weeks before annual expiry, verify the data-subject count,
     data categories, countries, breaches, and processing changes; complete
     DataRep's renewal questionnaire and renew or upgrade without a coverage gap.
     Revisit the tier earlier when approaching 1,000 relevant people or whenever
     processing changes materially.
- [ ] Publish the refund policy decided in [`REFUND_POLICY.md`](../backlog/REFUND_POLICY.md): Pro gets a 30-day money-back guarantee, and Enterprise stays non-refundable under the existing terms. Add the pricing FAQ, docs, and LS product copy, fix the partial-refund webhook bug, and add the live-mode webhook events. Lemon Squeezy has no auto-refund setting, so each refund is approved by hand. _Repo-side progress (2026-10-10):_ the pricing FAQ and Pro card carry the 30-day guarantee, `docs/pro/index.md` mentions refunds, and the partial-refund webhook bug is fixed (`87ba0728a`; `dev/bugs/implemented/partial-refund-suspends-license.md`). The LS product copy and the live-mode webhook events cannot be checked from the repo.
- [ ] Publish `ctrlyoke.dev/terms` plain-language summary (the legal page itself is already live rendering `LICENSE.md` directly).
- [x] Keep public GitHub Issues for community reports; `support@ctrlyoke.dev` stays private for Pro/Enterprise support (both already exist — verified as the intended steady state, not a pending action).

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
- [ ] `out/cli.js` and the `bin/ctrlyoke` / `bin/ctrlyoke.cmd` shims **included** (decided 2026-09-24 — see [`CLI_DISTRIBUTION_PLAN.md`](../implemented/CLI_DISTRIBUTION_PLAN.md)).
- [ ] `node_modules/node-pty/` included.
- [ ] `.ctrlyoke/`, `.agents/`, local logs, prompts, test logs, dev-only files **not** included.
- [ ] Generated VSIX version matches `package.json` (currently `0.1.2`; `release.yml` enforces tag == version via `scripts/verify-release-tag.mjs`).
- [ ] `npm audit` — no new production advisories since the last check (dev-only findings tracked in `dev/implemented/DEPENDENCY_UPGRADE_PLAN_2026_10.md` are fine to carry).

**Also still open from the original plan, unrelated to licensing:**

- [x] **Screenshots + demo GIF** for README/Marketplace — promoted to a release blocker (Nathan, July 4, 2026). Done 2026-10-12: `README.md` has `readme-demo-720x480.gif` (10 s cut from the hero video) and two stills, linked as absolute `https://ctrlyoke.dev/docs/screenshots/` URLs that `scripts/sync-docs-screenshots.mjs` publishes with the docs site. Confirm they render on the deployed site and in the Marketplace listing during Phase 9's post-publish check. The rest of `SCREENSHOTS_AND_MEDIA_PLAN.md` (walkthrough media, landing feature cards, #14) is not release-blocking.
- [x] Confirm dev-only command `ctrlyoke: Developer Tools` stays hidden unless `ctrlyoke.devMode` is set. Verified 2026-10-10: the `ctrlyoke.devMenu` command-palette entry in `package.json` has `"when": "ctrlyoke.devMode"`.

---

## Phase 9 — Marketplace Publish

- [x] Publisher `fuzzynova` confirmed, item id `fuzzynova.ctrlyoke` reserved (published-then-unpublished during the cutover).
- [x] Generate/verify an Azure DevOps PAT with Marketplace **Manage** scope (see [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) §"Create a Personal Access Token" — mechanics unchanged, just ignore the FlightPath naming in that doc). Done September 8, 2026 — set as the `VSCE_PAT` GitHub repo secret, which `release.yml` reads directly; the `vsce login`/interactive-paste flow below is only needed for a manual local publish, not the CI path.
- [x] `npx vsce login fuzzynova`
- [x] `npm run package && npx vsce publish` (or `npx vsce publish --packagePath ctrlyoke-0.1.0.vsix`) — done; listing is live on the Marketplace, currently set to unpublished/private visibility since public release hasn't been announced yet.
- [ ] Post-publish: confirm listing loads, README renders, CHANGELOG tab shows `0.1.0`, install into a clean profile, run one workflow.
- [ ] **Trademark filing (business-side, tracked in the Drive `Trademark & IP/TRADEMARK_FILING_GUIDE.md`):** once the listing is public, capture dated screenshots of the live Marketplace listing (IC 009 specimen) and `ctrlyoke.dev` (IC 042 specimen), then submit the saved §1(a) USPTO draft — **edited first to name Fuzzy Nova LLC as owner**, not Nathan individually.
- [ ] Flip `LAUNCHED = true` and set the real `CHECKOUT_URL` in `landing/src/config.ts` only after Phase 5 checkout is verified end-to-end **and Phase 7's DataRep EU/EEA + UK appointments are effective and published in the Privacy Policy**. If launching without those appointments, geo-block EU/EEA/UK sales and do not intentionally monitor people there until counsel confirms the Article 27 position.

---

## Phase 10 — GitHub Release

_2026-10-10:_ `release.yml` automates this phase. GitHub Releases `v0.1.1` (2026-09-17) and
`v0.1.2` (2026-09-25, "Latest") already exist on the private repo, with the VSIX attached.
No `v0.1.0` tag was ever cut. The items below apply to whichever version becomes the public launch
release; its `CHANGELOG.md` entry needs a real date (the `[0.1.0]` entry still says
2026-05-12).

- [ ] Tag `v0.1.0`.
- [ ] Create GitHub Release from the `CHANGELOG.md` `[0.1.0]` entry.
- [ ] Attach the final `ctrlyoke-0.1.0.vsix`.
- [ ] Confirm the release URL is under `FuzzyNova/ctrlyoke` (already renamed — just a sanity check).

---

## Phase 11 — CLI Distribution

**Decided September 24, 2026** — see [`CLI_DISTRIBUTION_PLAN.md`](../implemented/CLI_DISTRIBUTION_PLAN.md). The CLI ships through two channels built from one artifact at one version: bundled in the VSIX and put on `PATH` in VS Code terminals and ctrlyoke-spawned harness processes (no system PATH edits), **and** published to npm as a dedicated `ctrlyoke` package (not the root `package.json`) by `release.yml` from the same tag.

- [x] Reserve the `ctrlyoke` npm name under a Fuzzy Nova–owned account with 2FA — done September 25, 2026: npm user `fuzzynova` (`admin@fuzzno.com`, passkey 2FA) published a `0.0.1` placeholder that prints "coming soon" and exits `1`. The account uses a passkey, not TOTP, so a manual `npm publish` needs `--auth-type=web` from an interactive terminal.
- [x] On npmjs.com → `ctrlyoke` → Settings: trusted publisher added (GitHub Actions, `FuzzyNova`/`ctrlyoke`, workflow `release.yml`, **staged publishing only**), and publishing access set to "Require two-factor authentication and disallow tokens" — done September 25, 2026. The `ctrlyoke` npm org also exists, to reserve the `@ctrlyoke` scope.
- [x] VSIX bundling + terminal PATH (plan §3.1) — done September 25, 2026. `ctrlyoke.installCli` and its optional walkthrough step were un-hidden in the same change that added the npm publish step, so both ship with the first release that stages to npm.
- [x] Coexistence guard, rule 3 — done September 25, 2026: `schemaVersion` on shared run/lock/trust/board state with refuse-to-write on a newer format, and a newer `runner.json` treated as held.
- [x] Coexistence guard, rule 2 — done September 25, 2026: the `~/.ctrlyoke/installations.json` host registry with once-per-version-pair mismatch warnings (CLI on stderr, extension as a notification). **Must land before or with the first npm publish** — that is the first moment two ctrlyoke versions can touch the same state.
- [x] npm package build (`scripts/build-npm-package.mjs`), packaging test (`scripts/build-npm-package.test.mjs`), and the staged-publish step in `release.yml` (plan §3.2) — done September 25, 2026. Not yet exercised by a real tag.
- [ ] **Every release:** after `release.yml` finishes, approve the staged version on npmjs.com → `ctrlyoke` → Staged Packages (or `npm stage approve <id>` from an interactive terminal). Approval needs the passkey. Until it's approved, the npm version lags the Marketplace, and the Install CLI command types a version that doesn't exist yet.
- [ ] **Every release:** `npm view ctrlyoke version` matches the tag; `npx ctrlyoke --version` works on a clean machine. Checked for `0.1.2` on September 25, 2026 (npx from an empty cache: `--version`, `validate --json`, `ctrlyoke-mcp`).
- [x] First staged release: `v0.1.2` (September 25, 2026) staged `ctrlyoke@0.1.2` from the private repo with no provenance setting. npm skipped provenance and did not fail, and the tarball test passed on the Linux runner. After the Phase 14 flip, check that provenance shows on the package page.

---

## Phase 12 — Launch Verification

- [x] Clean VSIX install, no license: all free functionality works — verified by production-package/code-path review; a clean-profile install was not run in this environment.
- [x] Remote-access trial activates for a fresh install; 14-day window enforced — verified by code-path review of first-use global-state initialization and the 14-day comparison.
- [x] Trial expiry falls back to localhost-only without breaking workflows — verified by code-path review of the bind gate and free local workflow paths.
- [x] Pro activation (online key) unlocks remote dashboard + other Pro features immediately, no restart — live-tested by Nathan against a real Keygen key.
- [x] Air-gapped license file import unlocks Pro with zero network calls — Nathan generated a signed license file from Keygen for one of the `dev/test_keys.md` licenses and imported it via `LicenseSection.tsx`'s "Import offline license file" flow; activation succeeded.
- [ ] Self-serve offline license generator works end-to-end with a real Pro license key, and the resulting file imports successfully on an air-gapped machine.
- [ ] Lemon Squeezy **test-mode** order → exactly one Keygen license created, webhook retry doesn't duplicate it.
- [ ] Refund (test mode) → Keygen license suspended/revoked and the buyer receives the refund confirmation email; a partial refund leaves the license active.
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
| Full suite including `test:extension` (`@vscode/test-electron`)           | **Actions — `workflow_dispatch`**, optionally a weekly `schedule` | Needs a display; the workflow runs the extension suite under `xvfb-run -a`. Run it before cutting a release, or after extension-host changes.                                                   |
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

- [x] **Local pre-push hook — the fast gate.** ✅ Built September 7, 2026:
      `.githooks/pre-push` (POSIX `sh`, portable across Git Bash on Windows and
      CI shells) + `git config core.hooksPath .githooks` set locally. Runs
      `typecheck`, `lint`, `test:ui`, `test:packaging` in sequence, stopping on
      first failure; **never** runs `test:harness`. Skips the whole run when
      every changed file in the push is under `dev/**`, `docs/**`, or matches
      `*.md`, diffing each pushed ref against its remote SHA (or `main`'s
      merge-base for a brand-new ref). Fails fast with a clear message if
      `node_modules/.bin/tsc` is missing (the per-worktree `npm ci` caveat)
      instead of letting the underlying scripts fail confusingly. Each worktree
      still needs `git config core.hooksPath .githooks` run once locally — it's
      a local config, not something a commit can propagate to other clones.
- [x] **Full-suite workflow on `workflow_dispatch`** — ✅ Built September 7,
      2026: `.github/workflows/full-suite.yml`, `workflow_dispatch` plus a
      weekly `schedule` (Monday 13:00 UTC). Runs the extension suite (under
      `xvfb-run`), the UI suite split into two `--shard` jobs, and the
      packaging suite as parallel jobs on `ubuntu-latest`. **Triaged
      (2026-10-13):** the extension suite's missing-harness failure was fixed in
      `6f19a8191`, and the remaining red came from UI tests hitting Vitest's 20s
      timeout on the 2-vCPU private-repo runner (now 60s). Confirm a green
      run before relying on it as a release gate.
- [x] **`release.yml` on `push: tags: ["v*"]`** — ✅ Built September 7, 2026:
      `.github/workflows/release.yml`. Runs the version/tag guard, `npm run
package`, `npx vsce publish --packagePath ctrlyoke-<version>.vsix`, then
      creates the GitHub Release via `softprops/action-gh-release` (now `@v3`; `@v2` broke under the Node 20 deprecation) with the
      matching `CHANGELOG.md` section (from the new
      `scripts/verify-release-tag.mjs`) as the body and the VSIX attached.
      Declares an explicit `permissions: contents: write` block (the two
      existing Netlify workflows don't need one; this one does, to create a
      Release). **Functional:** `VSCE_PAT` landed September 8, 2026. The `v0.1.1`
      tag's runs failed (2026-09-17, 2026-09-23); the `v0.1.2` run succeeded
      2026-09-25 (Marketplace publish, GitHub Release, npm stage). It now also
      stages the npm CLI package (Phase 11).
- [x] **Version/tag guard in that workflow** — ✅ Built September 7, 2026, as
      part of the same script: `scripts/verify-release-tag.mjs` compares the
      pushed tag (minus its leading `v`) against `package.json#version` and
      fails loudly on mismatch, before packaging happens. Covered by
      `scripts/verify-release-tag.test.mjs` (5 tests), wired into
      `test:packaging`. Verified locally against the real `CHANGELOG.md` and
      the real `package.json#version` (`0.1.0`), plus a deliberate mismatch
      (`v9.9.9`) failing as expected.
- [x] **Release commit convention** — ✅ Documented September 7, 2026 in
      `CONTRIBUTING.md`'s new "Cutting a release" section: bump
      `package.json#version`, rename `CHANGELOG.md`'s `[Unreleased]` heading to
      `[X.Y.Z] - <date>`, annotated tag, push. Not automated (deliberately a
      manual, deliberate act, not a script) — `release.yml` picks up from the
      tag onward.
- [x] **Pre-release channel instead of a staging branch** — ✅ Documented
      September 7, 2026 in `CONTRIBUTING.md`: `vsce publish --pre-release`,
      `major.EVEN.patch` stable / `major.ODD.patch` pre-release convention, run
      manually (not automated in `release.yml`, which only handles stable `v*`
      tags).
- [x] **Document the hotfix path** — ✅ Done September 7, 2026: the
      `git switch -c release/X.Y <tag>` recipe now lives in `CONTRIBUTING.md`'s
      "Cutting a release" section, alongside the reasoning for why standing
      release branches aren't used otherwise.
- [ ] **Flip the repo to public** — Phase 14's pre-flip gates (EULA, secret
      scan, Issues/PRs skim, MFA hardening) all cleared September 7, 2026; the
      actual toggle in 14.5 remains Nathan's call to trigger. **The same
      session as the toggle, run `node scripts/apply-github-guardrails.mjs`**
      (14.5). Until it runs, the public repo has no `main` or `v*` tag
      rulesets, no fork-PR approval gate and no push protection.

**Also built this pass, not originally itemized above but needed to support
it:** GitHub public-contribution scaffolding — `CONTRIBUTING.md`, `SECURITY.md`
(vulnerability reports to `security@ctrlyoke.dev`, not public Issues),
`.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`, and
`.github/PULL_REQUEST_TEMPLATE.md`. None of this existed before — the repo had
zero community-health files. Deliberately **no `CODE_OF_CONDUCT.md`** (Nathan's
call, September 7, 2026 — solo maintainer, revisit if the contributor base
grows).

**Still open, outside what file changes can accomplish:**

- ~~The `VSCE_PAT` repo secret itself~~ ✅ **done September 8, 2026** — Azure
  DevOps PAT generated (Marketplace **Manage** scope, All accessible
  organizations) and added as a GitHub repo secret. `release.yml` can now
  complete the Marketplace-publish step on a real `vX.Y.Z` tag push; only
  Phase 8's screenshots/package-inspection blockers stand between here and an
  actual first release.
- ~~Branch protection rules on `main`~~ — **decided 2026-10-12**: rulesets
  restrict everyone _except_ repo admins, so trunk commits directly to `main`
  keep working while outside PRs need a passing `ci.yml` and a code-owner
  review. The settings are defined in `scripts/apply-github-guardrails.mjs`;
  most of them can only be applied once the repo is public (14.5).
- ~~`gh` CLI isn't installed in this dev environment yet~~ — installed and
  authenticated as of 2026-10-10 (`gh run list` / `gh release list` work).

---

## Phase 14 — Repo Visibility Flip (private → public)

`FuzzyNova/ctrlyoke` is **private today** (re-confirmed 2026-10-10 via `gh api repos/FuzzyNova/ctrlyoke`). Phase 7's public GitHub Issues, the
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

### 14.3-scan — Entropy-based scan (September 7, 2026) ✅ CLEAN

Ran both scanners from 14.1 over full history (no repo-portable binaries were
installed system-wide — both were downloaded standalone to a scratch dir and
run from there, per the "single binary, not a project dependency" note above):

- [x] **`gitleaks git . --redact`** — 3,272 commits / 52.55 MB scanned, **19
      matches, all confirmed false positives** by reading each flagged line at
      its commit: - 4 hits are `KEYGEN_ACCOUNT_ID` / `KEYGEN_PRO_POLICY_ID` in
      `src/license/LicenseService.ts` and `netlify/functions/ls-webhook.ts` —
      the same Keygen account/policy identifiers from 4.1, already decided
      safe-to-publish in 14.3 above (identifiers, not credentials). - 14 hits are literal fake-token fixtures (`abcdefghijk123`, `sk-1234567890abcdef`,
      `ghp_12345678901234567890`, `Bearer abcdefghijklmnopqrstuvwxyz123456`, …) inside
      the test suites that exist specifically to test the secret-redaction logic
      (`SecretRedactionMiddleware.test.ts`, `PreviewRedactor.test.ts`,
      `McpServerForm.test.ts`, `KeyValueMapEditor.test.tsx`, `outputUtils.test.ts`) —
      consistent with the PEM-fixture false positives already noted in 14.2. - 1 hit is a SHA-256 file-content hash (high-entropy, no credential shape) in
      `.bmad/_cfg/files-manifest.csv`, part of a since-removed third-party BMAD
      tooling install (`git log` shows it added then fully removed by
      `33105e4d7`; the path doesn't exist in `HEAD`).
- [x] **`trufflehog git file://. --results=verified`** — 78,802 chunks / 54.25 MB
      scanned: **0 verified secrets, 0 unverified secrets.**
- [x] **Re-scan, October 13, 2026** — Nathan re-ran both `gitleaks` and
      `trufflehog` over full history right before the flip decision: no issues
      found. That covers every commit made since the September 7 scan.
- [x] **Skim closed Issues/PRs and tags** — done manually by Nathan (September 7,
      2026); nothing found. No tool-assisted pass was possible in this
      environment (no `gh`/GitHub auth available), so this was a direct manual
      review.

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

- [x] MFA — passkey or TOTP, **not** SMS — on Keygen, Lemon Squeezy, Resend,
      Netlify, Cloudflare, GitHub, and Google Workspace. **Done September 7, 2026.** Also extended, on Nathan's own initiative, to the Microsoft/Azure
      DevOps account behind the Marketplace publish PAT (Phase 9) — not on the
      original list here, but it holds equivalent blast radius and got the same
      treatment. That account uses passwordless passkey sign-in (key held in
      1Password) rather than password+TOTP; passkey auth is phishing-resistant
      by design (bound to the real domain, unlike a password or TOTP code) and
      NIST/FIDO both treat platform-passkey sign-in as satisfying MFA, so this
      counts as done, not as a gap.
- [x] Confirm each vendor's account-recovery address is not guessable from the
      public docs. The Microsoft/Azure DevOps account's passkey-unavailable
      fallback (lost device) is "email a code to `admin@fuzzno.com`" — confirmed
      September 7, 2026 that `admin@fuzzno.com` is not a separate legacy inbox
      but the business admin address on the same Google Workspace (Fuzzy Nova,
      the DBA `ctrlyoke` ships under) that already hosts `support@ctrlyoke.dev`
      and the other `@ctrlyoke.dev` aliases covered by the Google Workspace MFA
      item above — same 2FA-enforced workspace, not a separate weak point. The
      recovery fallback is a standard email-a-code flow, not SMS or a guessable
      security question, so this closes the loop rather than reopening it.
- [ ] Prefer role addresses (`licensing@`, `billing@`) over the personal owner
      address in future checklist entries.

### 14.5 The flip, and what changes

Settings → General → Danger Zone → **Change repository visibility → Make
public**.

- [x] Final EULA is in `LICENSE.md` (Phase 7) — attorney sign-off landed September 7, 2026. The repo is
      forkable the instant it is public, and every fork inherits whatever license
      text is present at that moment, so this gate is what made the flip safe to schedule.
- [ ] Actions minutes become free and unlimited on standard runners (Phase 13).
- [ ] Existing Issues and PRs become world-readable — skim them for internal
      notes before flipping, not after.
- [ ] Immediately after: run `node scripts/apply-github-guardrails.mjs` and
      confirm every step prints `ok`. On the free plan these settings need a
      public repo, so the 2026-10-12 run while private applied only the
      read-only `GITHUB_TOKEN` default and **Dependabot alerts**. It applies:
  - the `main` ruleset: no force push or deletion; a PR with a passing
    `fast-checks` (`ci.yml`) and a code-owner review (`.github/CODEOWNERS`);
    repo admins bypass, so direct trunk pushes keep working;
  - the `release tags` ruleset: only admins create, move or delete `v*` tags,
    since `release.yml` publishes on any pushed `v*` tag;
  - approval required before workflows run for any outside contributor;
  - **Secret scanning + Push protection**. Push protection is the durable form
    of 14.1: it blocks the next accidental commit instead of catching it at
    the next audit;
  - private vulnerability reporting, so `SECURITY.md` reporters can also use
    GitHub's private advisory form.
- [ ] After the flip, open a throwaway PR from a fork (or another account) and
      confirm `fast-checks` runs after approval and is required.
- [ ] After the flip, upload the ctrlyoke social preview image (Settings →
      General → Social preview → Edit; 1280×640 PNG under 1 MB). GitHub hides
      this option on private repos. Repos have no avatar of their own, so this
      image is what a shared `FuzzyNova/ctrlyoke` link shows instead of the
      Fuzzy Nova org avatar.

---

## Pre-Release Compatibility Window — plans to consider landing before launch

**Added:** October 10, 2026, from a full audit of `dev/backlog/` and `dev/active/`.

None of these is a launch blocker the way Phase 8 is. Each is something that is cheap to change
while nobody depends on ctrlyoke's contracts, and expensive afterwards. Doing it after launch would
mean a compatibility shim, a migration of persisted state, or the same authored workflow behaving
differently after an upgrade. Plans whose remaining work is purely additive (new optional fields,
new step types, new settings, new harness IDs) are deliberately left out. Those can ship in any
later version at no compatibility cost.

> **The window is already partly closed.** `ctrlyoke@0.1.2` is public on npm, so the CLI's JSON
> result contract (Automation API v1) and the run-state format already have real users. Changes to
> those surfaces already need the `schemaVersion` coexistence handling. The workflow schema, settings
> schema, and VS Code extension behavior are still private until the Marketplace listing and repo go
> public.

### Recommended before launch

- [x] **Remote-access trial clock starts on dashboard open** — bug
      [`remote-access-trial-starts-on-dashboard-open.md`](../bugs/implemented/remote-access-trial-starts-on-dashboard-open.md)
      (gaps plan defect C12). Fixed in `213640ca7`: the trial now starts on the first remote client. It contradicts `LICENSE.md` §2(d), and every install that opens the
      dashboard persists a trial start time. After launch, those stored timestamps can't be told
      apart from real trial starts without a migration, so fix it before the first public install.
- [x] **Execution guardrails: uniform `-1` and structured stop reasons** —
      [`EXECUTION_GUARDRAILS_PLAN.md`](../implemented/EXECUTION_GUARDRAILS_PLAN.md).
  - `-1` behavior and timeout boundaries are documented; structured reasons now reach the
    persisted run state and dashboard, CLI, MCP, logs, and notifications. Dry-run output includes
    the effective global guardrails.
- [x] **Script verdict in `$previous`/`$step` output** —
      [`WORKFLOW_STEP_PLAN.md`](../backlog/WORKFLOW_STEP_PLAN.md) D12a.
  - **Done 2026-10-13.** `PriorContextItem.scriptVerdict` is resolved from the script step's own
    completed output (queue steps and script `finalStep` passes) and rendered by
    `buildPriorContextXmlFromItems` as a trailing `<verdict/>` element (outcome, compare source,
    operator, expected, and an exit-code actual). `$summary:` has since become a real selector
    prefix (`PRIOR_CONTEXT_DETAIL_PLAN.md` Phase 3), replacing the reserved-prefix warning.
    Documented in
    `docs/workflows/script-steps.md` and `context-files.md`.
  - **Cost if late:** it appends the script's pass/fail, `expected`, and `actual` to the prior-context
    rendering of _every_ script step, not only steps inside workflows. Landing it after launch
    changes the prompt text that existing authored workflows send to the harness after an upgrade.
    Nothing breaks, but outputs can shift.
  - **Minimum before launch:** land only `PriorContextItem.scriptVerdict` and its rendering in
    `buildPriorContextXmlFromItems`, independent of the workflow step type. The rest of the plan is
    additive. It also claims a new `$summary:` reference prefix. A literal collision in existing
    prompts is very unlikely, but reserving it in the parser now costs nothing.
- [x] **Prior context: one meaning on every machine** —
      [`PRIOR_CONTEXT_DETAIL_PLAN.md`](../implemented/PRIOR_CONTEXT_DETAIL_PLAN.md) Phases 0–3.
  - **Done 2026-10-13.** Structured prior output is deterministic, bounded, and selectable per
    reference or property. Timeline v2 preserves legacy reads, the dashboard offers Full / Summary,
    and the docs and built-in agent references describe the summary form.
  - **Cost if late:** `$previous` output currently depends on the
    `general.includeFullDiffsInPriorContext` setting of the machine that ran the earlier step, and
    it leaves out commands and tool calls. If `$previous` is changed to render from the timeline's
    events after launch, the prompt text of every existing authored workflow that uses prior
    context changes on upgrade, and so do the stored settings files that still carry the key.
  - **Decided 2026-10-13: Phases 0–3 before launch.**
    - Phase 0: stop condition-script output from being read as a step's own output
      ([bug](../bugs/implemented/prior-context-resolves-condition-output-as-step-output.md)).
    - Phase 1: render the full form from structured events and remove the setting.
    - Phase 2: delete the duplicated `CliOutput.response`; bump the timeline format to v2, the
      first exercise of the persisted-format bump path; close the Export Output gaps; add Copy
      Full Output.
    - Phase 3: `$summary:` and `priorContextDetail`.
- [x] **Docs: move content between pages before the URLs are indexed** —
      [`DOCUMENTATION_GAPS_PLAN.md`](../backlog/DOCUMENTATION_GAPS_PLAN.md).
  - **Done 2026-10-10.** Script steps, comparisons and script resolution moved to
    `workflows/script-steps.md`, and parallel groups to `workflows/parallel-steps.md`. The old
    headings stay behind as stubs with explicit IDs (`{#script-steps}`, `{#parallel-steps}`,
    `{#comparing-output}`, `{#how-scripts-run}`), so every existing anchor still resolves. Future
    moves follow the same convention (`.github/copilot-instructions.md`, "Docs URLs are
    permanent"), which removes the launch deadline for the remaining moves. The URL scheme
    `ctrlyoke.dev/docs/<section>/<page>` is locked. The docs pages were also missing the pre-launch
    `noindex` the landing pages had; they now share the `LAUNCHED` switch.
  - **Cost if late:** the plan's new pages are new paths, so they're safe any time. But moving
    sections out of `docs/workflows/yaml-format.md` or `end-conditions.md` breaks `#anchor` deep
    links once the README, Marketplace listing, and external posts link to them, and the README is
    frozen into each published VSIX.
  - **Minimum before launch:** do any section moves between existing pages now, or commit to not
    doing them. Also settle the `ctrlyoke.dev/docs/<section>/<page>` URL scheme
    ([`DOCUMENTATION_STRATEGY_PLAN.md`](DOCUMENTATION_STRATEGY_PLAN.md)). The README media work
    itself is already tracked in Phase 8.

### Worth a decision, low cost either way

- [x] **Template optional variables substitute to empty** —
      [`TEMPLATE_REQUIRED_VARIABLES_PLAN.md`](../implemented/TEMPLATE_REQUIRED_VARIABLES_PLAN.md) Phase 2.
      **Done 2026-10-13.** Every declared variable the caller leaves blank now substitutes to empty
      text instead of leaving a literal `{token}`; declared defaults still win. The same plan added
      `required: true` template variables (enforced in the New Workflow modal and in
      `TemplateManager.createWorkflow`) and the `feature-driven-loop` built-in template. Only Phase
      4 (a reserved `{workflowName}` token) is deferred, and it is additive.

### Reviewed and cleared (additive — no compatibility reason to rush)

`AWAITING_INPUT_NOTIFICATION`, `CLINE_INTEGRATION` (a new harness ID is a new enum value),
`COLORED_SCRIPT_OUTPUT` (opt-in; persisted output stays plain text), `COMMUNITY_TEMPLATES`
(optional `_templateMeta.author`/`tags`), `COMPUTED_VARIABLES` (`setVar` is new; `varsConfig` widens
from string to string-or-object), `CUSTOM_TOOLTIPS`, `HARNESS_SESSION_IMPORT` (provenance goes in
the run descriptor), `HISTORY_SEARCH_BACKGROUND_SCAN`, `LOCALIZATION` (command IDs and setting keys
stay the same; dashboard message payloads ship in lockstep with the extension),
`PROMPT_AUTHORING_SUGGESTIONS`, `QUICK_PICKER_IMPROVEMENTS`, `RUN_EXPORT` (ship _late_ rather than
early; the bundle format becomes a public contract once it exists), `RUN_VIEW_PAYLOAD_FOLLOWUPS`,
`SCHEMASTORE_CATALOG` (`$id` URLs are already final and live), `SCRIPT_GENERATED_STEPS` (the
reserved `item`/`itemIndex` names were narrowed to `forEach` workflows only, so existing workflows
can't start failing validation), `STANDALONE_THEME_SNAPSHOTS`, `TELEMETRY_FOLLOWUPS` (token counts
are already covered by `PRIVACY.md` §3.1), `TEST_SUITE_CPU_EFFICIENCY`, `USER_INPUT_STEP` (new step
type), `VISUAL_STUDIO_EXTENSION`, `VOICE_INPUT_AND_READ_ALOUD`, `VSCODE_LM_API_FEATURES`,
`VSCODE_LSP_MCP` (optional end-condition `kind`), `WORKFLOW_SCHEDULING` (optional field on the
already-versioned lineage descriptor).

---

## Summary Table

| Item                                                                       | Status                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extension packaging/build readiness                                        | DONE                  | Phase 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Website + docs                                                             | DONE                  | Phase 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Business/domain cutover (DNS, email, GitHub, Marketplace item reservation) | DONE                  | Phase 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Keygen product + Pro policy                                                | DONE                  | Phase 4.1 — renamed live this session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Keygen admin token custody confirmed                                       | DONE                  | Phase 4.2 — `fuzzynova-admin` in 1Password                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Keygen billing tier decision (Dev vs. paid)                                | DONE                  | Phase 4.3 — Dev 1 now, upgrade after first 2 sales                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Enterprise SKU (Keygen policy, LS product, webhook routing, legal docs)    | IN PROGRESS           | Phase 4.4 — Keygen policy, test-mode LS draft product, `ls-webhook.ts` routing/subscription-event code (deployed), and a full test-mode purchase + renewal + no-op-cancellation verification all done Sept 8, 2026; price $4,499/yr (revised from $5,999 → $5,000 for an LS price cap, then to $4,499 so the post-tax total stays under a $5,000 approval cutoff); legal docs (item 5) attorney-approved and live Sept 17, 2026; still open: machine-count abuse-detection webhook (item 4), live-checkout assent/renewal-notice setup (item 5), PO-fallback line (item 6), live-mode product copy; independent of Phases 6–12 |
| Lemon Squeezy store rebrand                                                | DONE                  | Phase 5.1 — done live this session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Lemon Squeezy product (ctrlyoke Pro, published)                            | DONE                  | Phase 5.1/5.3 — published August 26, 2026                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Lemon Squeezy identity verification                                        | DONE                  | Phase 5.1 — approved September 7, 2026                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Lemon Squeezy payout tax info                                              | DONE                  | Phase 5.1 — submitted August 25, 2026                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Netlify webhook function (deployed + smoke-tested)                         | DONE                  | Phase 5.3 — end-to-end test purchase verified August 26, 2026 (webhook 200 OK, Keygen license created, Resend email delivered)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Transactional email provider for key delivery                              | DONE                  | Phase 5.2 — Resend, verified working live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Live-mode LS webhook (separate from test-mode one)                         | OPEN                  | Phase 5.3 step 6 — create once Nathan flips Test mode off in the LS dashboard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`LicenseService` implementation**                                        | **DONE**              | Phase 6 — implementation, gate sites, trial, docs, and unlicensed free-path production review complete; QR scanning deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Attorney sign-off on final EULA                                            | DONE                  | Phase 7 — approved September 7, 2026                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| EU/EEA + UK Article 27 representatives (DataRep)                           | OPEN — SALES GATE     | Phase 7 — purchase the confirmed dual appointment before EU/EEA/UK sales or monitoring, publish the exact executed contact details in `PRIVACY.md`, and renew annually                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Screenshots + demo GIF                                                     | DONE                  | Phase 8 — README GIF and stills in 2026-10-12; verify in the Marketplace listing after publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Final `vsce ls` package inspection                                         | OPEN                  | Phase 8 — run right before publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Marketplace publish                                                        | OPEN — unblocked      | Phase 9 — `v0.1.2` already published by `release.yml` to the listing, which is still private/unpublished; making it public plus the post-publish checks remain, behind Phase 8 packaging/screenshots, not a legal or licensing gate anymore                                                                                                                                                                                                                                                                                                                                                                                    |
| GitHub release                                                             | AUTOMATED             | Phase 10 — `release.yml` created `v0.1.1`/`v0.1.2` Releases on the private repo; the public launch release follows the same path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CLI distribution (VSIX + npm)                                              | DONE (0.1.2 on npm)   | Phase 11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Post-launch branching + tag-driven release workflow                        | MOSTLY DONE           | Phase 13 — pre-push hook, full-suite/release workflows, docs, and the `VSCE_PAT` secret all done; first real tag push done (`v0.1.2` green 2026-09-25); `full-suite.yml` is green again (manual run 2026-10-13, after a failing streak from 2026-09-14)                                                                                                                                                                                                                                                                                                                                                                        |
| Repo visibility flip to public                                             | READY — Nathan's call | Phase 14 — every pre-flip gate (EULA, scan, Issues/PRs skim, MFA hardening) cleared Sept 7, 2026; the actual visibility toggle (14.5) is a deliberate action, not automated here                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Pre-release compatibility window                                           | DONE                  | Every item is landed, including the prior-context rework (`PRIOR_CONTEXT_DETAIL_PLAN.md` Phases 0–3) and blank optional template variables (`TEMPLATE_REQUIRED_VARIABLES_PLAN.md` Phase 2), both 2026-10-13. See the section above                                                                                                                                                                                                                                                                                                                                                                                             |
| Vendor-account MFA hardening                                               | DONE                  | Phase 14.4 — all 7 listed accounts plus Microsoft/Azure DevOps hardened; recovery-fallback chain confirmed to terminate in the 2FA-enforced Google Workspace, not a weak point                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## Related Documents

- [`RELEASE_PLAN.md`](../implemented/RELEASE_PLAN.md) — superseded; kept as historical record of extension-readiness work.
- [`CTRLYOKE_REBRAND_CUTOVER.md`](../implemented/CTRLYOKE_REBRAND_CUTOVER.md) — superseded for §6–7; kept as historical record of the domain/email/GitHub cutover.
- [`CTRLYOKE_REBRAND_PLAN.md`](../implemented/CTRLYOKE_REBRAND_PLAN.md) — the code rebrand (done).
- [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) — engineering design for `LicenseService`, gating philosophy, and the full purchase→license architecture.
- [`RELEASE_GUIDE.md`](../implemented/RELEASE_GUIDE.md) — generic `vsce` package/publish mechanics (FlightPath-branded, mechanics still accurate).
