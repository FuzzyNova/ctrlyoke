# ctrlyoke Documentation Strategy Plan

> **Status:** Active — Infrastructure ready, content pending  
> **Date:** March 2026  
> **Updated:** March 2026 — `docs/` cleaned and empty; `dev/` folder convention established  
> **Scope:** Public-facing documentation for the ctrlyoke VS Code extension, companion CLI binaries (`ctrlyoke-mcp`, `ctrlyoke`), and YAML/JSON workflow file format.

---

## Table of Contents

1. [Overview & Goals](#1-overview--goals)
2. [Documentation Types](#2-documentation-types)
3. [VS Code Extension Documentation Standards](#3-vs-code-extension-documentation-standards)
4. [CLI Tool Documentation Standards](#4-cli-tool-documentation-standards)
5. [Platform Comparison](#5-platform-comparison)
6. [Recommendation with Rationale](#6-recommendation-with-rationale)
7. [Proposed Documentation Structure](#7-proposed-documentation-structure)
8. [VS Code Marketplace README Strategy](#8-vs-code-marketplace-readme-strategy)
9. [JSON Schema Reference Strategy](#9-json-schema-reference-strategy)
10. [CLI `--help` and Hosted Docs Relationship](#10-cli---help-and-hosted-docs-relationship)
11. [Implementation Steps](#11-implementation-steps)
12. [Versioning & Maintenance Considerations](#12-versioning--maintenance-considerations)

---

## 1. Overview & Goals

### Project Context

ctrlyoke is a VS Code extension (publisher: `fuzzynova`) that automates AI coding assistants — GitHub Copilot, Claude Code, Codex, OpenCode, Qwen Code, and Gemini — through structured YAML/JSON workflow files. The product surface area includes:

| Surface                                            | Notes                                            |
| -------------------------------------------------- | ------------------------------------------------ |
| VS Code Extension                                  | Published/to be published on VS Code Marketplace |
| `ctrlyoke-mcp` CLI binary                          | Standalone MCP server for queue management       |
| `ctrlyoke` CLI binary                              | CLI adapter for direct workflow execution        |
| `.ctrlyoke.yaml` / `.ctrlyoke.json` / `.prompt.md` | Workflow file formats with JSON Schema           |
| Owner's existing website                           | Already exists                                   |
| GitHub repository                                  | Public, `github.com/FuzzyNova/ctrlyoke`          |

### Documentation Goals

1. **Discoverability** — Users who find the extension on the Marketplace or GitHub can quickly understand what it does.
2. **Getting Started** — A new user can install and run their first workflow in under 10 minutes.
3. **Reference completeness** — Every workflow YAML property, every setting, every CLI flag is documented.
4. **Searchable** — Users can search for specific properties, error messages, or concepts.
5. **Maintainable** — Docs live close to the code and stay in sync with releases with minimal ceremony.
6. **Professional appearance** — Looks polished enough to build trust for a pre-release extension entering the marketplace.

---

## 2. Documentation Types

ctrlyoke needs four distinct documentation layers, each with a different primary delivery mechanism:

### Layer 1 — Marketplace Page (README.md)

**Primary audience:** Someone browsing the VS Code Marketplace deciding whether to install.  
**Key question answered:** "What is this and why should I try it?"  
**Delivery:** The project's `README.md` is the exact content rendered on `marketplace.visualstudio.com`.

### Layer 2 — In-Extension Contextual Help

**Primary audience:** A user already inside VS Code.  
**Key question answered:** "What does this setting/command/field do right now?"  
**Delivery:** `package.json` `description` fields for settings; hover text on workflow YAML via JSON Schema; command palette `detail` fields.

### Layer 3 — Hosted Reference Documentation

**Primary audience:** A user actively building a workflow who needs to look something up.  
**Key question answered:** "What are all the options for `endCondition`? What models are supported?"  
**Delivery:** A dedicated documentation website (to be chosen).

### Layer 4 — CLI Help Text

**Primary audience:** A developer running `ctrlyoke --help` in a terminal.  
**Key question answered:** "What flags are available? What does this command do?"  
**Delivery:** Built into the CLI binary, cross-referenced to hosted docs.

---

## 3. VS Code Extension Documentation Standards

### How Extensions Publish Documentation

The VS Code Marketplace **directly renders** the `README.md` from the repository root (or whatever file `package.json → readme` points to). This is the single most important user-facing document because it is the extension's "product page."

Key mechanics:

- Images in `README.md` must be absolute URLs (hosted externally) OR be included in the `.vsix` bundle. Relative paths work in the VSIX context. Using `https://raw.githubusercontent.com/...` for images is a common and reliable approach.
- The Marketplace supports standard GitHub Flavored Markdown.
- Animated GIFs are strongly encouraged — they are the primary way users evaluate whether an extension is worth installing.
- The `package.json` field `"galleryBanner": { "color": "#...", "theme": "dark" }` controls the banner color at the top of the marketplace page.
- The `"badges"` array in `package.json` can add shields (build status, version, etc.).

### In-Extension Contextual Help

These are essentially free to implement and highly valuable:

**Settings descriptions** (`package.json → contributes.configuration.properties`)

```json
"ctrlyoke.harness": {
  "type": "string",
  "description": "Active harness to use for AI execution. Options: copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, antigravity-cli.",
  "markdownDescription": "Active **harness** for AI execution. See [harness documentation](https://docs.ctrlyoke.dev/harnesses) for details."
}
```

The `markdownDescription` variant (instead of `description`) renders with links and formatting in VS Code's settings UI.

**Command descriptions** (`contributes.commands`)  
The `detail` field on a command appears as a subtitle in the Command Palette. Use it for a one-sentence description of what the command does.

**JSON Schema hover docs**  
Since ctrlyoke already has `schemas/workflow-schema.json`, the completions provider and YAML language server provide inline hover documentation for every property. This is already partially implemented. Every `description` field in the JSON Schema becomes tooltip text inside `.ctrlyoke.yaml` files. This is high-value contextual documentation that requires no external site.

### Well-Documented Extension Examples to Reference

| Extension                           | Documentation Style                                                  | What to Learn                                         |
| ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| **GitLens** (gitkraken.com/gitlens) | Separate dedicated website (gitkraken.com) + rich Marketplace README | How to separate marketing README from deep reference  |
| **Prettier**                        | Simple README, links to prettier.io                                  | Minimal marketplace page, all depth lives externally  |
| **ESLint**                          | Marketplace README mirrors eslint.org docs for VS Code section       | How to keep docs in sync with a monorepo              |
| **REST Client**                     | Comprehensive README with GIFs and tables covering all features      | Self-contained in README when features are enumerable |
| **Tabnine / GitHub Copilot**        | Marketplace page is intentionally brief with strong CTA to website   | The "landing page" approach                           |

**Takeaway for ctrlyoke:** The Marketplace README should be a polished landing page (install + first workflow in 5 minutes), not a comprehensive reference. All depth belongs on the hosted docs site.

---

## 4. CLI Tool Documentation Standards

### How Popular CLI Tools Document Commands

| Tool                     | Primary Docs                                 | --help style                       | Notes                                        |
| ------------------------ | -------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `gh` (GitHub CLI)        | cli.github.com (custom domain, manual pages) | Full synopsis + examples           | Docs generated from command definitions      |
| `claude` (Anthropic CLI) | docs.anthropic.com                           | Brief synopsis, points to web docs | Web docs are authoritative                   |
| `npm`                    | docs.npmjs.com                               | Very detailed, with examples       | npm's `--help` is surprisingly comprehensive |
| `docker`                 | docs.docker.com                              | Comprehensive man-page style       | Each subcommand has its own `--help` page    |

### Patterns Applicable to ctrlyoke CLI

**`--help` output principles:**

- Every command and flag should have a one-line description.
- Commands that accept file paths should state the accepted formats.
- Include 1–2 usage examples at the bottom.
- End with a pointer to hosted docs: `For full documentation, see: https://docs.ctrlyoke.dev/cli`

**Man pages:** Unless the CLI is distributed via a package manager that installs man pages (e.g., Homebrew), man pages are overkill. Skip for now.

**Auto-generation from command definitions:** If `ctrlyoke` CLI is built with a framework like `commander` or `yargs`, there are tools that can auto-generate markdown documentation from the command tree. The package `commander-to-markdown` and `yargs-to-cli` exist for this. Check current CLI implementation to determine feasibility.

**Hosted CLI reference:** A dedicated page per CLI command (`/docs/cli/run`, `/docs/cli/queue`, etc.) is the cleanest approach and allows full examples and cross-links.

---

## 5. Platform Comparison

### 5.1 ReadTheDocs (readthedocs.io)

**How it works:**  
ReadTheDocs integrates with GitHub/GitLab and automatically builds documentation on every commit. It supports **Sphinx** (reStructuredText or MyST Markdown) and **MkDocs** (Markdown). When you connect a repo, it reads a `.readthedocs.yaml` config file and runs the build.

**Free tier:**

- ✅ **Free for public open-source projects** (the Community plan)
- Public projects hosted at `<project>.readthedocs.io`
- Custom domain support on paid plans only (starts at ~$5/month for the Pro tier as of 2025)
- Includes versioned docs (build multiple versions from different branches/tags)
- Includes a full-text search UI (powered by Elasticsearch)
- Adds a small "Advertisement" banner on free public projects (can be removed with the Pro plan)

**Non-Python project support:**  
ReadTheDocs is designed around Python tooling but **does work with non-Python projects** using MkDocs. The `mkdocs` builder requires only a `mkdocs.yml` config file and markdown content. No Python code required — just a `requirements.txt` for the MkDocs theme/plugins:

```yaml
# .readthedocs.yaml
version: 2
build:
  os: ubuntu-24.04
  tools:
    python: "3.12"
mkdocs:
  configuration: mkdocs.yml
python:
  install:
    - requirements: docs/requirements.txt # mkdocs, mkdocs-material, etc.
```

**Pros for ctrlyoke:**

- ✅ Free for public projects
- ✅ Built-in versioning (show docs for v0.1, v0.2, etc.)
- ✅ Built-in search (no extra configuration)
- ✅ Auto-deploys from GitHub — any commit to `main` rebuilds docs
- ✅ Respectable brand name; developers know ReadTheDocs
- ✅ PDF/ePub export available

**Cons for ctrlyoke:**

- ❌ Tool is Python-centric — the MkDocs path works but feels like a workaround
- ❌ Theming is more limited than VitePress/Docusaurus without heavy customization
- ❌ Custom domain requires paid plan (~$5/mo)
- ❌ Ads on free plan (small, but visible)
- ❌ The ReadTheDocs URL scheme (`project.readthedocs.io/en/latest/`) is wordier than alternatives
- ❌ Less control over the look and layout vs. static site generators

**Best for:** Python libraries, scientific computing tools, projects that already use Sphinx. Not ideal for TypeScript/Node.js.

---

### 5.2 GitHub Pages + VitePress

**How it works:**  
VitePress is a static site generator built by the Vite/Vue team. You write Markdown, configure a `docs/.vitepress/config.ts` file, and `vitepress build` produces a static site. A GitHub Actions workflow deploys the output to GitHub Pages on every push to `main`.

**Free tier:**

- ✅ **Completely free** (VitePress is MIT; GitHub Pages is free for public repos)
- ✅ Custom domain support at no extra cost (add a `CNAME` file)
- No advertisements

**Setup Overview:**

```
your-repo/
├── docs/
│   ├── .vitepress/
│   │   └── config.ts        # Site nav, sidebar, theme
│   ├── index.md             # Landing page
│   ├── guide/
│   │   └── getting-started.md
│   └── reference/
│       └── workflow-schema.md
├── .github/
│   └── workflows/
│       └── docs-deploy.yml  # Builds VitePress + deploys to Pages
└── package.json             # Add vitepress as devDependency
```

**GitHub Actions deploy workflow** (minimal):

```yaml
name: Deploy Docs
on:
  push:
    branches: [main]
    paths: ["docs/**"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "npm" }
      - run: npm ci
      - run: npm run docs:build
      - uses: actions/upload-pages-artifact@v3
        with: { path: docs/.vitepress/dist }
      - uses: actions/deploy-pages@v4
```

**Pros for ctrlyoke:**

- ✅ **Zero ongoing cost**, fully controlled
- ✅ Docs live in the same repo as the code — commits, PRs, and tags automatically include doc changes
- ✅ VitePress uses Vue components but content is pure Markdown — no Vue knowledge needed for routine edits
- ✅ Built-in full-text local search (zero config)
- ✅ Algolia DocSearch integration available for free for public OSS projects
- ✅ Custom domain via CNAME file (no account changes)
- ✅ Already familiar stack (Vite, TypeScript) — ctrlyoke's webview uses Vite
- ✅ Beautiful default theme with minimal configuration
- ✅ Fast build times (Vite — millisecond HMR in dev mode)
- ✅ Dark mode built in
- ✅ Sidebar is code-configured, making it easy to maintain in PRs
- ✅ Code blocks have syntax highlighting, line highlighting, line numbers, diff highlighting

**Cons for ctrlyoke:**

- ❌ No native versioning (can version manually by publishing different branches, but it requires setup)
- ❌ Documentation in the same repo adds to the repo's scope slightly
- ❌ Search is local/client-side unless Algolia is added (still excellent, just not server-side)
- ❌ Does not auto-build like ReadTheDocs — the GitHub Actions workflow must be set up

**Best for:** TypeScript/JavaScript projects, developer tools, extensions, libraries. **This is the natural fit for ctrlyoke.**

---

### 5.3 Docusaurus (Meta)

**How it works:**  
Docusaurus is a React-based static site generator by Meta. It is highly configurable and has enterprise-level features (versioning, i18n, plugin system). Like VitePress, it deploys to GitHub Pages (or anywhere).

**Free tier:**

- ✅ **Completely free** (MIT license)
- ✅ Deploy to GitHub Pages at no cost

**Pros vs. VitePress:**

- First-class **versioned documentation** (run `yarn docusaurus docs:version 1.0` to snapshot a version)
- Dedicated **blog** plugin (useful for changelogs/release notes)
- More mature plugin ecosystem
- React-based — more power for custom interactive pages
- Used by many major OSS projects: Jest, Babel, React Native, Create React App, Redux, Prettier

**Cons vs. VitePress:**

- Heavier — more dependencies, slower cold builds
- More configuration overhead to get started vs. VitePress's "zero config" approach
- React ecosystem (ctrlyoke's webview is already React, but the docs need no interactivity)
- Default theme requires more theming work to look polished out of the box
- Overkill for a single developer maintaining a single-product extension at early-stage

**When to choose Docusaurus over VitePress:**

- You need **multiple versioned doc sets** that must coexist publicly (e.g., docs for v0.x and v1.x simultaneously)
- You want a **blog** alongside the docs
- You have multiple contributors and need a plugin ecosystem

**For ctrlyoke currently:** Docusaurus's added complexity is not justified until the project has significant version churn requiring published simultaneous versions.

---

### 5.4 Docusaurus with Custom Domain (Subdomain of Existing Website)

If the existing website already has a domain (e.g., `yoursite.com`), the docs can be served at `docs.yoursite.com` by:

1. Setting up GitHub Pages to deploy to the custom domain
2. Adding a CNAME DNS record at your domain registrar: `docs → fuzzynova.github.io` (or whatever)
3. Setting `CNAME` file in the docs build output

This works identically for both VitePress and Docusaurus, and means the docs are on a professional custom domain from day one at no extra cost.

---

### 5.5 GitBook

**How it works:**  
GitBook is a hosted documentation platform. You write content in their web editor (or via Git Sync), and GitBook hosts and renders it.

**Free tier (2025–2026):**

- ✅ Free "Basic" plan for a single user
- ✅ Public documentation
- ❌ **No custom domain** on free plan (stuck on `gitbook.io` subdomain)
- ❌ **Single user only** — any team collaboration requires $65+/month
- ❌ No AI features on free plan
- ❌ Platform lock-in (docs are in GitBook's database unless Git Sync is used)

**Verdict for ctrlyoke:** GitBook's free tier is just barely viable (single user public docs on a `.gitbook.io` subdomain). The moment custom domain or any collaboration is needed, the cost jumps dramatically. **Not recommended** given that free alternatives (VitePress + GitHub Pages) are superior in every way for this use case.

---

### 5.6 Mintlify

**How it works:**  
Mintlify is a premium AI-powered docs platform targeted at developer tools/API companies. Content is MDX-based, lives in your repo, and Mintlify's CI pipeline builds and hosts it.

**Free tier (2026):**

- ✅ "Hobby" plan is free for 1 user
- ✅ Custom domain included on free plan (rare among competitors!)
- ❌ **No AI tools** on free plan
- ❌ **No team collaboration** on free plan
- Pro plan is **$300/month** — a steep jump

**Verdict for ctrlyoke:** Mintlify's Hobby plan is surprisingly generous (free + custom domain), and the output looks exceptional. It is worth evaluating as an alternative to VitePress if visual polish is a priority and the project remains single-author. However, the pricing cliff at the first seat means it is risky to build on if the project grows. **Viable secondary option** but not the primary recommendation.

---

### 5.7 Platform Comparison Matrix

| Criterion               | ReadTheDocs  | VitePress + GitHub Pages | Docusaurus + GitHub Pages | GitBook            | Mintlify (Hobby) |
| ----------------------- | ------------ | ------------------------ | ------------------------- | ------------------ | ---------------- |
| **Cost (public/OSS)**   | Free (ads)   | ✅ Free                  | ✅ Free                   | Free (limitations) | Free (1 user)    |
| **Custom domain**       | Paid only    | ✅ Free (CNAME)          | ✅ Free (CNAME)           | Paid               | ✅ Free          |
| **TypeScript/Node fit** | Poor         | ✅ Excellent             | ✅ Excellent              | N/A                | ✅ Good          |
| **Setup effort**        | Medium       | Low                      | Medium                    | Low                | Low              |
| **Built-in search**     | ✅ Yes       | ✅ Local                 | ✅ Local                  | ✅ Yes             | ✅ Yes           |
| **Versioning**          | ✅ Excellent | Manual                   | ✅ Excellent              | Limited            | Limited          |
| **Auto-build from git** | ✅ Yes       | Via GitHub Actions       | Via GitHub Actions        | ✅ Yes (Git Sync)  | ✅ Yes           |
| **Docs in repo**        | ✅ Yes       | ✅ Yes                   | ✅ Yes                    | Git Sync option    | ✅ Yes           |
| **Visual polish**       | OK           | ✅ Excellent             | Good                      | ✅ Excellent       | ✅ Excellent     |
| **Dark mode**           | Limited      | ✅ Built-in              | ✅ Built-in               | ✅ Yes             | ✅ Yes           |
| **Scale ceiling**       | High         | High                     | Very High                 | High               | Medium           |
| **Team collaboration**  | Via git PRs  | Via git PRs              | Via git PRs               | Paid               | Paid             |

---

## 6. Recommendation with Rationale

### Primary Recommendation: VitePress + GitHub Pages + Custom Subdomain

**Use VitePress deployed to GitHub Pages, served at `docs.yoursite.com`.**

#### Why VitePress over alternatives

1. **Zero cost, forever.** No pricing cliffs, no ads, no account upgrades required. The entire docs infrastructure is markdown files in the repo + a GitHub Actions workflow.

2. **Same ecosystem.** ctrlyoke's webview is already built with Vite. The team (currently one person) is deeply familiar with the Vite/Node.js toolchain. VitePress is configured in TypeScript and integrates naturally.

3. **Docs-as-code without friction.** Docs live in the repo root (`/docs/`), version with the code, appear in PRs alongside code changes, and get tagged with releases. This is how modern open-source projects work.

4. **Excellent out-of-the-box experience.** VitePress's default theme requires near-zero configuration to look professional — dark mode, clean typography, collapsible sidebar, search, and mobile responsiveness are all included.

5. **GitHub Actions deployment is trivially simple.** 30 lines of YAML deploys the site on every push to `main`. Compare to ReadTheDocs which requires Python tooling even for non-Python projects.

6. **Algolia DocSearch is free for public OSS.** Once the project has enough content, Algolia DocSearch (server-side search, much better than local search) is available for free to open-source documentation sites. Apply at algolia.com/docsearch.

7. **Custom domain is free.** A `CNAME` file and a DNS record at your registrar are all that's needed to serve at `docs.yoursite.com`.

#### Why not ReadTheDocs

Non-Python project fitting a Python-native tool creates unnecessary complexity. MkDocs works technically, but the toolchain friction (Python `requirements.txt` alongside a Node.js project) is a maintenance burden without meaningful benefit, and ads on the free tier look unprofessional for a commercial extension.

#### Why not Docusaurus

Right tool, wrong scale. Docusaurus is better when there's complex versioning, a plugin ecosystem, or multiple contributors. At ctrlyoke's current stage (pre-release, single author), the added configuration overhead doesn't pay off. This is a decision to revisit at v1.0 if docs grow substantially.

#### Why not GitBook or Mintlify

GitBook's free tier has the custom domain locked behind the paid plan. Mintlify's free tier is viable but its pricing cliff creates risk. VitePress with GitHub Pages is superior on every dimension that matters for a solo-maintained OSS extension.

#### Future Upgrade Path

If ctrlyoke eventually needs versioned docs (maintaining docs for v0.x and v1.x simultaneously), migrating from VitePress to Docusaurus is straightforward — both use Markdown files, and the content is 1:1 transferable. The migration can happen when the complexity is needed, not before.

---

## 7. Proposed Documentation Structure

### Repository Layout

**Current state as of March 2026:** `docs/` is empty and ready for VitePress. Internal developer docs have been moved to `dev/` following the backlog → active → implemented → research → reference convention.

```
ctrlyoke/
├── docs/                          # VitePress root (currently empty — ready to scaffold)
│   ├── .vitepress/
│   │   ├── config.ts              # Nav, sidebar, theme config
│   │   └── theme/                 # Optional: custom theme overrides
│   ├── public/                    # Static assets (favicon, OG image)
│   ├── index.md                   # Docs landing page
│   │
│   ├── guide/                     # Getting started + concepts
│   │   ├── index.md               # Guide overview
│   │   ├── installation.md
│   │   ├── quick-start.md
│   │   ├── your-first-workflow.md
│   │   ├── concepts.md            # Harnesses, prompts, end conditions explained
│   │   └── workflow-from-existing-project.md
│   │
│   ├── harnesses/                 # Per-harness documentation
│   │   ├── index.md               # Harness overview + comparison table
│   │   ├── copilot-cli.md         # Default harness
│   │   ├── claude-cli.md          # Anthropic Claude Code CLI
│   │   ├── codex-cli.md           # OpenAI Codex CLI
│   │   ├── opencode-cli.md        # OpenCode multi-provider CLI
│   │   ├── qwen-cli.md            # Qwen Code CLI
│   │   └── antigravity-cli.md     # Google Antigravity CLI
│   │
│   ├── pro/                       # Licensing + remote/mobile access (PRO_LICENSE_PLAN.md)
│   │   ├── index.md               # Who needs a license?, pricing/threshold, online + air-gapped activation
│   │   └── mobile-setup.md        # PWA install (Android + iOS), HTTPS/cert requirement, Tailscale option
│   │
│   ├── workflows/                 # Workflow authoring guide
│   │   ├── index.md               # Workflow file overview
│   │   ├── yaml-format.md         # YAML syntax deep dive
│   │   ├── json-format.md         # JSON alternative
│   │   ├── prompt-md-format.md    # Simple .prompt.md format
│   │   ├── session-management.md  # resumeSession, sessionId
│   │   ├── context-files.md       # @path and #selection: references
│   │   ├── end-conditions.md      # Script validation, retries
│   │   ├── agents-and-skills.md   # agent, skills, defaultAgent, defaultSkills
│   │   └── dynamic-queue.md       # enableDynamicQueue, MCP queue extension
│   │
│   ├── reference/                 # Schema + API reference
│   │   ├── workflow-schema.md     # Full property list (hand-maintained initially)
│   │   ├── settings.md            # All VS Code settings documented
│   │   ├── commands.md            # All command palette commands
│   │   └── mcp-tools.md           # ctrlyoke_queue_status, ctrlyoke_append_queue
│   │
│   ├── cli/                       # CLI binary documentation
│   │   ├── index.md               # CLI overview
│   │   ├── ctrlyoke.md            # ctrlyoke run + ctrlyoke validate commands
│   │   └── ctrlyoke-mcp.md        # MCP server usage
│   │
│   ├── examples/                  # Example workflows
│   │   ├── index.md
│   │   ├── code-review-workflow.md
│   │   ├── test-driven-development.md
│   │   ├── multi-step-refactor.md
│   │   └── agent-customization.md
│   │
│   └── troubleshooting/
│       ├── index.md
│       ├── common-errors.md
│       └── faq.md
│
├── dev/                           # Internal developer docs (NOT deployed)
│   ├── active/                    # Plans currently in-flight
│   ├── backlog/                   # Unimplemented feature plans
│   ├── implemented/               # Post-implementation design docs + ADRs
│   ├── research/                  # Investigations and CLI flag research
│   └── reference/                 # Internal quick-reference sheets, schemas, data files
│
├── .github/
│   └── workflows/
│       ├── docs-deploy.yml        # Deploy docs to GitHub Pages
│       └── ...                    # Existing CI workflows
│
├── README.md                      # VS Code Marketplace page (landing page style)
├── CHANGELOG.md                   # Release history
└── ...
```

### Navigation Structure (VitePress Sidebar)

```typescript
// docs/.vitepress/config.ts (sidebar section)
sidebar: [
  {
    text: "Getting Started",
    items: [
      { text: "What is ctrlyoke?", link: "/guide/" },
      { text: "Installation", link: "/guide/installation" },
      { text: "Quick Start", link: "/guide/quick-start" },
      { text: "Your First Workflow", link: "/guide/your-first-workflow" },
      { text: "Core Concepts", link: "/guide/concepts" },
    ],
  },
  {
    text: "Writing Workflows",
    items: [
      { text: "Overview", link: "/workflows/" },
      { text: "YAML Format", link: "/workflows/yaml-format" },
      { text: "Session Management", link: "/workflows/session-management" },
      { text: "Context & Files", link: "/workflows/context-files" },
      { text: "Agents & Skills", link: "/workflows/agents-and-skills" },
      { text: "End Conditions", link: "/workflows/end-conditions" },
      { text: "Dynamic Queue", link: "/workflows/dynamic-queue" },
    ],
  },
  {
    text: "Harnesses",
    items: [
      { text: "Overview", link: "/harnesses/" },
      { text: "Copilot CLI", link: "/harnesses/copilot-cli" },
      { text: "Claude CLI", link: "/harnesses/claude-cli" },
      { text: "Codex CLI", link: "/harnesses/codex-cli" },
      { text: "OpenCode CLI", link: "/harnesses/opencode-cli" },
      { text: "Qwen Code CLI", link: "/harnesses/qwen-cli" },
      { text: "Antigravity CLI", link: "/harnesses/antigravity-cli" },
    ],
  },
  {
    text: "Pro / Remote Access",
    items: [
      { text: "Licensing Overview", link: "/pro/" },
      { text: "Mobile & PWA Setup", link: "/pro/mobile-setup" },
    ],
  },
  {
    text: "Examples",
    link: "/examples/",
  },
  {
    text: "Reference",
    items: [
      { text: "Workflow Schema", link: "/reference/workflow-schema" },
      { text: "Extension Settings", link: "/reference/settings" },
      { text: "Commands", link: "/reference/commands" },
      { text: "MCP Tools", link: "/reference/mcp-tools" },
    ],
  },
  {
    text: "CLI",
    items: [
      { text: "Overview", link: "/cli/" },
      { text: "ctrlyoke", link: "/cli/ctrlyoke" },
      { text: "ctrlyoke-mcp", link: "/cli/ctrlyoke-mcp" },
    ],
  },
  {
    text: "Troubleshooting",
    link: "/troubleshooting/",
  },
];
```

---

## 8. VS Code Marketplace README Strategy

### Principle: Marketplace README = Marketing Page, Not Manual

The `README.md` shown on the VS Code Marketplace is a **first impression**, not a reference document. Someone browsing the Marketplace has 15 seconds before they decide to install or move on. Structure accordingly.

### Recommended README Structure

```markdown
# ctrlyoke — AI Workflow Automation for VS Code

> Automate GitHub Copilot, Claude Code, Codex, OpenCode, Qwen Code, and Gemini
> with structured prompting workflows. Run multi-step AI tasks sequentially, validate
> results with scripts, and pick up where you left off.

[Hero GIF showing a workflow running end-to-end]

## ✨ What It Does

[3-5 bullet points. Benefits, not features. What problem does it solve?]

## 🚀 Quick Start

[The absolute minimal path from install to first result — 5 steps max.
Link out to full docs for anything beyond basics.]

## 📋 Workflow Example

[A short, realistic .ctrlyoke.yaml example with syntax highlighting.
Show exactly what a user would type.]

## 🔧 Harnesses (AI Backends)

[Brief table: Harness | Requires | Notes]

## ⚙️ Key Settings

[Table of the 3–5 most important settings with their defaults.]

## 📖 Documentation

Full documentation: **[docs.yoursite.com](https://docs.yoursite.com)**

## 🐛 Issues & Feedback

[Link to GitHub Issues]

## 📄 License

MIT
```

### What to Exclude from README.md

Do **not** include in the Marketplace README:

- The full YAML schema property list (→ reference docs)
- Detailed harness configuration (→ harness pages)
- CLI usage (→ CLI docs page)
- Architecture diagrams (→ DEVELOPMENT.md or docs)
- Changelog (→ CHANGELOG.md, already separate)

The goal is: **install → understand in 2 minutes → see value → link to more**.

### README Images

- Use high-quality animated GIFs or MP4 demos (vs raw screenshots).
- Host images in the repo under `/images/` and reference them via the raw GitHub URL in README.md. For Marketplace rendering, relative paths work when the extension is packaged.
- Recommended: a GIF showing the dashboard, a GIF showing a workflow executing, and a GIF showing end-condition retry behavior.
- Ideal dimensions: 1200×675px (16:9) for hero images.

---

## 9. JSON Schema Reference Strategy

### The Opportunity

ctrlyoke already has `/schemas/workflow-schema.json` — a machine-readable definition of every workflow property. This is the single source of truth for the format and should drive documentation, not be duplicated by hand.

### Approach 1: Auto-Generate Markdown from JSON Schema (Recommended)

Use `@adobe/jsonschema2md` (npm) to convert `workflow-schema.json` into structured Markdown automatically:

```bash
npm install -D @adobe/jsonschema2md
npx jsonschema2md -d schemas/ -o docs/reference/schema-generated/
```

**Workflow:** Run this as a build step when schema changes. The generated markdown becomes the base for the reference page, potentially with a wrapper template that adds navigation and examples.

**Pros:**

- Single source of truth — schema changes automatically propagate to docs
- Zero manual maintenance of property tables

**Cons:**

- Generated markdown can be dry/mechanical — needs human-written preamble and examples
- Output format may need cleanup/templating

### Approach 2: Embed Live Schema Viewer (Advanced)

VitePress supports Vue components, which means a JSON Schema viewer component can be embedded directly in the reference page. Libraries like `@json-schema-org/vue-schema-viewer` or a custom CodeMirror viewer can render the schema interactively. This is high-effort but gives users a browsable, searchable live reference.

### Approach 3: Hand-Maintained Reference Page (Simplest, Acceptable)

A hand-maintained `reference/workflow-schema.md` with a table per section (top-level fields, `endCondition` object, per-prompt fields). This has maintenance risk but gives full control over presentation and examples.

### Recommendation

Start with **Approach 3** (hand-maintained) for launch, with a plan to automate via Approach 1 once the schema stabilizes. The schema is still evolving pre-release, and auto-generated docs would need frequent regeneration during that period.

Include a prominent note in the docs page: "This page reflects schema version X.Y. The canonical schema with full validation is `schemas/workflow-schema.json` in the repository."

---

## 10. CLI `--help` and Hosted Docs Relationship

### Design Principle

`--help` answers "how do I use this command right now," not "why does this exist." Hosted docs answer both. They should be complementary, not redundant.

### `--help` Contents (per command)

```
ctrlyoke run <workflow-file>

  Execute a prompt or workflow file.

  Arguments:
    workflow-file   Path to a .ctrlyoke.yaml, .ctrlyoke.json, or .prompt.md file

  Options:
    -H, --harness <id>      AI harness: copilot-cli (default), claude-cli, codex-cli,
                            opencode-cli, qwen-cli, antigravity-cli
    -m, --model <name>      Override the AI model
    --headless              Force headless mode (CI/CD, no user interaction)
    --interactive           Force interactive mode (TUI passthrough)
    --allow-tool <pattern>  Allow specific tool pattern (repeatable)
    --deny-tool <pattern>   Deny specific tool pattern (repeatable)
    --allow-all-tools       Dangerously allow all tools without approval
    -p, --prompt <text>     Inline prompt string (alternative to file)
    --resume <session-id>   Resume an existing session by ID
    -t, --timeout <s>       Global timeout in seconds (default: 3600)
    --json                  Output results as JSON
    -q, --quiet             Suppress all output except errors
    --verbose               Show debug information
    -h, --help              Show this help message

  Examples:
    ctrlyoke run .ctrlyoke/workflows/refactor.ctrlyoke.yaml
    ctrlyoke run my-prompt.prompt.md --harness claude-cli
    ctrlyoke run workflow.yaml --headless --json

  Documentation: https://docs.yoursite.com/cli/ctrlyoke
```

The CLI also exposes a `validate` command:

```
ctrlyoke validate <file>

  Validate a prompt file without executing it.

  Documentation: https://docs.yoursite.com/cli/ctrlyoke
```

**Rules for `--help` text:**

- Every option must have a description.
- Include at least one example.
- End with a `Documentation:` line that links to the full hosted page.
- Keep it under ~40 lines per command.

### Hosted CLI Docs Contents

Each CLI page should include:

- Full command synopsis
- All flags with types, defaults, and allowed values
- Extended description of behavior
- Multiple real-world examples
- Cross-links to related workflow schema properties

---

## 11. Implementation Steps

### Phase 1 — Foundation

**Goal:** Get a basic VitePress site live at GitHub Pages.

**Current status:** `docs/` is already empty and ready — internal docs have been moved to `dev/`. Steps 1–3 below are the remaining work.

1. **Install VitePress:**

   ```bash
   npm install -D vitepress
   ```

2. **Scaffold docs directory:**

   ```bash
   npx vitepress init
   # Choose docs/ as the root, set site title to "ctrlyoke"
   ```

3. **Add npm scripts to package.json:**

   ```json
   "docs:dev": "vitepress dev docs",
   "docs:build": "vitepress build docs",
   "docs:preview": "vitepress preview docs"
   ```

4. **Create `.github/workflows/docs-deploy.yml`** (see template in Section 5.2)

5. **Create stub content pages** (empty sections with just headings and "Coming soon") for all planned pages — this establishes the navigation structure immediately.

6. **Deploy first version** — even if it's mostly stubs, getting it live validates the pipeline.

7. **Set up custom domain** — configure `docs.yoursite.com` CNAME to GitHub Pages in DNS settings, add `CNAME` file to `docs/public/`.

**Estimated effort:** 2–4 hours including DNS propagation wait.

---

### Phase 2 — Core Content

**Goal:** Cover the must-have docs so the extension is publishable with real documentation.

Priority order:

1. `guide/installation.md` — How to install
2. `guide/quick-start.md` — First workflow in 5 minutes
3. `guide/concepts.md` — Harnesses, prompts, end conditions explained in plain language
4. `guide/your-first-workflow.md` — Step-by-step tutorial with a realistic example
5. `harnesses/index.md` — Comparison table, choose the right harness (all 7 covered)
6. `harnesses/copilot-cli.md` + `harnesses/claude-cli.md` — The two most common harnesses
7. `reference/settings.md` — All 30+ settings documented with defaults
8. `reference/workflow-schema.md` — All YAML properties documented with types, defaults, examples
9. `troubleshooting/common-errors.md` — The top 5–10 errors new users hit

**Source material:** `QUICK_START.md`, `README.md`, and the following `dev/` docs are the primary inputs:

- `dev/implemented/PROMPT_SYNTAX.md` — YAML format, context refs, schema properties
- `dev/implemented/SESSION_MANAGEMENT.md` — resumeSession, sessionId
- `dev/implemented/END_CONDITIONS.md` — script validation, retries
- `dev/implemented/WORKFLOW_PROPERTIES.md` — all prompt + workflow properties
- `dev/implemented/QUEUE_APPEND_FEATURE.md` — dynamic queue / MCP extension
- `dev/implemented/GLOBAL_AGENT_INCLUSION.md` — agents and skills system
- `dev/implemented/COPILOT_CLI_DESIGN.md`, `CLAUDE_CLI_DESIGN.md`, `OPENCODE_HARNESS.md`, `GEMINI_INTEGRATION_PLAN.md`, `QWEN_INTEGRATION_PLAN.md` — per-harness pages

---

### Phase 3 — Polish for Marketplace Launch

**Goal:** README.md is launch-ready; docs are complete enough to not embarrass.

1. **Rewrite README.md** following the Marketplace README structure in Section 8.
2. **Create hero GIF** demonstrating the dashboard and a workflow running.
3. **Complete all harness pages.**
4. **Add at least 2–3 examples** with full workflow YAML.
5. **Add Algolia DocSearch** (apply at algolia.com/docsearch once the site has content).
6. **Configure `package.json` `markdownDescription`** for all settings (links to docs pages).
7. **Add JSON Schema `description` fields** for all workflow properties (they become hover docs in VS Code).
8. **Write `docs/pro/`** — this is the documentation for [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md)'s
   entire feature (remote/on-the-go access is essentially the one thing Pro sells; see that plan's §1.6
   "governing test"). Gate on `PRO_LICENSE_PLAN.md` Phase 1 shipping since the flows being documented
   (activation, remote bind, cert generation) don't exist before then.
   - `pro/index.md` — who needs a license (the revenue/employee threshold), pricing, **online**
     activation (paste key) and **air-gapped** activation (import signed license file), per
     `PRO_LICENSE_PLAN.md` §1.5.
   - `pro/mobile-setup.md` — the exact steps to configure remote/PWA access, covering all three real
     access paths so a reader picks the right one instead of defaulting to the least secure:
     1. **Same-LAN via QR code** — `ServerSection.tsx`'s bind-address/LAN-IP-selector/QR-to-phone flow,
        step by step, Android and iOS covered separately since "Add to Home Screen" (iOS Safari) vs.
        "Install app" (Android Chrome) are different flows.
     2. **HTTPS is not optional caveat** — self-signed cert generation, and the iOS-specific manual
        cert-trust walkthrough (`Settings → General → VPN & Device Management` → enable full trust,
        already drafted in `ServerSection.tsx`'s own copy) needs to be spelled out in full, not just
        summarized, since it's the step users get stuck on. Explain _why_: per `PRO_LICENSE_PLAN.md`
        §1.6, HTTPS is a no-op on localhost (already a secure context) and only starts mattering the
        moment a phone or LAN device reaches the server — frame it as "required once you leave your own
        machine," not as a generic security tip.
     3. **Tailscale (or another mesh VPN) for true off-LAN remote access** — recommend this over opening
        a router port / binding wider than the LAN for anyone who wants to reach ctrlyoke from outside
        their home network. `PRO_LICENSE_PLAN.md` §1.8 already treats a Tailscale Funnel/reverse-proxy
        setup as a legitimate Pro deployment (it's in the accepted-proxy list) — this page is where that
        gets surfaced to users as guidance instead of staying an internal threat-model note.
   - **Screenshots/GIFs:** sourced from `SCREENSHOTS_AND_MEDIA_PLAN.md` item **#7**, which scripts both
     the iOS recording (QR scan → Safari → Add to Home Screen → take control) and the separate Android
     recording (QR scan → Chrome → its own install affordance → take control) — real devices only, no
     emulators — plus item **#10** (mobile-width stills of `WorkspaceViewerModal`/`WorkspaceDiffPane`,
     category H).

---

### Phase 4 — Ongoing Maintenance

- Every new feature PR should include a docs update in the same PR.
- Every new setting added to `package.json` → update `reference/settings.md`.
- Every schema change → update `reference/workflow-schema.md`.
- Add a docs PR template checklist item: "Docs updated?"
- CHANGELOG.md is already in the repo — link to it from the docs site.

---

## 12. Versioning & Maintenance Considerations

### Pre-Release Phase (Current)

During pre-release, a single `latest` version of docs is appropriate. No versioning needed. All docs live in `main` branch.

### When Versioning Becomes Necessary

Versioned docs (maintaining separate published docs for v0.x and v1.x) are needed when:

- The YAML schema has **breaking changes** between versions
- Significant numbers of users are on older versions
- The extension supports VS Code version ranges that have different capabilities

Until these criteria are met, document the current version only and link to the CHANGELOG for version history.

### Version Banner Strategy

When a major version ships, use VitePress's built-in banner feature to show a notice on old content:

```typescript
// docs/.vitepress/config.ts
banner: {
  dismissable: false,
  content: '⚠️ You are viewing v0.x documentation. <a href="/v1/">View v1.0 docs →</a>'
}
```

### Content Maintenance Red Flags

Watch for these doc rot patterns:

- Settings listed in docs that no longer exist in `package.json`
- Harness IDs in docs that differ from `DashboardConstants.HARNESS_IDS`
- Schema properties documented that are not in `schemas/workflow-schema.json`
- CLI flags documented that are not in the CLI implementation

**Mitigation:** Create a simple CI check script (`scripts/validate-docs.js`) that reads `package.json` settings and compares against docs. Run it in the GitHub Actions pipeline.

### Migration from Existing Docs Content

**Done.** As of March 2026, the internal developer docs have been moved out of `docs/` into `dev/` using the following convention:

| Folder             | Contents                                                        |
| ------------------ | --------------------------------------------------------------- |
| `dev/active/`      | Plans currently being executed (including this file)            |
| `dev/backlog/`     | Unimplemented feature plans and proposals                       |
| `dev/implemented/` | Post-implementation design docs and decision records            |
| `dev/research/`    | Investigations, CLI flag research, external tool analyses       |
| `dev/reference/`   | Internal quick-reference sheets, log format schemas, data files |

`docs/` is now empty and reserved exclusively for the VitePress user-facing documentation.

---

## Summary

| Decision               | Recommendation                                                                   |
| ---------------------- | -------------------------------------------------------------------------------- |
| **Hosting platform**   | VitePress + GitHub Pages                                                         |
| **Custom domain**      | `docs.yoursite.com` (CNAME to GitHub Pages)                                      |
| **Search**             | VitePress built-in (local); graduate to Algolia DocSearch when eligible          |
| **Versioning**         | None initially; adopt Docusaurus if versioning becomes critical                  |
| **Marketplace README** | Landing page style (GIFs, quick start, link to full docs)                        |
| **Schema reference**   | Hand-maintained initially; auto-generate with `jsonschema2md` post-stabilization |
| **CLI help text**      | Self-contained synopsis + examples per command, `Documentation:` link at end     |
| **GitBook**            | Skip                                                                             |
| **ReadTheDocs**        | Skip (Python-centric, ads on free)                                               |
| **Mintlify**           | Viable fallback if visual polish is critical and author stays solo               |
| **Internal docs**      | ✅ Done — moved to `dev/` (backlog/active/implemented/research/reference)        |

The total infrastructure cost of this approach for the lifetime of the project is **$0**, the build pipeline is under 50 lines of YAML, and every doc page is a Markdown file that lives next to the code it documents.
