# FlightPath Landing Page Plan

**Created:** May 21, 2026  
**Status:** PLANNING  
**Domain:** flightpath.dev (purchased, hosted on Netlify)
**Launch dependency:** business email, support inboxes, vendor account ownership, and publisher identity are tracked in [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

---

## Overview

This document covers everything needed to ship `flightpath.dev`: the marketing landing page, the published VitePress docs, and the pricing page. The goal at release is a single perpetual license SKU that unlocks power-user features, with a clean free tier that still delivers real value.

> **Scope note:** The **Pro licensing model** (provider choice, the extension `LicenseService`, entitlement verification, activation flow, tier gating, and the license-key-vs-accounts decision) used to live here in Phase 5. It has been **split out into [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)**. This document now owns only the **website surface** (marketing page, docs, pricing page, checkout link). The chosen direction is: pasted license key at launch, user accounts/sign-in as a later UX layer — see the Decision Record in `PRO_LICENSE_PLAN.md`.

---

## Phase 1 — Site Architecture

### 1.1 URL Structure

All content lives on one domain (better SEO, simpler Netlify config):

| URL                         | Content                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `flightpath.dev/`           | Marketing landing page (Astro)                                            |
| `flightpath.dev/docs/`      | VitePress docs (built separately, merged)                                 |
| `flightpath.dev/pricing/`   | Pro licensing page                                                        |
| `flightpath.dev/changelog/` | CHANGELOG surfaced on the web (can be auto-generated from `CHANGELOG.md`) |

### 1.2 Repository Structure

Create a new repo (or monorepo subfolder `landing/`) for the Astro site. The existing `docs/` VitePress site builds separately and its output is merged into the Astro dist at deploy time.

Option A — **Separate repo**: `flightpath-landing` → deploys to `flightpath.dev`  
Option B — **Monorepo**: add `landing/` alongside `docs/` in this repo, with one Netlify site

**Recommendation: Option B (monorepo).** Keeps the docs and landing page in sync with extension releases. One repo, one Netlify deploy, one CI pipeline.

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

---

## Phase 3 — Landing Page Content

### 3.1 Sections (in order)

| Section                   | Purpose                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Hero**                  | Headline + subhead + primary CTA ("Install for VS Code" → marketplace link)                                       |
| **Problem / Solution**    | 1-sentence pitch: "AI coding assistants are powerful but manual. FlightPath turns them into automated workflows." |
| **Key Features**          | 4–6 cards: multi-harness support, YAML workflows, end conditions, session resumption, MCP integration, CLI binary |
| **Harness Grid**          | Logos/icons for all 7 supported harnesses (Copilot, Claude, Codex, OpenCode, Qwen, Gemini, Copilot Chat)          |
| **How It Works**          | 3-step visual: Write workflow → Run → Validate. Animated or static code snippet showing a `.flightpath.yaml`      |
| **Pro Callout**           | Brief teaser of Pro features with link to `/pricing/`                                                             |
| **Install / Get Started** | VS Code marketplace badge + `npm install -g flightpath` snippet                                                   |
| **Footer**                | Links to docs, GitHub, pricing, changelog                                                                         |

### 3.2 Design Tokens

Mirror the VS Code webview dashboard's visual language:

- Dark mode by default, light mode optional
- Accent color: match the FlightPath icon/brand color
- Font: system-ui or Inter (via Fontsource)
- Code blocks: use CodeMirror or Shiki (Astro has native Shiki integration)

---

## Phase 4 — VitePress Docs

The existing `docs/` structure is solid and ships as-is. Minor additions needed before launch:

### 4.1 Docs Additions Needed

- [ ] `docs/guide/installation.md` — confirm CLI install instructions are up to date (`npm install -g flightpath`)
- [ ] `docs/changelog.md` — add as a redirect target or mirrored page
- [ ] `docs/pro/index.md` — Pro features overview and license activation instructions
- [ ] Update `docs/.vitepress/config.mts` — set `base: '/docs/'` for subdirectory hosting
- [ ] Add `docs/.vitepress/config.mts` → `themeConfig.logo` and `socialLinks` for GitHub

### 4.2 VitePress Base Path

```typescript
// docs/.vitepress/config.mts
export default defineConfig({
  base: "/docs/",
  // ...
});
```

---

## Phase 5 — Pro Licensing → moved to [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)

The tier structure, `LicenseService`, entitlement verification, activation flow, and the license-key-vs-accounts decision now live in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md). Summary of the decision so this document stays self-consistent:

- **Storefront / MoR:** **Lemon Squeezy** (existing account) — checkout, payment, global tax.
- **Licensing:** **Keygen** — issues **Ed25519-signed license files** verified **offline** in the extension (no per-request phone-home); supports **air-gapped / enterprise** activation from launch.
- **Glue:** a **Netlify Function** (this site's deploy) receives the Lemon Squeezy `order_created` webhook and creates the Keygen license.
- **Later:** "Sign in with FlightPath" device-code flow as a UX layer over the **same** `LicenseService`, when the hosted dashboard becomes a paid cloud product.
- **Pricing:** **$59 USD** perpetual, one-time; activates on up to 3 machines.

The website's licensing responsibilities are the **pricing page** (below), the **Lemon Squeezy checkout link**, and **hosting the webhook function** that bridges Lemon Squeezy → Keygen.

---

## Phase 6 — Pricing Page

Route: `flightpath.dev/pricing/`

### 6.1 Layout

Two columns: **Free** (left) and **Pro** (right, highlighted).

**Free column:**

- All 7 harnesses
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
- **[Buy Now — $59]** → Lemon Squeezy checkout link (license issued by Keygen — see [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md))

_New users get a **14-day free trial of remote access** — no card, no account. After it ends, the dashboard stays free on localhost._

### 6.2 FAQ Section

- "What is a perpetual license?" — One-time purchase, yours forever, includes all future Pro features in the same tier.
- "Can I use it on multiple machines?" — Yes, one license activates on up to 3 devices.
- "Is there a trial?" — Yes. The free tier is fully functional forever (no time limit, no credit card), and remote "code on the go" access is free to trial for 14 days on top of that.
- "Do you offer team/enterprise pricing?" — Not yet. Coming soon. Contact us.

---

## Phase 7 — Checklist

### Pre-Launch

- [ ] Complete Phase 0 business email and account ownership setup in [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)
- [ ] Create `landing/` Astro project in repo root
- [ ] Configure `netlify.toml` for dual build + `/docs/` path merge
- [ ] Set `base: '/docs/'` in `docs/.vitepress/config.mts`
- [ ] Point `flightpath.dev` DNS to Netlify
- [ ] Write landing page hero + features sections
- [ ] Add harness icon grid (reuse from `src/ui/icons/`)
- [ ] Write pricing page (Free vs Pro columns + FAQ)
- [ ] Wire pricing-page checkout to Lemon Squeezy
- [ ] Publish `support@flightpath.dev` as the customer support path on the site, docs, README, and marketplace listing
- [ ] Add Netlify Function `ls-webhook` (Lemon Squeezy `order_created` → create Keygen license); details in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)
- [ ] Add `docs/pro/index.md` (activation instructions)
- [ ] Add `docs/.vitepress/config.mts` logo + social links

> **Extension-side licensing tasks** (provider setup, `LicenseService`, "Activate Pro License" command, gating `FlightPathHostedServer` / SCM commit / MCP, step-limit enforcement) are tracked in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md), not here.

### Post-Launch (Nice to Have)

- [ ] Blog section on landing page (Astro content collections)
- [ ] Changelog page (auto-generated from `CHANGELOG.md`)
- [ ] "Teams" license tier (site license, N seats)
- [ ] Subscription option for AI usage credits / hosted runs
- [ ] Analytics via Netlify Analytics or Plausible (privacy-friendly)

---

## Related Backlog Items

- [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) — Pro licensing model, `LicenseService`, tier gating (split out of this plan)
- [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) — top-level launch sequence, business email, account ownership, legal, and support readiness
- [`RELEASE_PLAN.md`](RELEASE_PLAN.md) — VS Code Marketplace release prerequisites
- [`TELEMETRY_PLAN.md`](TELEMETRY_PLAN.md) — Usage telemetry for the extension
- [`ROADMAP.md`](ROADMAP.md) — Long-term feature roadmap
