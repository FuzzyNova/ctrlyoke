# ctrlyoke Rebrand — External / Business Cutover

**Created:** June 30, 2026
**Status:** 🟡 Not started — this is the external/business "Part 3" of the rebrand. The **code rebrand is complete** (see [`CTRLYOKE_REBRAND_PLAN.md`](CTRLYOKE_REBRAND_PLAN.md) Execution Status, incl. docs/landing/legal prose now swapped to `ctrlyoke`).
**Owner:** Nathan (manual, external dashboards — not code changes)
**Purpose:** the single forward-looking checklist for moving the live business identity from `flightpath.dev` → `ctrlyoke.dev`, all instructions pointed at **ctrlyoke**.

> **Why a separate doc?** [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) records launch work genuinely **done under the `flightpath.dev` identity** (Phase 0–2). Rather than rewrite that history to falsely read "ctrlyoke", this doc supersedes its still-pending external items and re-points them at the new brand. Where an item was already completed under FlightPath, it's listed here as a **migrate** task; where it never existed, it's a **create-fresh-under-ctrlyoke** task.

---

## Migrate vs. create-fresh — at a glance

| Area                      | Prior state (FlightPath)             | This cutover                                                                             |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Domain + DNS (Cloudflare) | `flightpath.dev` live, DNS → Netlify | **Migrate** — stand up `ctrlyoke.dev`, 301 old → new                                     |
| Netlify site              | hosting `flightpath.dev`             | **Migrate** — repoint primary domain to `ctrlyoke.dev`                                   |
| Google Workspace inboxes  | 6 product inboxes `@flightpath.dev`  | **Migrate** — rename to `@ctrlyoke.dev`, clean break (no traffic ever hit old addresses) |
| GitHub repo               | `FuzzyNova/flightpath`               | **Migrate** — rename to `FuzzyNova/ctrlyoke`                                             |
| VS Code Marketplace       | not yet published                    | **Create fresh** — publish `fuzzynova.ctrlyoke`                                          |
| Lemon Squeezy             | **never created**                    | **Create fresh** under ctrlyoke                                                          |
| Keygen                    | **never created**                    | **Create fresh** under ctrlyoke                                                          |

> **Decisions carried over from the rebrand plan:** keep `flightpath.dev` as a **permanent 301 redirect** (web traffic/SEO). Email inboxes are a **clean break, no forwarders** — pre-release, zero customers, nothing has ever hit the `@flightpath.dev` inboxes, so there's no one to catch. Publisher stays **`fuzzynova`** (studio identity, unaffected).

---

## 1. Domain & DNS — Cloudflare

- [x] Confirm `ctrlyoke.dev` is registered and in the Cloudflare account (per the rebrand plan it + `controlyoke.*` and `.com` are owned and TM-cleared).
- [x] Add `ctrlyoke.dev` to Cloudflare DNS; create the records Netlify requires for the apex + `www` (see §2 — Netlify will give you the target).
- [x] Decide the redirect strategy and keep it **permanent**:
  - `flightpath.dev` → `ctrlyoke.dev` **301** (preserve old links / SEO).
  - `controlyoke.dev` / `controlyoke.com` / `ctrlyoke.com` → **301 → `ctrlyoke.dev`** (canonical).
- [x] Verify DNS propagation before flipping anything customer-facing (apex + `www` + any `mail`/MX records for §3).

## 2. Netlify

- [x] **Cloudflare DNS first** (Netlify can't be set primary until DNS resolves):
  - [x] In the Cloudflare zone for `ctrlyoke.dev`, add a record: Type **CNAME**, Name **`@`** (apex), Target **`apex-loadbalancer.netlify.com`**, Proxy status **DNS only** (grey cloud — do **not** proxy; Cloudflare's orange-cloud proxy blocks Netlify's SSL validation/provisioning for the domain). Cloudflare auto-flattens CNAME-at-apex records, so a plain CNAME here works even though the record is at the root — no separate "ALIAS"/"ANAME" record type needed.
  - [x] Add a second record for `www`: Type **CNAME**, Name **`www`**, Target `<your-site>.netlify.app` (or `apex-loadbalancer.netlify.com`), Proxy status **DNS only**.
  - [x] Wait for propagation (`dig ctrlyoke.dev` / `dig www.ctrlyoke.dev` should resolve).
- [x] **Netlify — add + promote the domain**, on the **existing** site (the one behind the `NETLIFY_SITE_ID` repo secret — `deploy.yml` already calls it "the ctrlyoke.dev Netlify site"):
  - [x] Site settings → Domain management → **Add domain alias** (this is the same "add domain" action; it's just labeled "alias" because a primary domain — `flightpath.dev` — already exists) → enter `ctrlyoke.dev` → save.
  - [x] Once the Cloudflare CNAME above has propagated and Netlify shows the domain as verified/DNS-configured, use that domain row's **Options menu → "Set as primary domain"** to promote `ctrlyoke.dev`. This automatically demotes `flightpath.dev` to a non-primary alias.
- [x] Provision/verify the Netlify-managed TLS cert for `ctrlyoke.dev` (+ `www`) — Site settings → Domain management → HTTPS section; click "Renew certificate" if it doesn't auto-provision within a few minutes of the domain verifying.
- [x] Decide where the `flightpath.dev` → `ctrlyoke.dev` 301 lives (pick **one** place — don't double-redirect):
  - **Option A (chosen):** Remove `flightpath.dev` from Netlify's domain list entirely (Options → Remove domain), then in Cloudflare create a **Redirect Rule** (Rules → Redirect Rules) matching `flightpath.dev/*` → dynamic redirect to `https://ctrlyoke.dev/${1}`, status 301, preserve query string. The zone's DNS record for `flightpath.dev` just needs to resolve to anything Cloudflare-proxied (orange cloud) so the rule can intercept — a dummy proxied `A` record (e.g. `192.0.2.1`) is fine.
  - Option B (not chosen): keep `flightpath.dev` attached to Netlify as a domain alias and let Netlify serve the redirect.
- [x] Confirm `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` secrets are still valid; trigger a prod deploy and confirm `https://ctrlyoke.dev` + `/docs/` + `/pricing` + `/terms` + `/privacy` all load with the new branding and the new favicon/logo.

## 3. Google Workspace — product email

- [x] Add `ctrlyoke.dev` to the existing Workspace (secondary domain or alias domain, mirroring how `flightpath.dev` was added). Verify domain ownership.
- [x] Configure **SPF, DKIM, DMARC** for `ctrlyoke.dev`.
- [x] Rename the 6 existing product groups/inboxes from `@flightpath.dev` to `@ctrlyoke.dev` in place (edit email address + name/description on each group), routed to the admin mailbox:
  - [x] `support@ctrlyoke.dev`
  - [x] `billing@ctrlyoke.dev`
  - [x] `security@ctrlyoke.dev`
  - [x] `sales@ctrlyoke.dev`
  - [x] `privacy@ctrlyoke.dev`
  - [x] `licensing@ctrlyoke.dev`
- [x] Clean break — no `@flightpath.dev` forwarders/aliases kept. Nothing has ever hit these inboxes, so there's no overlap window needed.
- [ ] Studio inboxes `admin@`/`hello@fuzzno.com` are **unaffected** — do not touch.
- [ ] These addresses are already referenced in the shipped `LICENSE.md` / `PRIVACY.md` and the site footer (all now `@ctrlyoke.dev`), so the inboxes must exist before/at launch.

## 4. GitHub repository

- [x] Rename `FuzzyNova/flightpath` → `FuzzyNova/ctrlyoke` (GitHub auto-redirects the old URLs).
- [x] `package.json` `repository`/`homepage`/`bugs` and docs/landing links already point at `FuzzyNova/ctrlyoke` + `ctrlyoke.dev` — **they 404 until this rename + the domain go live.** No code change needed after; just verify they resolve.
- [x] Sanity-check `.vscode/launch.json` `--disable-extension=...` id against your actually-installed extension id (was a flagged loose end in the rebrand plan).

## 5. VS Code Marketplace

- [x] Publish the extension as **`fuzzynova.ctrlyoke`** (driven by `package.json` `name`, already set). Publisher `fuzzynova` is unchanged. Published then immediately unpublished (no "Unlist" option was available) — the `publisher.name` identifier is permanently reserved to `fuzzynova` regardless of unpublish state.
- [x] `MARKETPLACE_URL` in `landing/src/config.ts` already points at `fuzzynova.ctrlyoke` — the listing link goes live when the item is published.
- [x] Confirm marketplace publisher contact / branding reads ctrlyoke.

## 6. Lemon Squeezy — create fresh under ctrlyoke

> Never existed under FlightPath — create directly under the ctrlyoke identity (no migration).

- [ ] Create the Lemon Squeezy store/product for **ctrlyoke Pro**; store owner/admin under `@fuzzno.com`, public support under `support@ctrlyoke.dev`.
- [ ] Configure support, receipt, and seller-facing metadata to read **ctrlyoke**.
- [ ] Create the Netlify webhook secret (server-only env var) for order fulfillment.
- [ ] After the product exists, set `CHECKOUT_URL` in `landing/src/config.ts` (currently `"#"`).

## 7. Keygen — create fresh under ctrlyoke

> Never existed under FlightPath — create directly under the ctrlyoke identity (no migration).

- [ ] Create the Keygen account under the ctrlyoke domain identity (owner under `@fuzzno.com`, license support under `@ctrlyoke.dev`).
- [ ] Create the Keygen Pro policy (perpetual Pro, Ed25519 signed license files, machine limit per `PRO_LICENSE_PLAN.md`).
- [ ] Record the Keygen account **public key** for extension-side verification; create the admin token as a server-only env var.

## 8. Code follow-ups gated on the above

These are small repo edits to make **once** the external pieces are live:

- [ ] Set the real `[DATE]` effective date in `LICENSE.md` + `PRIVACY.md` (still a placeholder; the live `/terms` + `/privacy` serve it).
- [ ] Set `CHECKOUT_URL` in `landing/src/config.ts` (§6).
- [ ] Flip `LAUNCHED = true` in `landing/src/config.ts` (restores CTAs, drops the pre-launch banner, allows indexing) — only at actual go-live.

---

## Relationship to the rest of the backlog

- [`CTRLYOKE_REBRAND_PLAN.md`](CTRLYOKE_REBRAND_PLAN.md) — the full rename plan; §10 + §11.5 are the origin of this cutover list. Code side is done.
- [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) — original launch checklist (FlightPath-era). Phase 0–2 done under `flightpath.dev`; Phase 3–6 vendor/licensing/verification items are **superseded by this doc** for naming, and remain valid for the underlying work (`PRO_LICENSE_PLAN.md`).
- [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) — Lemon Squeezy + Keygen + LicenseService detail (the "how"; this doc is the "do it under ctrlyoke" gate).
