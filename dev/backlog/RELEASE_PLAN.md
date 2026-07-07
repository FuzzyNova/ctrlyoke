# ctrlyoke v0.1.0 Release Plan

**Created:** March 11, 2026
**Updated:** July 4, 2026
**Status:** BLOCKED — functional + licensing + cutover work remain before publish (see Phase 2)
**Target:** VS Code Marketplace public release first; npm CLI package after the extension release path is settled.

> **July 4, 2026 review.** Package/metadata readiness (Phase 1) is done, but a backlog review surfaced blockers that were not previously tracked in this plan. The remaining ship gate is no longer just the mechanical publish checklist — it now includes one **functional** blocker (a broken harness shipping to users) and two work-streams tracked in sibling docs that this plan had omitted (Pro licensing implementation, and the ctrlyoke external cutover). These are consolidated in Phase 2 below so this stays the single "what's left" doc.

---

## Current State

This plan was refreshed against the current repository state on June 19, 2026.

The original critical testing work is complete:

- [x] Release package built: `ctrlyoke-0.1.0.vsix` exists at repo root.
- [x] Release package has been installed and used on macOS.
- [x] Release package has been installed and used on Linux.
- [x] Dashboard/webview works from the packaged VSIX on tested platforms.
- [x] Platform-sensitive runtime areas have been exercised in real use: PTY execution, file paths, file watching, `.ctrlyoke/` workspace state, prompt execution, and packaged webview assets.

Codebase-backed release facts:

- `package.json` version is `0.1.0`.
- `package.json` publisher is `fuzzynova`.
- `package.json` repository/homepage/bugs URLs point to `https://github.com/FuzzyNova/ctrlyoke` and `https://ctrlyoke.dev`.
- `package.json` license is `Elastic-2.0` (placeholder — to be replaced with custom commercial EULA before launch; see §2.3).
- `package.json` has current marketplace metadata: improved description, categories, keywords, and gallery banner.
- `package.json` contributes both bins: `ctrlyoke-mcp` and `ctrlyoke`, but `.vscodeignore` intentionally excludes `out/cli.js` from the VSIX.
- `.vscodeignore` is now allowlist-based and includes the extension bundle, MCP server, webview assets, schemas, templates, runtime scripts, `resvg.wasm`, and `node-pty`.
- `CHANGELOG.md` has a populated `[0.1.0] - 2026-05-12` release entry.
- `README.md` documents seven harnesses, currently including `gemini-cli`. **This list is now wrong:** `gemini-cli` is broken (Google deprecated it) and is being replaced by `antigravity-cli` — see §2.5. README/CHANGELOG/docs must be corrected as part of that item before publish.

Related launch/business planning now lives in [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md). Licensing and commercial terms are tracked in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md).

---

## Release Decision

**Identity decision: made (June 2026).** Publisher is `fuzzynova`, GitHub org is `FuzzyNova/ctrlyoke`, product domain is `ctrlyoke.dev`, support inbox is `support@ctrlyoke.dev`. All `package.json` fields and README updated.

**License decision: made (June 2026).** Custom commercial EULA (source-available, $10M revenue / 250-employee threshold), not Elastic-2.0. Pro licensing via Keygen at launch. Draft at [`LICENSE_DRAFT.md`](LICENSE_DRAFT.md); requires attorney review before publish.

---

## Phase 1 - Completed Release Readiness

### 1.1 Production Build and Manual Platform Testing

**Status:** DONE

- [x] Built `ctrlyoke-0.1.0.vsix`.
- [x] Installed the VSIX locally.
- [x] Used the packaged extension on macOS.
- [x] Used the packaged extension on Linux.
- [x] Verified dashboard loads from packaged assets.
- [x] Verified normal workflow use from the packaged extension.

### 1.2 CHANGELOG

**Status:** DONE

`CHANGELOG.md` now has a real `0.1.0` entry covering:

- Seven harnesses
- Parallel workflow execution
- React dashboard with CodeMirror
- End conditions and retries
- MCP queue extension
- Agents and skills
- Prompt completions
- Output history
- Templates
- CLI and MCP binaries
- Session management, diff view, and stale-state recovery

### 1.3 Marketplace Metadata

**Status:** MOSTLY DONE

Already present in `package.json`:

- [x] Improved description
- [x] Categories include `Other`, `Machine Learning`, and `Programming Languages`
- [x] Keywords exist
- [x] Gallery banner exists
- [x] Icon exists at `images/icon.png`

Still open:

- [x] ~~Decide publisher~~ — resolved: `fuzzynova` (see §2.1). The old `nhickster` reference is dead.
- [x] ~~Update repository/homepage/bugs URLs~~ — `package.json` already points at `FuzzyNova/ctrlyoke` + `ctrlyoke.dev`. **Caveat:** these URLs 404 until the external cutover lands (see §2.7).
- [x] ~~Update support/contact URLs~~ — README/site use `support@ctrlyoke.dev`. **Caveat:** the inbox must exist before launch (see §2.7).

### 1.4 VSIX Contents

**Status:** DONE

`.vscodeignore` now uses an allowlist. The VSIX should include runtime assets and exclude source/development files by default.

Expected included runtime assets:

- `package.json`, README, CHANGELOG, LICENSE, QUICK_START
- `images/*` icons referenced by contributions
- `out/extension.js`
- `out/mcp-server.js`
- `out/resvg.wasm`
- `out/templates/**`
- `out/schemas/**`
- `out/scripts/*.js`
- `out/server/standalone-shim.js`
- `out/ui/webview-scripts/*.js`
- `out/ui/webview-react/**` runtime assets
- `node_modules/node-pty/**`
- `node_modules/node-addon-api/**`

Expected excluded runtime asset:

- `out/cli.js` - the standalone npm CLI path, not bundled in the VS Code extension package.

---

## Phase 2 - Remaining Pre-Publish Blockers

### 2.1 Publisher and Identity

**Status:** DONE

- [x] Complete Phase 0 of [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md): business email, support inbox, vendor ownership, and publisher identity.
- [x] Publisher: `fuzzynova` (VS Code Marketplace publisher created under `admin@fuzzno.com`).
- [x] `package.json#publisher` → `fuzzynova`
- [x] `package.json#repository.url` → `https://github.com/FuzzyNova/ctrlyoke`
- [x] `package.json#homepage` → `https://ctrlyoke.dev`
- [x] `package.json#bugs.url` → `https://github.com/FuzzyNova/ctrlyoke/issues`
- [x] README support section updated with `support@ctrlyoke.dev` and `ctrlyoke.dev`

### 2.2 README Requirements Mismatch

**Status:** DONE

- [x] Decision: keep `^1.104.0` (no tested reason to lower it).
- [x] README updated to `VS Code 1.104.0 or higher` — matches `package.json#engines.vscode`.

### 2.3 License and Commercial Terms

**Status:** DECISION MADE — awaiting attorney review

Decisions recorded (June 2026):

- **Custom commercial EULA** — not Elastic-2.0, not BSL. Source-available; bespoke terms.
- **Source-available** — public repo, visible source, governed by the custom EULA. Code visibility builds trust for a tool that drives AI over user codebases; Pro protection comes from legal terms + Keygen's offline crypto, not source secrecy.
- **Commercial threshold** — $10M USD annual revenue OR 250 employees (Docker's line). Organizations above this threshold must purchase Pro licenses even for free-tier features.
- **Pro licensing at launch** — Keygen offline Ed25519-signed licenses via Lemon Squeezy storefront. See [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md).

Open:

- [ ] Attorney reviews and finalizes [`LICENSE_DRAFT.md`](LICENSE_DRAFT.md).
- [ ] Replace `LICENSE` with final custom EULA text.
- [ ] Update `package.json#license` to `SEE LICENSE IN LICENSE.md`.
- [ ] Publish `ctrlyoke.dev/terms` (web-facing copy + plain-language summary).

### 2.4 Final Package Inspection

**Status:** OPEN

Run immediately before publishing:

```bash
npm run package
npx vsce ls
```

Confirm:

- [ ] `out/ui/webview-react/` assets are included.
- [ ] `out/mcp-server.js` is included.
- [ ] `out/cli.js` is not included.
- [ ] `node_modules/node-pty/` is included.
- [ ] `.ctrlyoke/`, `.agents/`, local logs, prompts, test logs, and dev-only files are not included.
- [ ] The generated VSIX version is `0.1.0`.

### 2.5 Broken Harness — Remove Gemini, Add Antigravity CLI

**Status:** OPEN — **functional blocker**

Google deprecated the Gemini CLI; the `gemini-cli` harness now **errors on invocation**, so any user who selects Gemini in a shipped v0.1.0 hits a hard failure. Shipping a harness that always fails is a release blocker, not a post-launch item.

Tracked in detail by [`ANTIGRAVITY_CLI_HARNESS_PLAN.md`](ANTIGRAVITY_CLI_HARNESS_PLAN.md). Decision: **remove `gemini-cli` entirely** and add the `antigravity-cli` (`agy`, Google's replacement) harness in its place.

- [ ] Resolve the two research blockers first (headless `-p` viability under `PtyProcessManager`/node-pty; workspace `.agents/mcp_config.json` loading on `agy` ≥ 1.0.14).
- [ ] Add the `antigravity-cli` harness (provider, plain-text parser, glog/`last_conversations.json` session resolution, Claude-style `Stop` hook, MCP writer, permission mapper, hook script) — Part B of the plan.
- [ ] Remove `gemini-cli` everywhere (~110 refs across ~20 `src` files, plus schemas/tests/docs) — Part C.
- [ ] `npm run typecheck` + `npm run compile` + `npm test` clean; grep `gemini` over `src/` leaves only generic hits.
- [ ] Update README, CHANGELOG, and marketplace copy: seven harnesses become seven with Gemini→Antigravity (not eight). Every doc that currently lists Gemini must change.
- [ ] Verify docs coherence: `.github/copilot-instructions.md`, `docs/harnesses/*`, and this plan family no longer claim Gemini support.

> **Downstream doc impact:** several release docs (README "seven harnesses", `RELEASE_CHECKLIST`, ROADMAP executive summary) still enumerate Gemini as a supported harness. Those enumerations are now wrong and must be corrected as part of this item before publish.

### 2.6 Pro Licensing Implementation

**Status:** OPEN — **launch blocker (was omitted from this plan)**

The live site already advertises Free vs Pro and a pricing page, but the extension has **no license gating built** — `LicenseService`, activation, trial, and Pro gating are unstarted (Checklist Phase 4). Shipping with the website promising Pro while the extension has no free/Pro boundary is a launch inconsistency, and Phase 6 launch verification (unlicensed free path, Pro activation, air-gapped import) cannot pass until this exists.

Tracked in detail by [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md) and Phases 3–4 of [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

- [ ] Phase 3 (vendors): Keygen policy + public key, Lemon Squeezy product, webhook secret / admin token — created under the **ctrlyoke** identity (see [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md) §6–§7).
- [ ] Phase 4 (extension): `LicenseService`, offline signed-license verification, online activation, air-gapped import, 14-day trial, Pro gating, and the unlicensed/free production path.
- [ ] `ctrlyoke: Manage License` command (activation count, machine list, remote deactivate).
- [ ] Set `CHECKOUT_URL` and flip `LAUNCHED = true` in `landing/src/config.ts` at go-live.

### 2.7 ctrlyoke External / Business Cutover

**Status:** OPEN — **launch blocker (external, mostly non-code)**

`package.json` `repository`/`homepage`/`bugs` and the site links already point at `FuzzyNova/ctrlyoke` + `ctrlyoke.dev`, but **those URLs 404 and the `@ctrlyoke.dev` support inboxes do not exist yet.** The business identity is still live under `flightpath.dev`. Publishing before the cutover means a marketplace listing whose repo/homepage/support links are dead.

Tracked in detail by [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md). Owner: Nathan (external dashboards).

- [ ] Stand up `ctrlyoke.dev` DNS + Netlify primary domain; 301 `flightpath.dev` → `ctrlyoke.dev`.
- [ ] Recreate the 6 product inboxes under `@ctrlyoke.dev` (esp. `support@`, `security@`, `privacy@`, `licensing@`) before launch — they're referenced in the shipped LICENSE/PRIVACY and site footer.
- [ ] Rename GitHub `FuzzyNova/flightpath` → `FuzzyNova/ctrlyoke`; confirm the `package.json` URLs resolve.
- [ ] Confirm marketplace publisher contact/branding reads ctrlyoke.

### 2.8 Legal Effective-Date Placeholders

**Status:** OPEN — **quick but required**

`LICENSE.md` and `PRIVACY.md` still contain the literal `[DATE]` placeholder, and the live `/terms` + `/privacy` pages are already serving it publicly.

- [ ] Set the real effective date in `LICENSE.md` and `PRIVACY.md` (Checklist Phase 5 / Cutover §8).
- [ ] Complete attorney review of the EULA if not already final (see §2.3).

### 2.9 New-User Experience & Built-in Content

**Status:** OPEN — **all blockers** (Nathan confirmed July 4, 2026)

A backlog review surfaced first-run / built-in-content gaps not previously tracked.
Nathan's decision: **every item below blocks v0.1.0** — the first paid release must land
a strong new-user story. The only deferred piece is the interactive tour (see note).

> **Ordering (load-bearing):** land the **Antigravity harness swap (§2.5)** and the
> **agent/template cleanup (Parts A+B)** first — they set the final harness list and
> formats. Only then author the **tech-support agent, Getting Started walkthrough, and
> preflight**, which cite harnesses/formats and would otherwise be written against stale
> facts. Capture **screenshots + GIF (§4) last**, after the onboarding/UI is final. See
> the launch-blocker sequencing diagram in `ROADMAP.md`.

- [x] **Built-in agent correctness** — DONE. `ctrlyoke-orchestrator` was renamed to
  `ctrlyoke-workflow-composer` and rewritten (YAML-first, no hardcoded/dead model IDs,
  trimmed); a new `test-repair` agent was added and wired into the `fix-tests` template;
  `spec-orchestrator` audited clean. See
  [`BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md`](BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md) Part A.
- [x] **Template variables** — DONE. Extended the variable model with `default` /
  `description` / `multiline`, then brought `simple-feature` / `full-feature` / `fix-tests`
  up to the typed `_templateMeta.variables` pattern (UI renders defaults/descriptions/
  textareas; blanks fall back to defaults). Documented in `docs/workflows/templates.md`.
  ([`BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md`](BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md) Part B)
- [ ] **`ctrlyoke-tech-support` agent** — built-in support/onboarding agent for new users.
  Support deflection for a solo launch. ([`BUILTIN_TECH_SUPPORT_AGENT_PLAN.md`](BUILTIN_TECH_SUPPORT_AGENT_PLAN.md))
- [ ] **Native VS Code Getting Started integration** — `contributes.walkthroughs` (the
  standard post-install Getting Started page most extensions use) + dashboard empty state.
  A blank cold-open hurts Marketplace first impressions. ([`ONBOARDING_TOUR_PLAN.md`](ONBOARDING_TOUR_PLAN.md) Phase 1)
- [ ] **Harness preflight** — proactively tell a user with no installed harness CLI how to
  install/auth one, instead of only failing at run time. ([`HARNESS_PREFLIGHT_PLAN.md`](HARNESS_PREFLIGHT_PLAN.md))

> **Interactive tour deferred — and possibly unnecessary.** If the native Getting Started
> walkthrough plus strong screenshots/GIF (§4, now a blocker) deliver a good first
> impression, a bespoke interactive dashboard tour (onboarding Phase 2) may not be needed
> at all. Re-evaluate after Phase 1 ships; do not hold the release for it. Harness
> auth-vs-installed distinction (preflight stretch) is likewise post-launch.

### 2.10 Pre-Publish Security Review

**Status:** IN PROGRESS — pre-publish gate

ctrlyoke spawns external processes and drives AI over the user's codebase; a first paid,
source-available release warrants a security pass before publish. **A security review is
currently running via a separate agent.**

- [ ] Complete the security review of the release branch.
- [ ] Triage findings; fix anything that blocks a trustworthy first release.

### 2.11 Standalone Server — Deferred (setting hidden for v0.1.0)

**Status:** RESOLVED — **deferred out of v0.1.0, not a blocker**

The VS Code-hosted server (`CtrlYokeHostedServer`) ships in v0.1.0. The **standalone**
`ctrlyoke server` CLI process (`STANDALONE_SERVER_PLAN.md` Phases 5–10) is **not
implemented** — no `server` CLI subcommand, no `CtrlYokeServer` / `StandaloneServerAdapter`.
Finishing it is a multi-day effort touching core orchestration (remove hard-coded
`VsCodeAdapter`, add a `PlatformAdapter` file-watcher seam, standalone router/completion
service, CLI launch UX) and does not gate a first release.

Decision (July 5, 2026): defer standalone; do not ship a non-functional control.

- [x] Hide the "Standalone port" row in `ServerSection.tsx` — the `server.standalonePort`
  setting is inert (nothing reads it) and misplaced (it configures a non-VS-Code process).
  Type/schema/default (`4748`) retained so standalone can surface it later with no config
  migration.
- [ ] Post-launch: implement `STANDALONE_SERVER_PLAN.md` Phases 5–10 and re-expose the port
  from the standalone server's own surface (not the VS Code Server section).

---

## Phase 3 - Marketplace Publish

### 3.1 Marketplace Account

- [ ] Create or verify the Marketplace publisher matching `package.json#publisher`.
- [ ] Generate an Azure DevOps PAT with Marketplace Manage scope.
- [ ] Login:

```bash
npx vsce login <publisher>
```

### 3.2 Publish

```bash
npm run package
npx vsce publish
```

If publishing from the already-built VSIX instead:

```bash
npx vsce publish --packagePath ctrlyoke-0.1.0.vsix
```

### 3.3 Post-Publish Verification

- [ ] Visit the Marketplace listing.
- [ ] Confirm README renders correctly.
- [ ] Confirm CHANGELOG tab shows `0.1.0`.
- [ ] Install from the Marketplace into a clean VS Code profile.
- [ ] Run one simple workflow from the Marketplace install.
- [ ] Confirm dev-only command `ctrlyoke: Developer Tools` is hidden unless `ctrlyoke.devMode` is set.

---

## Phase 4 - Documentation and Listing Polish

Most items here are high-value-but-optional, **except the screenshots/GIF, which Nathan
promoted to a release blocker** (July 4, 2026) — for a first paid release, marketplace/
README visuals are effectively MVP for conversion and pair with the native Getting
Started onboarding (§2.9).

- [ ] **BLOCKER:** Add polished dashboard screenshots and at least one demo GIF to `images/`,
  the README, and the Marketplace listing.
- [ ] Add `ctrlyoke.dev` links after the landing page exists.
- [ ] Add `support@ctrlyoke.dev` after the inbox exists.
- [ ] Add a short Known Issues section if carrying known harness-specific rough edges into v0.1.0.
- [ ] Confirm README install/setup instructions match the published Marketplace path.

---

## Phase 5 - GitHub Release

- [ ] Tag `v0.1.0`.
- [ ] Create GitHub Release from the `CHANGELOG.md` entry.
- [ ] Attach the final `ctrlyoke-0.1.0.vsix`.
- [ ] Make sure the GitHub release URL matches the canonical repository decision.

---

## Phase 6 - npm CLI Package

The codebase currently has a CLI entrypoint:

- `package.json#bin.ctrlyoke` -> `./out/cli.js`
- `package.json#bin.ctrlyoke-mcp` -> `./out/mcp-server.js`
- `.vscodeignore` excludes `out/cli.js` from the VSIX.

The npm CLI package should be treated as a separate release decision, not a blocker for the VS Code Marketplace release.

Open decisions:

- [ ] Decide single root package vs. dedicated CLI package.
- [ ] If using the root package for npm, add a `files` allowlist so npm does not publish the full extension repo unintentionally.
- [ ] If using a dedicated CLI package, create a separate package folder and publish pipeline.
- [ ] Confirm the `ctrlyoke` npm package name is available or choose a scoped package.
- [ ] Test with:

```bash
npm run build:prod
npm pack --dry-run
npm pack
npm install -g ./ctrlyoke-0.1.0.tgz
ctrlyoke --help
```

Recommended: defer npm publishing until after the extension Marketplace release unless a standalone CLI launch is required for v0.1.0.

---

## Phase 7 - Optional Registries and Automation

- [ ] Publish to Open VSX for VSCodium and other compatible editors.
- [ ] Add GitHub Actions for tagged VS Code releases.
- [ ] Add GitHub Actions for npm CLI releases after the CLI packaging decision is made.

---

## Summary Checklist

| Item                                       | Status        | Notes                                                                                       |
| ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------- |
| Populate `CHANGELOG.md` for `0.1.0`        | DONE          | Current changelog has a full entry                                                          |
| Build release VSIX                         | DONE          | `ctrlyoke-0.1.0.vsix` exists                                                                |
| Test package on Linux                      | DONE          | User-reported complete                                                                      |
| Test package on macOS                      | DONE          | User-reported complete                                                                      |
| Fix VSIX allowlist / webview assets        | DONE          | `.vscodeignore` is allowlist-based                                                          |
| Marketplace metadata                       | MOSTLY DONE   | Publisher/repo identity still open                                                          |
| README harness coverage                    | DONE          | All seven harnesses listed                                                                  |
| README/package VS Code version consistency | DONE          | Both say 1.104.0                                                                            |
| Business email/support identity            | DONE          | `support@ctrlyoke.dev`, DNS/DKIM/DMARC configured                                           |
| Publisher identity                         | DONE          | `fuzzynova`, repo at FuzzyNova/ctrlyoke                                                     |
| License/commercial terms                   | DECISION MADE | Custom EULA (source-available, $10M threshold); draft at `LICENSE_DRAFT.md`; needs attorney |
| **Remove Gemini / add Antigravity harness** | **OPEN**      | **Functional blocker — Gemini errors on invocation; see §2.5 / `ANTIGRAVITY_CLI_HARNESS_PLAN.md`** |
| **Pro licensing implementation**           | **OPEN**      | **Blocker — site advertises Pro; extension gating unbuilt; see §2.6 / `PRO_LICENSE_PLAN.md`** |
| **ctrlyoke external cutover**              | **OPEN**      | **Blocker — repo/homepage URLs + support inboxes 404 until done; see §2.7 / `CTRLYOKE_REBRAND_CUTOVER.md`** |
| **Legal `[DATE]` placeholders**            | **OPEN**      | **Set effective date in `LICENSE.md` + `PRIVACY.md` (live pages serve it now); see §2.8** |
| **Built-in agent correctness**             | **OPEN**      | **Blocker — orchestrator agent recommends dead models / JSON format; see §2.9**             |
| **New-user experience** (templates/support/onboarding/preflight) | **OPEN** | **Blocker — all of §2.9 confirmed as v0.1.0 gates; interactive tour deferred**            |
| **Screenshots + demo GIF**                 | **OPEN**      | **Blocker — README + Marketplace visuals; see §4**                                          |
| Pre-publish security review                | IN PROGRESS   | Running via a separate agent; triage findings before publish (§2.10)                        |
| Standalone server                          | DEFERRED      | Not a blocker; hosted server ships. Standalone `ctrlyoke server` deferred, inert setting hidden (§2.11) |
| Extension-host OOM crash                   | RESOLVED      | Confirmed fixed by Nathan — no longer a blocker                                              |
| `npm audit` sanity check                   | PRE-PUBLISH   | Down to dev-only findings (`DEPENDENCY_UPGRADE_PLAN.md`); confirm no new prod advisories     |
| Final `vsce ls` package inspection         | OPEN          | Run immediately before publish                                                              |
| Marketplace publish                        | OPEN          | Blocked on §2.5–2.8                                                                          |
| npm CLI publish                            | DEFERRED      | Separate packaging decision                                                                 |

---

## Known Issues Accepted for v0.1.0

Carry these only if they are still accurate at final publish time:

- Chat mode model switching can fail silently in VS Code and should warn rather than block execution.
- Codex headless completion detection remains sensitive to upstream JSONL/event changes.
- Webview CSP still allows inline styles for Tailwind/CodeMirror compatibility.
- Webview message payloads are trusted local extension messages, not schema-validated external input.
