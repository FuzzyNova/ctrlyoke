# FlightPath Landing Page Plan

**Created:** May 21, 2026  
**Status:** PLANNING  
**Domain:** flightpath.dev (purchased, hosted on Netlify)

---

## Overview

This document covers everything needed to ship `flightpath.dev`: the marketing landing page, the published VitePress docs, the pricing/licensing page, and the Pro tier via Lemon Squeezy. The goal at release is a single perpetual license SKU that unlocks power-user features, with a clean free tier that still delivers real value.

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

## Phase 5 — Pro Licensing

### 5.1 Tier Structure

| Feature                                            | Free               | Pro       |
| -------------------------------------------------- | ------------------ | --------- |
| All 7 harnesses                                    | ✅                 | ✅        |
| Core workflow execution                            | ✅                 | ✅        |
| Workflow step limit                                | 100 steps/workflow | Unlimited |
| Hosted dashboard server (`FlightPathHostedServer`) | ❌                 | ✅        |
| MCP server integration                             | ❌                 | ✅        |
| AI commit message generation                       | ❌                 | ✅        |
| All future Pro features                            | ❌                 | ✅        |

**Step limit rationale:** 10 steps covers the vast majority of personal use. Teams and power users who build multi-step automation pipelines are the natural Pro audience.

### 5.2 Lemon Squeezy Setup

1. Create a Lemon Squeezy store for `flightpath.dev`
2. Create one product: **FlightPath Pro** — perpetual license
3. Set price: **$59 USD** (one-time, no subscription)
4. Enable license key generation (Lemon Squeezy built-in)
5. Configure webhook for `license_key_created` events (optional for analytics)

**Why perpetual over subscription at launch:**

- Easier sell for a VS Code extension (users expect one-time pricing, see GitLens, Copilot Kit, etc.)
- Lower support burden — no churn, no renewal emails
- Can add a subscription "Pro+" tier later for teams / AI usage credits

### 5.3 License Activation Flow (Extension)

```
User purchases → receives license key email
→ VS Code: Command "FlightPath: Activate Pro License"
→ Input box → user pastes key
→ Extension calls Lemon Squeezy Validate License API
→ On success: store key in context.globalState, cache isPro=true with TTL
→ Pro features unlock immediately, no restart needed
```

### 5.4 `LicenseService` Implementation

Create `src/license/LicenseService.ts`:

```typescript
export class LicenseService {
  private static readonly KEY = 'flightpath.licenseKey';
  private static readonly CACHE_KEY = 'flightpath.proValidated';
  private static readonly CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  static async isPro(context: vscode.ExtensionContext): Promise<boolean> { ... }
  static async activate(key: string, context: vscode.ExtensionContext): Promise<boolean> { ... }
  static async deactivate(context: vscode.ExtensionContext): Promise<void> { ... }
}
```

- Validation: `POST https://api.lemonsqueezy.com/v1/licenses/validate`
- Cache validated state with timestamp in `globalState` (re-validates after TTL)
- Offline grace period: if network unreachable, trust cached state for up to 30 days
- Gate Pro features via `await LicenseService.isPro(context)` in `WorkflowExecutor`, `FlightPathHostedServer`, and `ScmCommitCommand`

---

## Phase 6 — Pricing Page

Route: `flightpath.dev/pricing/`

### 6.1 Layout

Two columns: **Free** (left) and **Pro** (right, highlighted).

**Free column:**

- All 7 harnesses
- YAML / JSON / Markdown workflows
- End conditions & retry logic
- VS Code dashboard
- Up to 100 steps per workflow
- Community support (GitHub Issues)

**Pro column:**

- Everything in Free
- Unlimited workflow steps
- Hosted web dashboard (browser access)
- MCP server integration
- AI-powered commit messages
- All future Pro features
- Email support
- **[Buy Now — $59]** → Lemon Squeezy checkout link

### 6.2 FAQ Section

- "What is a perpetual license?" — One-time purchase, yours forever, includes all future Pro features in the same tier.
- "Can I use it on multiple machines?" — Yes, one license activates on up to 3 devices.
- "Is there a trial?" — Yes, the free tier is fully functional. No time limit, no credit card.
- "Do you offer team/enterprise pricing?" — Not yet. Coming soon. Contact us.

---

## Phase 7 — Checklist

### Pre-Launch

- [ ] Create `landing/` Astro project in repo root
- [ ] Configure `netlify.toml` for dual build + `/docs/` path merge
- [ ] Set `base: '/docs/'` in `docs/.vitepress/config.mts`
- [ ] Point `flightpath.dev` DNS to Netlify
- [ ] Write landing page hero + features sections
- [ ] Add harness icon grid (reuse from `src/ui/icons/`)
- [ ] Write pricing page (Free vs Pro columns + FAQ)
- [ ] Set up Lemon Squeezy product + checkout link
- [ ] Implement `LicenseService` in extension
- [ ] Add "Activate Pro License" command to `package.json` + `extension.ts`
- [ ] Gate `FlightPathHostedServer`, `ScmCommitCommand`, MCP behind `isPro()`
- [ ] Add free-tier step limit enforcement in `WorkflowExecutor`
- [ ] Add `docs/pro/index.md` (activation instructions)
- [ ] Add `docs/.vitepress/config.mts` logo + social links

### Post-Launch (Nice to Have)

- [ ] Blog section on landing page (Astro content collections)
- [ ] Changelog page (auto-generated from `CHANGELOG.md`)
- [ ] "Teams" license tier (site license, N seats)
- [ ] Subscription option for AI usage credits / hosted runs
- [ ] Analytics via Netlify Analytics or Plausible (privacy-friendly)

---

## Related Backlog Items

- [`RELEASE_PLAN.md`](RELEASE_PLAN.md) — VS Code Marketplace release prerequisites
- [`TELEMETRY_PLAN.md`](TELEMETRY_PLAN.md) — Usage telemetry for the extension
- [`ROADMAP.md`](ROADMAP.md) — Long-term feature roadmap
