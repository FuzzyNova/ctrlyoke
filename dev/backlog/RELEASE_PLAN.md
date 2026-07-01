# ctrlyoke v0.1.0 Release Plan

**Created:** March 11, 2026
**Updated:** June 25, 2026
**Status:** READY_FOR_PUBLISH_PREP
**Target:** VS Code Marketplace public release first; npm CLI package after the extension release path is settled.

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
- `README.md` documents all seven harnesses: `copilot-cli`, `claude-cli`, `codex-cli`, `opencode-cli`, `qwen-cli`, `gemini-cli`, and `copilot-chat`.

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

- [ ] Decide publisher: current `nhickster` vs. long-term business publisher.
- [ ] Update repository/homepage/bugs URLs if moving to `fuzzynova/ctrlyoke`.
- [ ] Update support/contact URLs after `support@ctrlyoke.dev` exists.

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

These are not hard blockers now that package testing is complete, but they are high-value before broad announcement.

- [ ] Add at least one dashboard screenshot or GIF to `images/` and README.
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

| Item | Status | Notes |
| --- | --- | --- |
| Populate `CHANGELOG.md` for `0.1.0` | DONE | Current changelog has a full entry |
| Build release VSIX | DONE | `ctrlyoke-0.1.0.vsix` exists |
| Test package on Linux | DONE | User-reported complete |
| Test package on macOS | DONE | User-reported complete |
| Fix VSIX allowlist / webview assets | DONE | `.vscodeignore` is allowlist-based |
| Marketplace metadata | MOSTLY DONE | Publisher/repo identity still open |
| README harness coverage | DONE | All seven harnesses listed |
| README/package VS Code version consistency | DONE | Both say 1.104.0 |
| Business email/support identity | DONE | `support@ctrlyoke.dev`, DNS/DKIM/DMARC configured |
| Publisher identity | DONE | `fuzzynova`, repo at FuzzyNova/ctrlyoke |
| License/commercial terms | DECISION MADE | Custom EULA (source-available, $10M threshold); draft at `LICENSE_DRAFT.md`; needs attorney |
| Final `vsce ls` package inspection | OPEN | Run immediately before publish |
| Marketplace publish | OPEN | Blocked on identity decision |
| npm CLI publish | DEFERRED | Separate packaging decision |

---

## Known Issues Accepted for v0.1.0

Carry these only if they are still accurate at final publish time:

- Chat mode model switching can fail silently in VS Code and should warn rather than block execution.
- Codex headless completion detection remains sensitive to upstream JSONL/event changes.
- Webview CSP still allows inline styles for Tailwind/CodeMirror compatibility.
- Webview message payloads are trusted local extension messages, not schema-validated external input.
