# Fuzzy Nova Studio Site Revamp Plan

**Target repo:** `C:\dev\fuzzno` → `github.com/FuzzyNova/fuzzno` → deploys to **fuzzno.com** on Netlify
**Status:** PLANNING
**Created:** June 26, 2026
**Portability note:** This plan lives in the FlightPath backlog but is written to be **carried over to the `fuzzno` workspace** and handed to an agent there. It is self-contained — it does not depend on any FlightPath repo files. The only cross-reference is the external URL `flightpath.dev`.

---

## Purpose

Evolve `fuzzno.com` from a single-game splash page into a professional **software-studio** site that presents Fuzzy Nova's portfolio under one brand: the **Nibiru** game and the **FlightPath** developer tool (`flightpath.dev`). The site should read like the home of a small but serious studio that ships both games and developer tooling — not a one-game portfolio.

---

## Current State (audited June 26, 2026)

- **Single static `index.html`** — no framework, no build step. Inline `<style>`, dark theme (`#0a0a14` background, `#e8e8f0` text), `DPComic` display font, tagline **"games & interactive experiences"**.
- **One project link** → `/nibiru` ("Making Movies | Nibiru ▶"), a Unity WebGL game.
- **Nibiru highscores backend:** Netlify Function `netlify/functions/highscores.js` + `@netlify/blobs` (the only `package.json` dependency). `netlify.toml` proxies `/nibiru/highscores.php` → the function and 404s direct access to the raw highscores JSON.
- **Assets:** `assets/FuzzyNova-Logo.png`, `FuzzyNova-Favicon.png`, `assets/dpcomic.ttf`.
- **Deploy:** **GitHub Actions → Netlify CLI** (not Netlify's native Git integration — free-tier Netlify does not offer native auto-deploy for organization-owned repos, so an org repo like `FuzzyNova/fuzzno` must push deploys from CI). Three workflows in `.github/workflows/`:
  - `_netlify-deploy.yml` — reusable workflow: `checkout → setup-node 20 → npm ci → npx netlify-cli deploy --dir=. <args>`, using `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` secrets.
  - `deploy.yml` — on push to `main`, calls the reusable workflow with `--prod`.
  - `deploy-preview.yml` — on push to any non-`main` branch, calls it with `--alias=<branch>` for preview URLs.
  - `netlify.toml` sets `publish = "."` and the functions dir / highscores redirects (used by the CLI deploy).
- **Metadata:** only `<title>` + favicon. No description, no OpenGraph/Twitter tags, no sitemap/robots.

---

## Goals

1. Reposition Fuzzy Nova as an **independent software studio** spanning games **and** developer tools.
2. Replace the single project link with a **projects/products grid** holding two first-class entries:
   - **FlightPath** — developer tool, primary outbound CTA to `https://flightpath.dev`.
   - **Nibiru** — game, links to `/nibiru` (unchanged).
3. Add the polish that signals "professional studio": real intro copy, social/share metadata, a footer with contact, and consistent visual language.
4. Keep the site **fast, static, and low-maintenance**, and leave the **Nibiru game and its highscores function completely untouched**.

---

## Non-Goals

- **Do not** modify, rebuild, or move the Nibiru game (`/nibiru/**`) or its highscores Netlify Function / blobs wiring.
- **Do not** change the Netlify deploy mechanism or move the repo.
- No blog/CMS, no e-commerce, no FlightPath license/checkout logic — those live on `flightpath.dev`. This site only *links* to FlightPath.

---

## Recommended Approach: stay static (no framework)

**Recommendation: keep it plain static HTML/CSS** (optionally split shared styles into a `styles.css`). Rationale:

- Keeps the existing **GitHub Actions → Netlify CLI** deploy working unchanged: the reusable workflow publishes `--dir=.`, so as long as the site stays static there is **no build step to add and no workflow to touch**. (Going Astro would force a build step and a `--dir=landing/dist`-style change to the deploy workflow.) Lowest risk; Nibiru function untouched.
- The site is a handful of sections; a framework adds toolchain weight for no real gain.
- Fast by default — good Core Web Vitals with no JS.

**Alternative (note, don't default to it):** adopt **Astro** for visual/component parity with `flightpath.dev` (which the FlightPath landing plan builds in Astro). Only worth it if you intend to share components/design tokens across both sites. Tradeoff: introduces a build step and a `package.json` build pipeline that Netlify must run, and risks disturbing the working static + function setup. **Defer unless cross-site component sharing becomes a real need.**

---

## Work Plan

### 1. Information architecture & copy
- [ ] Rewrite the tagline. Current "games & interactive experiences" no longer covers developer tools. Options (Nathan to pick — see Open Decisions): *"an independent software studio"*, *"games & developer tools"*, *"we build games and tools for builders"*.
- [ ] Add a one- or two-sentence studio intro under the hero establishing what Fuzzy Nova is.
- [ ] Restructure the body from a single link into a **Projects grid** of cards:
  - **FlightPath** — short line e.g. *"Automate your AI coding assistants — a VS Code extension."* Primary button → `https://flightpath.dev` (external, `rel="noopener"`). Tag it as a developer tool.
  - **Nibiru** — short line e.g. *"A rhythm-driven Unity game."* Button → `/nibiru`. Tag it as a game.
- [ ] Add a **footer**: `© {year} Fuzzy Nova`, contact (`hello@fuzzno.com`), link to `flightpath.dev`, and the GitHub org if you want it public.

### 2. Visual design
- [ ] Keep the dark theme, logo, and brand accent (currently `#4444aa`/`#aaaaff`), but elevate from one centered splash to a clean multi-section layout (hero → projects grid → footer).
- [ ] Responsive card grid (1 column mobile, 2 columns desktop).
- [ ] Keep `DPComic` for the display heading, but use a clean body font (`system-ui` or Inter) for intro/card/footer copy so longer text reads professionally. Right now `DPComic` is only on the `h1`, which is fine — just don't push the comic font into body copy.
- [ ] Optional: small per-project thumbnail/icon (a Nibiru icon already exists at `nibiru/TemplateData/NibiruIcon*.png`; use or supply a FlightPath mark).

### 3. SEO & share metadata (biggest "professional" lever)
- [ ] Add `<meta name="description">`, canonical URL, and **OpenGraph + Twitter card** tags so `fuzzno.com` produces a proper preview when shared. This is the cheapest, highest-impact polish — a bare link preview is the main thing that reads "hobby" today.
- [ ] Add a share/OG image (studio logo on brand background).
- [ ] Add `robots.txt` and a minimal `sitemap.xml`.

### 4. Cross-linking
- [ ] `fuzzno.com` → `flightpath.dev` via the FlightPath card + footer (this plan).
- [ ] Reciprocal `flightpath.dev` → `fuzzno.com` ("operated by Fuzzy Nova") is owned by the **FlightPath landing page plan**, not this one. Just make sure the FlightPath card here points at the production domain.

### 5. Deploy (no workflow changes required)
- [ ] None needed — the existing GitHub Actions deploy (`deploy.yml` → `_netlify-deploy.yml`, `--dir=.`) already publishes to production on push to `main`, and `deploy-preview.yml` gives every branch a preview URL. As long as the revamp stays static, the workflows and secrets are untouched.
- [ ] Use a **branch + preview deploy** to review the revamp before merging: push the work to a non-`main` branch, open the `--alias=<branch>` preview URL, confirm the new landing content, share-metadata preview, and the **untouched** `/nibiru` route + highscores, then merge to `main` for the `--prod` deploy.

---

## Acceptance Criteria

- `fuzzno.com` presents Fuzzy Nova as a studio with **both** FlightPath and Nibiru as first-class projects.
- FlightPath card links to `https://flightpath.dev`; Nibiru still loads at `/nibiru` with working highscores.
- Sharing `fuzzno.com` yields a proper title + description + image preview.
- No changes to `nibiru/**`, `netlify/functions/**`, or the `netlify.toml` redirects for highscores.
- Site remains static and deploys via the existing GitHub Actions → Netlify CLI workflows with no workflow edits and no new failures.

---

## Open Decisions (for Nathan)

1. **Tagline wording** — pick from the options above or supply your own.
2. **Static vs Astro** — recommendation is static; confirm you don't want cross-site component sharing yet.
3. **Public contact / GitHub org link in footer** — include `hello@fuzzno.com`? Link the GitHub org publicly?
4. **FlightPath positioning line** — confirm the one-liner used on the card matches the messaging on `flightpath.dev`.
