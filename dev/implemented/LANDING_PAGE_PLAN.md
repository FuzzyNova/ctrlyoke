# ctrlyoke Landing Page Plan

**Created:** May 21, 2026  
**Status:** IMPLEMENTED (verified October 10, 2026). The site, docs, deploy pipeline, DNS, production deploys, legal/Enterprise pages, and `ls-webhook` function have all shipped: `20b465d83` (landing foundation), `bd63c0faf` (VitePress merged at `/docs/`), `83e9c8c5d` (Netlify deploy workflows; GitHub Pages retired), `04b0e8131` (`ls-webhook`), `280128371` (DPA/Enterprise Terms/Trust pages). Two launch-day switches remain, flipping `LAUNCHED` and setting `CHECKOUT_URL`; both are owned by [`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 9. A `/changelog/` page is deferred to post-launch.  
**Domain:** ctrlyoke.dev (purchased, hosted on Netlify)
**Launch dependency:** business email, support inboxes, vendor account ownership, and publisher identity are tracked in [`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) (Phase 3, done).

> **2026-10-10 audit:** Checked against the repo and the live site. `https://ctrlyoke.dev/`, `/docs/`, and `/pricing/` return 200, and recent `deploy.yml` runs on `main` are green. `netlify/functions/ls-webhook.ts` exists. `LICENSE.md` and `PRIVACY.md` have no `[DATE]` placeholders. `docs/guide/installation.md` documents `npm install -g ctrlyoke`. Those checklist items are now ticked. `/changelog/` returns 404 and `docs/changelog.md` does not exist, so the changelog page moves to post-launch. The pricing section now matches the shipped page: 6 harnesses (not 7), plus an Enterprise tier and the refund FAQ. `TELEMETRY_PLAN.md` now lives in `dev/implemented/`.

---

## Overview

This document covers everything needed to ship `ctrlyoke.dev`: the marketing landing page, the published VitePress docs, and the pricing page. The goal at release is a single perpetual license SKU that unlocks power-user features, with a clean free tier that still delivers real value.

> **Scope note:** The **Pro licensing model** (provider choice, the extension `LicenseService`, entitlement verification, activation flow, tier gating, and the license-key-vs-accounts decision) used to live here in Phase 5. It has been **split out into [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md)**. This document now owns only the **website surface** (marketing page, docs, pricing page, checkout link). The chosen direction is: pasted license key at launch, user accounts/sign-in as a later UX layer — see the Decision Record in `PRO_LICENSE_PLAN.md`.

---

## Implementation Status — June 26, 2026

The plan below is largely **implemented**. What exists in the repo today:

- **Architecture:** Option B (monorepo) — `landing/` Astro 5 + Tailwind (+ `@tailwindcss/typography`), `output: "static"`.
- **Pages** (`landing/src/pages/`): `index.astro` (hero, YAML snippet, harness grid, features, how-it-works, Pro callout, install CTA), `pricing.astro` (Free vs Pro + FAQ), `terms.astro` + `privacy.astro` (render the **canonical root `LICENSE.md` / `PRIVACY.md`** directly — single source of truth), shared `layouts/Layout.astro`.
- **Pre-launch mode:** single `LAUNCHED` flag in `landing/src/config.ts` + `components/Cta.astro` → Install/Buy CTAs render as disabled "Coming soon", a pre-launch banner shows, and the site is `noindex`. Flip `LAUNCHED` to `true` at launch (and set `CHECKOUT_URL`) to reverse all of it.
- **Docs:** VitePress `base: '/docs/'` (default), logo at `docs/public/ctrlyoke-icon.svg`, `docs/pro/index.md` (+ Pro nav/sidebar). Merged into the landing output by `scripts/merge-docs-into-landing.mjs`.
- **Build:** root scripts `build:site` → `build:landing` → `build:docs` (order matters; see §2.3); `netlify.toml` updated.
- **Deploy:** `.github/workflows/{deploy,deploy-preview,_netlify-deploy}.yml` (GitHub Actions + `netlify-cli`); legacy `docs-deploy.yml` retired. Netlify site created; `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` secrets added.

**Done since (verified 2026-10-10):** DNS points at Netlify, with DNS in Cloudflare. Production deploys run green. Live routes respond. The `ls-webhook` Netlify Function is deployed. `[DATE]` is set in the legal docs. Enterprise legal pages `dpa.astro`, `enterprise-terms.astro`, and `trust.astro` were added, plus `license/offline.astro`. **Still pending:** flip `LAUNCHED` and set `CHECKOUT_URL` at launch (RELEASE_CHECKLIST Phase 9). The `/changelog/` page is deferred to post-launch.

---

## Phase 1 — Site Architecture

### 1.1 URL Structure

All content lives on one domain (better SEO, simpler Netlify config):

| URL                       | Content                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `ctrlyoke.dev/`           | Marketing landing page (Astro)                                            |
| `ctrlyoke.dev/docs/`      | VitePress docs (built separately, merged)                                 |
| `ctrlyoke.dev/pricing/`   | Pro licensing page                                                        |
| `ctrlyoke.dev/changelog/` | CHANGELOG surfaced on the web (can be auto-generated from `CHANGELOG.md`) |

### 1.2 Repository Structure

Create a new repo (or monorepo subfolder `landing/`) for the Astro site. The existing `docs/` VitePress site builds separately and its output is merged into the Astro dist at deploy time.

Option A — **Separate repo**: `ctrlyoke-landing` → deploys to `ctrlyoke.dev`  
Option B — **Monorepo**: add `landing/` alongside `docs/` in this repo, with one Netlify site

**Recommendation: Option B (monorepo).** Keeps the docs and landing page in sync with extension releases. One repo, one Netlify deploy, one CI pipeline. **✅ Implemented — `landing/` lives in this repo.**

---

## Phase 2 — Framework: Astro

**Choice: Astro** (over Next.js / Nuxt / plain VitePress)

**Reasons:**

- Zero-JS by default — perfect Core Web Vitals for a marketing page
- First-class Tailwind CSS support (already used in the webview)
- Vue island support — can reuse any Vue components from the webview if needed
- Netlify adapter with one-command deploy
- VitePress output can be dropped into `public/docs/` or merged via `netlify.toml`

### 2.1 Setup

```bash
# From repo root
npm create astro@latest landing -- --template minimal --typescript strict
cd landing
npx astro add tailwind
npx astro add netlify
```

### 2.2 Netlify Config

```toml
# netlify.toml (repo root)
[build]
  command = "npm run build:docs && npm run build:landing"
  publish = "landing/dist"

[[redirects]]
  from = "/docs/*"
  to = "/docs/:splat"
  status = 200
```

**Build script in `package.json`:**

```json
"build:landing": "cd landing && astro build",
"build:docs": "cd docs && vitepress build && cp -r .vitepress/dist ../landing/dist/docs"
```

### 2.3 Deploy via GitHub Actions (Netlify CLI)

**Why Actions and not Netlify's native Git integration:** free-tier Netlify does **not** offer native auto-build/deploy for **organization-owned** repos (`FuzzyNova/ctrlyoke`) — that is gated behind a paid Netlify plan. So, exactly like the `FuzzyNova/fuzzno` site, we deploy from CI using the Netlify CLI with a personal `NETLIFY_AUTH_TOKEN` and the site's `NETLIFY_SITE_ID`. This mirrors fuzzno's proven three-file pattern, with two monorepo adaptations: **(1)** a build step (Astro + VitePress), and **(2)** `paths:` filters so routine extension commits don't redeploy the site.

> **No Astro Netlify adapter.** Because we ship a static marketing site and deploy the built `landing/dist` via the Netlify CLI, **skip `npx astro add netlify`** — that adapter is for SSR / native Netlify builds. Astro's default static output is what we deploy.

> **Build order matters.** Run `build:landing` **before** `build:docs`: `astro build` cleans `landing/dist`, and `build:docs` copies VitePress output into `landing/dist/docs`, so docs must be copied _after_ the Astro build. Fix the Phase 2.2 ordering to `build:landing && build:docs` (the current `build:docs && build:landing` would let Astro wipe the copied docs).

Three files under `.github/workflows/`:

**`_netlify-deploy.yml`** (reusable build + deploy):

```yaml
name: Netlify Deploy (Reusable)

on:
  workflow_call:
    inputs:
      deploy-args:
        description: "Extra args passed to netlify deploy (e.g. --prod or --alias=branch-name)"
        required: true
        type: string
    secrets:
      NETLIFY_AUTH_TOKEN:
        required: true
      NETLIFY_SITE_ID:
        required: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build landing + docs (landing first — see build-order note)
        run: npm run build:landing && npm run build:docs

      - name: Deploy to Netlify
        run: npx netlify-cli@latest deploy --dir=landing/dist ${{ inputs.deploy-args }}
        env:
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
```

**`deploy.yml`** (production on `main`, path-filtered):

```yaml
name: Deploy Site to Netlify

on:
  push:
    branches: [main]
    paths:
      - "landing/**"
      - "docs/**"
      - "netlify.toml"
      - ".github/workflows/deploy.yml"
      - ".github/workflows/deploy-preview.yml"
      - ".github/workflows/_netlify-deploy.yml"

jobs:
  deploy:
    uses: ./.github/workflows/_netlify-deploy.yml
    with:
      deploy-args: --prod
    secrets:
      NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
```

**`deploy-preview.yml`** (per-branch preview URLs, path-filtered):

```yaml
name: Deploy Site Preview to Netlify

on:
  push:
    branches-ignore: [main]
    paths:
      - "landing/**"
      - "docs/**"
      - "netlify.toml"
      - ".github/workflows/_netlify-deploy.yml"

jobs:
  deploy-preview:
    uses: ./.github/workflows/_netlify-deploy.yml
    with:
      deploy-args: --alias=${{ github.ref_name }}
    secrets:
      NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
```

**Repo secrets to add** (ctrlyoke repo → Settings → Secrets): `NETLIFY_AUTH_TOKEN` (personal access token) and `NETLIFY_SITE_ID` (the **ctrlyoke.dev** Netlify site's API ID — a distinct site/token from fuzzno's).

This trio **replaces** the legacy `.github/workflows/docs-deploy.yml` (which pushed VitePress to GitHub Pages at base `/ctrlyoke/`); delete it once the new site deploy is green.

---

## Phase 3 — Landing Page Content

### 3.1 Sections (in order)

| Section                   | Purpose                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Hero**                  | Headline + subhead + primary CTA ("Install for VS Code" → marketplace link)                                       |
| **Problem / Solution**    | 1-sentence pitch: "AI coding assistants are powerful but manual. ctrlyoke turns them into automated workflows."   |
| **Key Features**          | 4–6 cards: multi-harness support, YAML workflows, end conditions, session resumption, MCP integration, CLI binary |
| **Harness Grid**          | Logos/icons for all 6 supported harnesses (Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, Antigravity CLI) |
| **How It Works**          | 3-step visual: Write workflow → Run → Validate. Animated or static code snippet showing a `.ctrlyoke.yaml`        |
| **Pro Callout**           | Brief teaser of Pro features with link to `/pricing/`                                                             |
| **Install / Get Started** | VS Code marketplace badge + `npm install -g ctrlyoke` snippet                                                     |
| **Footer**                | Links to docs, GitHub, pricing, changelog                                                                         |

### 3.2 Design Tokens

Mirror the VS Code webview dashboard's visual language:

- Dark mode by default, light mode optional
- Accent color: match the ctrlyoke icon/brand color
- Font: system-ui or Inter (via Fontsource)
- Code blocks: use CodeMirror or Shiki (Astro has native Shiki integration)

---

## Phase 4 — VitePress Docs

The existing `docs/` structure is solid and ships as-is. Minor additions needed before launch:

### 4.1 Docs Additions Needed

- [x] `docs/guide/installation.md` — confirm CLI install instructions are up to date (`npm install -g ctrlyoke`)
- [ ] `docs/changelog.md` — add as a redirect target or mirrored page (deferred to post-launch; does not exist as of 2026-10-10)
- [x] `docs/pro/index.md` — Pro features overview, "Who needs a license?", and activation instructions
- [x] Update `docs/.vitepress/config.mts` — `base: '/docs/'` (already default)
- [x] Add `docs/.vitepress/config.mts` → `themeConfig.logo` (+ `socialLinks` already present); added Pro nav/sidebar entry; logo at `docs/public/ctrlyoke-icon.svg`

### 4.2 VitePress Base Path

```typescript
// docs/.vitepress/config.mts
export default defineConfig({
  base: "/docs/",
  // ...
});
```

---

## Phase 5 — Pro Licensing → moved to [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md)

The tier structure, `LicenseService`, entitlement verification, activation flow, and the license-key-vs-accounts decision now live in [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md). Summary of the decision so this document stays self-consistent:

- **Storefront / MoR:** **Lemon Squeezy** (existing account) — checkout, payment, global tax.
- **Licensing:** **Keygen** — issues **Ed25519-signed license files** verified **offline** in the extension (no per-request phone-home); supports **air-gapped / enterprise** activation from launch.
- **Glue:** a **Netlify Function** (this site's deploy) receives the Lemon Squeezy `order_created` webhook and creates the Keygen license.
- **Later:** "Sign in with ctrlyoke" device-code flow as a UX layer over the **same** `LicenseService`, when the hosted dashboard becomes a paid cloud product.
- **Pricing:** **$59 USD** perpetual, one-time; activates on up to 10 machines.

The website's licensing responsibilities are the **pricing page** (below), the **Lemon Squeezy checkout link**, and **hosting the webhook function** that bridges Lemon Squeezy → Keygen.

---

## Phase 6 — Pricing Page

Route: `ctrlyoke.dev/pricing/`

### 6.1 Layout

Two columns: **Free** (left) and **Pro** (right, highlighted). _As shipped, `pricing.astro` has a third **Enterprise** card ($4,499/yr site license, with "Contact sales" and PO/invoicing), added 2026-09-17. See `RELEASE_CHECKLIST.md` Phase 4.4._

**Free column:**

- All 6 harnesses
- YAML / JSON / Markdown workflows — **unlimited steps** (no caps)
- End conditions, pre-conditions & error/retry behavior
- Full local VS Code dashboard
- Local hosted dashboard (**localhost**)
- Notifications, MCP manager, agent/skills manager, AI commit messages
- CLI binary
- Community support (GitHub Issues)

**Pro column:**

- Everything in Free
- **Code on the go** — remote / LAN browser dashboard on any device (QR-to-phone, mobile push)
- Custom hooks
- Air-gapped / offline activation (enterprise)
- Custom icon color
- All future Pro features
- Email support
- **[Buy Now — $59]** → Lemon Squeezy checkout link (license issued by Keygen — see [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md))

_New users get a **14-day free trial of remote access** — no card, no account. After it ends, the dashboard stays free on localhost._

### 6.2 FAQ Section

- "What is a perpetual license?" — One-time purchase, yours forever, includes all future Pro features in the same tier.
- "Can I use it on multiple machines?" — Yes, one license activates on up to 10 devices.
- "Is there a trial?" — Yes. The free tier is fully functional forever (no time limit, no credit card), and remote "code on the go" access is free to trial for 14 days on top of that.
- "Do you offer team/enterprise pricing?" — As shipped: yes, a $4,499/year Enterprise site license; email sales@ctrlyoke.dev, which also handles POs.
- "What's your refund policy?" — As shipped: Pro has a 30-day money-back guarantee, and Enterprise is non-refundable once the term starts (see `dev/implemented/REFUND_POLICY.md`).

---

## Phase 7 — Checklist

### Pre-Launch

- [x] Complete business email and account ownership setup. `RELEASE_CHECKLIST.md` Phase 3 marks the Google Workspace `@ctrlyoke.dev` role inboxes done; that checklist has no "Phase 0" any more.
- [x] Create `landing/` Astro project in repo root (Astro 5 + Tailwind)
- [x] Configure dual build + `/docs/` merge — root `build:site` script (`build:landing` → `build:docs` → `scripts/merge-docs-into-landing.mjs`); `netlify.toml` updated
- [x] Add the three Netlify deploy workflows (§2.3, mirror `FuzzyNova/fuzzno`) and retire the legacy `docs-deploy.yml`. Netlify site created, secrets added, deploys green. (`deploy.yml` has since gained `workflow_dispatch` and extra path filters such as `images/**` and `schemas/**`.)
- [x] `base: '/docs/'` in `docs/.vitepress/config.mts` (already the default; old `DOCS_BASE=/ctrlyoke/` override retired with `docs-deploy.yml`)
- [x] **Point `ctrlyoke.dev` DNS to Netlify** (DNS in Cloudflare, DNS-only; see `dev/implemented/CTRLYOKE_REBRAND_CUTOVER.md` §1)
- [x] Write landing page hero + features sections
- [x] Add harness icon grid (`landing/public/icons/harnesses/`)
- [x] Write pricing page (Free vs Pro columns + FAQ)
- [x] Add `/terms` + `/privacy` pages (render canonical root `LICENSE.md` / `PRIVACY.md`)
- [x] Pre-launch mode — `LAUNCHED` flag (`landing/src/config.ts`) gates disabled "Coming soon" CTAs, a banner, and `noindex`
- [ ] Wire pricing-page checkout to Lemon Squeezy — **deferred:** disabled pre-launch; set `CHECKOUT_URL` and flip `LAUNCHED` at launch
- [x] Publish `support@ctrlyoke.dev` as the support path on the site/docs (README/Marketplace/site agreement is tracked in [`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 12)
- [x] Add Netlify Function `ls-webhook` (Lemon Squeezy `order_created` → create Keygen license); `netlify/functions/ls-webhook.ts`, `04b0e8131`. Since extended for Enterprise subscriptions and full-vs-partial refunds (`87ba0728a`). Details in [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md)
- [x] Add `docs/pro/index.md` (activation instructions)
- [x] Add `docs/.vitepress/config.mts` logo + social links
- [x] **Push to `main` for the first production deploy; confirm the Action is green, then test all live routes + the pre-launch state** (deploys green; `/`, `/docs/`, `/pricing/` return 200 as of 2026-10-10)

> **Extension-side licensing tasks** (provider setup, `LicenseService`, "Activate Pro License" command, gating `CtrlYokeHostedServer` / SCM commit / MCP, step-limit enforcement) are tracked in [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md), not here.

### Post-Launch (Nice to Have)

- [ ] Blog section on landing page (Astro content collections)
- [ ] Changelog page (auto-generated from `CHANGELOG.md`)
- [ ] "Teams" license tier (site license, N seats)
- [ ] Subscription option for AI usage credits / hosted runs
- [ ] Analytics via Netlify Analytics or Plausible (privacy-friendly)

---

## Related Backlog Items

- [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) — Pro licensing model, `LicenseService`, tier gating (split out of this plan)
- [`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) — top-level launch sequence, business email, account ownership, legal, and support readiness
- [`RELEASE_PLAN.md`](RELEASE_PLAN.md) — VS Code Marketplace release prerequisites
- [`TELEMETRY_PLAN.md`](../implemented/TELEMETRY_PLAN.md) — Usage telemetry for the extension (implemented)
- [`ROADMAP.md`](../active/ROADMAP.md) — Long-term feature roadmap
