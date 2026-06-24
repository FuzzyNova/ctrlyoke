# FlightPath Release Checklist

**Created:** June 19, 2026
**Status:** PLANNING
**Purpose:** top-level launch sequencing across product release, business identity, website, licensing, legal, and support.

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
- [x] Route each group to the admin mailbox initially; add future collaborators as members instead of sharing one password.
- [x] Configure SPF, DKIM, and DMARC for both `fuzzno.com` and `flightpath.dev`.
- ~~Decide whether `hello@flightpath.dev` or `team@flightpath.dev` should exist for general contact.~~ — not needed; `support@` and `sales@` cover all inbound contact.

### 0.2 Vendor Account Ownership

Use the domain email identity for every vendor account created or migrated for launch:

- [x] Netlify account / site ownership for `flightpath.dev` owned by a Fuzzy Nova admin mailbox
- [x] Lemon Squeezy store owner/admin email under `fuzzno.com`; public support email under `flightpath.dev`
- [ ] Keygen account owner/admin email under `fuzzno.com`; customer/license support under `flightpath.dev`
- [ ] VS Code Marketplace publisher contact
- [ ] GitHub organization ownership / billing
- [ ] Domain registrar and DNS access
- [ ] Future support desk account, if adopted (Plain, Pylon, Help Scout, etc.)

### 0.3 GitHub / Publisher Identity

- [ ] Confirm the target GitHub organization is `fuzzynova`.
- [ ] Move or mirror the repository to `fuzzynova/flightpath` before public launch if that is the long-term canonical location.
- [ ] Confirm VS Code Marketplace publisher branding matches the long-term business/product identity.
- [ ] Update README, docs, and marketplace copy to use `flightpath.dev` and `support@flightpath.dev`.

---

## Phase 1 — Release Foundation

- [ ] Confirm package metadata, extension display name, repository URL, icon, categories, and marketplace publisher.
- [ ] Confirm the existing release checklist in [`RELEASE_PLAN.md`](RELEASE_PLAN.md).
- [ ] Confirm all pre-release launch blockers in [`ROADMAP.md`](ROADMAP.md).
- [ ] Decide whether the public repo remains source-available under the custom commercial EULA before the first commercial launch.
- [ ] Replace the placeholder license only after legal review, as tracked in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md).

---

## Phase 2 — Website & Docs

Tracked in detail by [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md).

- [ ] Build `flightpath.dev` landing page.
- [ ] Build `/pricing/` with Free vs Pro, trial, and checkout copy.
- [ ] Publish docs under `/docs/`.
- [ ] Add `/terms`, `/privacy`, and later `/trust` pages.
- [ ] Add `docs/pro/index.md` with activation and "Who needs a license?" guidance.
- [ ] Make `support@flightpath.dev` the visible support path on site, docs, README, and marketplace.

---

## Phase 3 — Licensing Vendors

Tracked in detail by [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md).

- [ ] Create Keygen account under the FlightPath domain identity.
- [ ] Create Keygen Pro policy: perpetual Pro, Ed25519 signed license files, encrypted files if selected, 3-machine limit.
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

- [ ] Engage an attorney for the custom commercial EULA.
- [ ] Publish canonical repo license text in `LICENSE` / `LICENSE.md`.
- [ ] Set `package.json` license to `SEE LICENSE IN LICENSE.md`.
- [ ] Publish web terms at `flightpath.dev/terms`.
- [ ] Publish privacy policy before collecting analytics, telemetry, support data, or purchase metadata.
- [ ] Publish a standard DPA and trust/security page before pushing enterprise self-serve.
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
