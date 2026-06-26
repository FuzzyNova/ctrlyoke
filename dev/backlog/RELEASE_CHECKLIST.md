# FlightPath Release Checklist

**Created:** June 19, 2026
**Status:** IN PROGRESS — business identity, legal, and website are built; site deploy + testing is the next step.
**Last updated:** June 26, 2026
**Purpose:** top-level launch sequencing across product release, business identity, website, licensing, legal, and support.

---

## Progress Snapshot — June 26, 2026

_Handoff summary so a fresh session can pick up. Detail lives in the per-phase checklists below._

**Done**

- **Phase 0** — business identity, Google Workspace, all `@flightpath.dev` / `@fuzzno.com` inboxes (incl. `privacy@`, `licensing@`), vendor accounts, GitHub org/publisher.
- **Phase 1 + Phase 5 legal** — attorney-final EULA and Privacy Policy committed as **canonical repo files `LICENSE.md` + `PRIVACY.md`** (single source of truth; the backlog `*_FINAL.md` files are now pointers). `package.json` → `SEE LICENSE IN LICENSE.md`. Governing law Texas/Austin; binding arbitration + class-action waiver included.
- **Phase 2 website (built, not yet live)** — Astro site in `landing/`: home, `/pricing`, `/terms`, `/privacy`; VitePress docs merged at `/docs/` (with `docs/pro/index.md`, logo, Pro nav). The `/terms` and `/privacy` pages render the canonical root `LICENSE.md` / `PRIVACY.md` directly (no duplication).
- **Deploy pipeline** — GitHub Actions (`deploy.yml` prod + `deploy-preview.yml` + reusable `_netlify-deploy.yml`) driving `netlify-cli` (free-tier org repos can't use Netlify native builds). `npm run build:site` builds landing + merges docs. Legacy `docs-deploy.yml` (GitHub Pages) retired. Netlify site created; `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` repo secrets added.
- **Pre-launch mode** — single `LAUNCHED` flag in `landing/src/config.ts` gates disabled "Coming soon" CTAs, a pre-launch banner, and `noindex`. Flip to `true` at launch to reverse all three.

**➡️ Immediate next steps — site deploy & testing** (suggested starting point for the next session)

1. Point **`flightpath.dev` DNS** at Netlify (Domain management).
2. **Push to `main`** to trigger the first `deploy.yml` → `netlify deploy --prod`. Confirm the Action is green; if it fails, read the log (distinguish the build step from the deploy step).
3. **Test the live site**: `/`, `/pricing`, `/terms`, `/privacy`, `/docs/` (+ a few docs subpages) all load; the `/docs/` base and assets resolve.
4. **Verify pre-launch state on prod**: banner shows, `noindex` present, every Install/Buy CTA is a disabled "Coming soon" (no dead Marketplace/checkout links), CLI snippet hidden.
5. _Optional:_ push a throwaway branch to confirm `deploy-preview.yml` produces an alias preview URL.

**Not started**

- **Phase 3** licensing vendors (Keygen policy + public key, Lemon Squeezy product, webhook secret/admin token).
- **Phase 4** licensing implementation (`LicenseService`, offline/online activation, air-gapped import, 14-day trial, Pro gating).
- **Phase 6** launch verification (VSIX clean-install, activation, refund/chargeback) — depends on Phase 3–4.
- **Extension not yet published** to the VS Code Marketplace.

**Before go-live (small but required)**

- Set the **`[DATE]`** effective date in `LICENSE.md` and `PRIVACY.md`.
- Fill `CHECKOUT_URL` in `landing/src/config.ts` (Lemon Squeezy) and flip `LAUNCHED = true`.

---

## Decision Record

**Create the Fuzzy Nova / FlightPath business identity before vendor implementation.** Lemon Squeezy, Keygen, Netlify, GitHub organization ownership, support inboxes, receipt metadata, and legal pages should all be anchored to domain-owned business identities before licensing code is built.

**Recommended identity model:**

- **Legal / operating entity:** Fuzzy Nova
- **Product brand:** FlightPath
- **Business/admin domain:** `fuzzno.com`
- **Product/customer domain:** `flightpath.dev`
- **Business owner inbox:** `admin@fuzzno.com` or a named `@fuzzno.com` mailbox
- **Primary product support inbox:** `support@flightpath.dev`
- **GitHub organization / publisher target:** `fuzzynova/flightpath`
- **Customer-facing sender identity:** FlightPath, operated by Fuzzy Nova

Avoid using a personal email or shared consumer Gmail as the long-term owner for commercial infrastructure. A domain-based workspace keeps account ownership, support, billing, vendor receipts, and future team access clean.

---

## Phase 0 — Business Email & Account Ownership

### 0.1 Email Workspace

- [x] Create one Google Workspace for the business identity (recommended: Google Workspace Business Starter).
- [x] Use `fuzzno.com` as the primary Workspace/business domain if Fuzzy Nova is the durable operating identity.
- [x] Add `flightpath.dev` to the same Workspace as a secondary domain or user alias domain for the product brand.
  - Google Workspace supports adding domains you own to one account. Use a **user alias domain** when the same people need addresses at both domains; use a **secondary domain** when the domains represent separate teams/users.
  - Recommended here: `fuzzno.com` as the primary/admin domain and `flightpath.dev` as the product domain, likely secondary if product groups like `support@flightpath.dev` should be managed distinctly.
- [x] Create one real business admin mailbox, such as `admin@fuzzno.com` or the founder's named `@fuzzno.com` address.
- [x] Add Fuzzy Nova business aliases / groups:
  - [x] `hello@fuzzno.com` — general business contact
  - `admin@fuzzno.com` — real mailbox (not a group); already created as the workspace owner
  - ~~`billing@fuzzno.com`~~ — not needed; Fuzzy Nova has no product customers and vendor receipts go to the admin inbox
- [x] Add FlightPath product group aliases / collaborative inboxes:
  - [x] `support@flightpath.dev` — customer support, Pro support, marketplace contact
  - [x] `billing@flightpath.dev` — product payment/customer billing notices
  - [x] `security@flightpath.dev` — vulnerability/security contact
  - [x] `sales@flightpath.dev` — enterprise invoice, PO, and MSA fallback
  - [x] `privacy@flightpath.dev` — privacy policy contact; DSAR / data access & deletion requests
  - [x] `licensing@flightpath.dev` — EULA licensing contact (§16(f)); enterprise/threshold and license-key inquiries
- [x] Route each group to the admin mailbox initially; add future collaborators as members instead of sharing one password.
- [x] Configure SPF, DKIM, and DMARC for both `fuzzno.com` and `flightpath.dev`.
- ~~Decide whether `hello@flightpath.dev` or `team@flightpath.dev` should exist for general contact.~~ — not needed; `support@` and `sales@` cover all inbound contact.

### 0.2 Vendor Account Ownership

Use the domain email identity for every vendor account created or migrated for launch:

- [x] Netlify account / site ownership for `flightpath.dev` owned by a Fuzzy Nova admin mailbox
- [x] Lemon Squeezy store owner/admin email under `fuzzno.com`; public support email under `flightpath.dev`
- [x] Keygen account owner/admin email under `fuzzno.com`; customer/license support under `flightpath.dev`
- [x] VS Code Marketplace publisher contact
- [x] GitHub organization ownership / billing
- [x] Domain registrar and DNS access
- ~~[ ] Future support desk account, if adopted (Plain, Pylon, Help Scout, etc.)~~ — skipped; not needed for launch

### 0.3 GitHub / Publisher Identity

- [x] Confirm the target GitHub organization is `fuzzynova`.
- [x] Move or mirror the repository to `fuzzynova/flightpath` before public launch if that is the long-term canonical location.
- [x] Confirm VS Code Marketplace publisher branding matches the long-term business/product identity.
- [x] Update README, docs, and marketplace copy to use `flightpath.dev` and `support@flightpath.dev`.

---

## Phase 1 — Release Foundation

- [x] Confirm package metadata, extension display name, repository URL, icon, categories, and marketplace publisher. (`fuzzynova`, `FuzzyNova/flightpath`, `flightpath.dev`)
- [x] Confirm the existing release checklist in [`RELEASE_PLAN.md`](RELEASE_PLAN.md). (Updated June 25 — stale `nhickster` references and resolved items corrected.)
- [x] Confirm all pre-release launch blockers in [`ROADMAP.md`](ROADMAP.md). (Two strategic blockers: landing page (Phase 2) and Pro licensing (Phase 3–4).)
- [x] Decide whether the public repo remains source-available under the custom commercial EULA before the first commercial launch. **Decision: yes — source-available under custom EULA.**
- [x] Replace the placeholder license after legal review. **Done** — attorney-final EULA is now canonical `LICENSE.md` (placeholder Elastic `LICENSE` removed); `package.json` set to `SEE LICENSE IN LICENSE.md`. Set the `[DATE]` effective date before go-live.

---

## Phase 2 — Website & Docs

Tracked in detail by [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md).

- [x] Build `flightpath.dev` landing page (Astro, `landing/`).
- [x] Build `/pricing/` with Free vs Pro, trial, and checkout copy (checkout disabled pre-launch via `LAUNCHED`).
- [x] Publish docs under `/docs/` (VitePress merged into the landing build; base `/docs/`).
- [x] Add `/terms` and `/privacy` pages (render canonical `LICENSE.md` / `PRIVACY.md`). `/trust` deferred to Phase 5.
- [x] Add `docs/pro/index.md` with activation and "Who needs a license?" guidance.
- [x] Make `support@flightpath.dev` the visible support path on the site/docs (README/marketplace tracked in Phase 0.3).

**Deploy & infra (built; deploy + test pending):**

- [x] GitHub Actions → Netlify CLI deploy workflows (`deploy.yml`, `deploy-preview.yml`, `_netlify-deploy.yml`); `npm run build:site`; `docs-deploy.yml` retired; `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` secrets added.
- [x] Pre-launch mode — `LAUNCHED` flag (disabled CTAs, banner, `noindex`).
- [ ] **Point `flightpath.dev` DNS to Netlify.**
- [ ] **Push to `main`; confirm the first production deploy is green.**
- [ ] **Test the live site** — all routes load and the pre-launch state (banner, `noindex`, disabled CTAs) is verified on prod.

---

## Phase 3 — Licensing Vendors

Tracked in detail by [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md).

- [ ] Create Keygen account under the FlightPath domain identity.
- [ ] Create Keygen Pro policy: perpetual Pro, Ed25519 signed license files, encrypted files if selected, 10-machine limit.
- [ ] Record the Keygen account public key for extension-side verification.
- [ ] Create Lemon Squeezy store / product for FlightPath Pro under the FlightPath domain identity.
- [ ] Configure Lemon Squeezy support, receipt, and seller-facing metadata.
- [ ] Create Netlify webhook secret and Keygen admin token as server-only environment variables.
- [ ] Decide key delivery path: Lemon Squeezy custom fulfillment vs. transactional email from the Netlify function.

---

## Phase 4 — Licensing Implementation

Tracked in detail by [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md).

- [ ] Add `LicenseService` interface and entitlement model.
- [ ] Implement offline signed-license verification.
- [ ] Implement online activation, signed file caching, refresh, and deactivation.
- [ ] Implement air-gapped license import.
- [ ] Implement 14-day remote-access trial.
- [ ] Gate Pro capabilities by feature/reach, not usage limits.
- [ ] Add upsell surfaces linking to `flightpath.dev/pricing/`.
- [ ] Add production verification for the unlicensed/free path.

---

## Phase 5 — Legal & Support

- [x] Engage an attorney for the custom commercial EULA. **Done** — EULA + Privacy Policy returned final.
- [x] Publish canonical repo license text in `LICENSE.md` (placeholder `LICENSE` removed).
- [x] Set `package.json` license to `SEE LICENSE IN LICENSE.md`.
- [ ] Publish web terms at `flightpath.dev/terms` — **page built; goes live on first deploy.** Set `[DATE]` first.
- [ ] Publish privacy policy before collecting analytics, telemetry, support data, or purchase metadata — **page built (`/privacy`); goes live on first deploy.** Set `[DATE]` first.
- [ ] Publish a standard DPA and trust/security page (`/trust`) before pushing enterprise self-serve.
- [ ] Keep public GitHub Issues for community reports.
- [ ] Keep `support@flightpath.dev` private for Pro / Enterprise customer support.

---

## Phase 6 — Launch Verification

- [ ] Clean install of the VSIX with no license: all free functionality works.
- [ ] Remote dashboard trial works for a fresh install.
- [ ] Trial expiry falls back to localhost dashboard without breaking workflows.
- [ ] Pro activation unlocks remote dashboard and other Pro features immediately.
- [ ] Air-gapped license file import unlocks Pro with no network call.
- [ ] Lemon Squeezy order creates exactly one Keygen license on webhook retry.
- [ ] Refund / chargeback path suspends or revokes the matching Keygen license.
- [ ] Pricing page checkout link points to production Lemon Squeezy product.
- [ ] README, docs, marketplace listing, and website all agree on support address, license terms, and pricing.

---

## Related Plans

- [`RELEASE_PLAN.md`](RELEASE_PLAN.md) — extension release and marketplace readiness
- [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md) — website, docs, pricing page, Netlify deployment
- [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) — Lemon Squeezy, Keygen, license service, Pro gating
- [`ROADMAP.md`](ROADMAP.md) — launch blockers and long-term roadmap
