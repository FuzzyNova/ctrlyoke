# FlightPath v0.1.0 Release Plan

**Created:** March 11, 2026  
**Status:** IN_PROGRESS  
**Target:** VS Code Marketplace public release + npm CLI package

---

## Overview

This document tracks every step required to ship FlightPath v0.1.0 to the VS Code Marketplace. Items are ordered by priority and grouped into phases. Complete all **Blockers** before publishing — the rest are strongly recommended but not strictly required.

For the strategic roadmap (post-release features), see [`ROADMAP.md`](ROADMAP.md).

---

## Phase 1 — Critical Blockers (Must Fix Before Publishing)

These will either prevent publishing outright or break the extension for all users.

### 1.1 Fix `.vscodeignore` — Webview Bundle Is Missing From VSIX

**Priority: CRITICAL** | **Status: DONE** | **Effort: 30 minutes**

The `.vscodeignore` excluded `out/**` but only whitelisted `out/extension.js`, `out/templates/**`, and `out/schemas/**`. The React dashboard webview bundle built to `out/ui/webview-react/` and the CLI hook scripts in `out/scripts/**` were missing, causing a blank dashboard for any published VSIX.

**Decision: MCP server ships with the VS Code extension; CLI is a separate npm package.**

- `out/mcp-server.js` — **whitelisted** (`!out/mcp-server.js`). The MCP server must be co-located with the extension so VS Code can launch it via the `flightpath-mcp` bin entry.
- `out/cli.js` — **excluded** (stays out of VSIX). The `flightpath` CLI is published separately to npm (see Phase 7). Users install it independently via `npm install -g flightpath`.

**Changes applied to `.vscodeignore`:**

```
# Whitelisted (added):
!out/mcp-server.js
!out/ui/**
!out/scripts/**

# Excluded junk (added):
archive/**
AGENTS.md
CLAUDE.md
CHORES.md
schemas/**        # source schemas; compiled copies ship in out/schemas/**
scripts/**        # root-level build scripts, not needed at runtime
.prettierrc.json
.prettierignore
.flightpath/**
```

> `.github/**` was already excluded in the original file.

---

### 1.2 Populate the CHANGELOG

**Priority: CRITICAL** | **Effort: 2–4 hours**

The current `CHANGELOG.md` has only an `[Unreleased]` section and a "Planned for v0.1.0" stub. VS Code Marketplace requires a populated CHANGELOG for extensions to pass review. More importantly, users need to know what they're installing.

Use `ROADMAP.md` § "Current Version & Completed Milestones" as the source of truth. The CHANGELOG entry for v0.1.0 should cover:

- Multi-harness execution (Copilot CLI, Claude Code, Codex, OpenCode, Copilot Chat)
- Parallel workflow execution with pause/resume/cancel
- React dashboard with CodeMirror 6 editor
- End conditions with retry logic
- Dynamic queue extension via MCP tools
- Agent and skills injection
- IntelliSense completions for `@file`, `#file:`, `#sym:`
- Output history with run selector
- Workflow templates (blank, simple-feature, fix-tests, full-feature)
- Multi-format workflow files (.flightpath.yaml/.json/.prompt.md)
- Status bar integration

---

### 1.3 Verify Production Build End-to-End

**Priority: CRITICAL** | **Effort: 1–2 hours**

Run `npm run package` and install the resulting `.vsix` file locally via **Extensions: Install from VSIX**. Verify:

- [ ] Dashboard panel loads (React webview renders, not blank)
- [ ] Settings panel works
- [ ] New Workflow from Template works
- [ ] Run a simple `.prompt.md` file end-to-end in at least one harness
- [ ] No `console.error` crashes visible in the extension host dev tools
- [ ] Dev commands (DevMenu) are NOT visible in the command palette
- [ ] `IS_DEV_MODE` is `false` (verify by checking that dev-only commands are absent)

---

### 1.4 macOS Testing

**Priority: CRITICAL** | **Effort: 2–4 hours**

FlightPath has only been developed and tested on Linux/WSL. macOS is the primary platform for VS Code users and must be verified before Marketplace publication. macOS-specific risks:

- **`node-pty` native binaries** — prebuilt binaries differ per platform/architecture (x64 vs arm64). Must verify PTY-based terminal works on both Intel and Apple Silicon.
- **CLI tool paths** — Homebrew installs to `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel). `PATH` may not include these in the extension host process. Test that `gh copilot`, `claude`, `codex`, etc. are discovered correctly.
- **File path handling** — macOS is case-insensitive but case-preserving. Test that workspace-relative paths, `.flightpath/` resolution, and temp file creation all work correctly.
- **PTY behavior** — Terminal resize, ANSI escape handling, and process spawning behave differently on macOS. Verify interactive terminal display and headless output capture.
- **File watching** — `chokidar` behaves differently on macOS (uses `FSEvents` instead of `inotify`). Verify log file monitoring and workflow file change detection.
- **Permissions** — macOS may prompt for folder access permissions. Test on a clean user account without pre-granted permissions.

**Test checklist (macOS):**

- [ ] Extension installs and activates without errors
- [ ] Dashboard panel loads correctly
- [ ] Interactive terminal renders (PTY works on target architecture)
- [ ] Run a workflow end-to-end in `copilot-cli` harness (interactive mode)
- [ ] Run a workflow end-to-end in `claude-cli` harness (interactive mode)
- [ ] Headless mode produces output and exits cleanly
- [ ] Log file monitoring detects AI completions (file watch works)
- [ ] Temp prompt files are created and cleaned up correctly
- [ ] `.flightpath/` directory is created in workspace root
- [ ] End condition scripts execute successfully

**Test on both architectures if possible:**
- [ ] Apple Silicon (arm64) — M1/M2/M3 Mac
- [ ] Intel (x64) — or verify Rosetta compatibility

---

## Phase 2 — Publisher & Marketplace Setup

Steps required to get the publisher account and tooling configured for the first `vsce publish`.

### 2.1 Create / Verify Azure DevOps Publisher Account

**Effort: 30 minutes (if not already done)**

- Go to https://marketplace.visualstudio.com/manage
- Sign in with the Microsoft account linked to publisher ID `nhickster` (already set in `package.json`)
- If the publisher doesn't exist yet: **New Publisher** → name: `nhickster`
- Verify the publisher name is available — it must match `package.json#publisher` exactly

### 2.2 Generate a Personal Access Token (PAT)

**Effort: 15 minutes**

- Azure DevOps → User Settings → Personal Access Tokens
- Organization: **All accessible organizations**
- Scopes: **Marketplace → Manage** (full access)
- Store the token securely (you'll use it once during `vsce login`)

### 2.3 Install `@vscode/vsce` and Login

```bash
npm install -g @vscode/vsce
vsce login nhickster
# paste PAT when prompted
```

### 2.4 Verify the VSIX Passes `vsce ls` Checks

```bash
vsce ls           # shows files that will be included in the VSIX
vsce package      # builds the .vsix
```

Review the `vsce ls` output and confirm:

- `archive/` files are NOT listed ✅ (fixed in 1.1)
- `out/ui/webview-react/` files ARE listed ✅ (fixed in 1.1)
- `out/scripts/` files ARE listed ✅ (fixed in 1.1)
- `out/mcp-server.js` IS listed ✅ (fixed in 1.1 — MCP ships with extension)
- `out/cli.js` is NOT listed ✅ (CLI is a separate npm package — see Phase 7)
- `src/` files are NOT listed (already excluded)
- Sensitive files (`.env`, `AGENTS.md`, `CLAUDE.md`, `CHORES.md`) are NOT listed ✅ (fixed in 1.1)

---

## Phase 3 — Content & Documentation Polish

Not strict blockers, but expected by marketplace reviewers and important for first impressions.

### 3.1 README Review

**Effort: 1–2 hours**

The README is in good shape but needs a pass before public release:

- [ ] Verify all doc links (`./docs/QUEUE_APPEND_FEATURE.md`, `./docs/SESSION_MANAGEMENT.md`, `./docs/ADDING_NEW_CLI_HARNESS.md`) exist
- [ ] Add OpenCode CLI (`opencode-cli`) to the harnesses table (it's in settings but missing from the README table)
- [ ] Verify quick-start instructions work end-to-end with the current CLI tool versions
- [ ] Add a **Screenshots** section with at least one screenshot of the dashboard in action — this significantly increases Marketplace click-through rate
- [ ] Consider adding a **Known Issues** or **Limitations** section for the issues documented in ROADMAP.md (e.g., Chat mode model switch fragility, Codex headless detection)

### 3.2 Marketplace Listing Metadata (`package.json`)

**Effort: 30 minutes**

- [ ] `"description"` is currently `"Automate GitHub Copilot with structured prompt workflows"` — this undersells it. Suggested: `"Automate AI coding assistants (Copilot, Claude, Codex) through structured YAML/JSON prompt workflows with sequential execution, retry logic, and live dashboard."`
- [ ] `"categories"` is `["Other", "Machine Learning"]` — consider adding `"Programming Languages"` (for the YAML/JSON IntelliSense completions) and `"Linters"` (for end condition scripts)
- [ ] `"keywords"` field is missing entirely. Add: `["AI", "automation", "copilot", "claude", "codex", "workflow", "prompt", "agent", "LLM"]`
- [ ] `"galleryBanner"` field is missing. Add a banner color/theme that matches the icon:
  ```json
  "galleryBanner": {
    "color": "#1e1e2e",
    "theme": "dark"
  }
  ```
- [ ] Verify `"homepage"` URL (`https://github.com/nhickster/flightpath`) is a public repo

### 3.3 Screenshots / Demo GIF

**Effort: 1–2 hours**

The Marketplace listing will show a blank preview if no screenshots are included. At minimum:

- Capture a screenshot of the FlightPath dashboard with a workflow running
- Add it to `images/` and reference in README: `![FlightPath Dashboard](images/screenshot-dashboard.png)`
- Optional: A short GIF showing a multi-step workflow executing end-to-end

### 3.4 Verify GitHub Repository Is Public

- [ ] Confirm `https://github.com/nhickster/flightpath` is publicly accessible (the `"repository"` field in `package.json` points there)
- [ ] Ensure `LICENSE` file is present at root ✅ (already exists)
- [ ] Push all local commits before publishing

---

## Phase 4 — Code Cleanup (Recommended Pre-Release)

Issues found during the pre-release audit. None are blockers, but they reduce quality and can confuse contributors. Group by effort.

### 4.1 Remove Dead File: `CliTerminalFormatter.ts` in `harness/shared/`

**Effort: 5 minutes** | **File: `src/flightpath/harness/shared/CliTerminalFormatter.ts`**

This file is a dead duplicate of `src/cli/CliTerminalFormatter.ts`. It is never imported anywhere. Delete it.

### 4.2 Remove/Relocate `chat-log-investigation.ts`

**Effort: 10 minutes** | **File: `src/test/chat-log-investigation.ts`**

A 296-line investigation script with 20+ `console.log` calls that lives in `src/test/` but is not a Mocha test. It is only reachable via a dev-only import in `DevCommands.ts`. Move it to `src/dev/` or delete it.

### 4.3 Fix `console.error`/`console.warn` Bypassing Log System

**Effort: 1 hour** | **Files listed below**

These fire in the VS Code extension host at runtime, bypassing the FlightPath Output channel and log level settings:

| File                                                   | Lines                   | Issue                                                                         |
| ------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------- |
| `src/flightpath/harness/shared/BaseLogParser.ts`       | 297, 375, 379, 384, 469 | 5× `console.error` — replace with `Log.error()`                               |
| `src/flightpath/harness/CliIntegration.ts`             | 477–481                 | `console.log` progress print — guard with `isCli()` check or use `Log.info()` |
| `src/flightpath/PromptFileParser.ts`                   | 49, 109, 148            | 3× `console.error` fallbacks — replace with `Log.error()`                     |
| `src/utils/FileLockUtils.ts`                           | 64                      | `console.warn` in `releaseLock` — replace with `Log.warn()`                   |
| `src/flightpath/harness/copilot/CopilotCliProvider.ts` | 246                     | Duplicate `console.warn` (same info already in `Log.warn`) — remove           |
| `src/flightpath/harness/claude/ClaudeCliProvider.ts`   | 230                     | Same as above                                                                 |
| `src/flightpath/harness/codex/CodexCliProvider.ts`     | 248                     | Same as above                                                                 |

### 4.4 Fix Webview `console.log` Calls in `useVsCodeApi.ts`

**Effort: 15 minutes** | **File: `src/ui/webview-react/hooks/useVsCodeApi.ts`**

Lines 21 and 37 log to the browser console on every render and effect run. Users who inspect the webview will see noise. Remove or gate behind a debug flag.

### 4.5 Fix Stale Model Lists in `DashboardConstants.ts` and `settingsStore.ts`

**Effort: 1–2 hours** | **Files: `src/types/DashboardConstants.ts`, `src/ui/webview-react/store/settingsStore.ts`**

Both files declare local `CLAUDE_CLI_MODELS` and `CODEX_CLI_MODELS` constants that are out of sync with `ModelConstants.ts` (missing 1–2 entries each). Users see an incomplete model list in the dashboard dropdown until the dynamic registry loads.

Fix: import from `ModelConstants.ts` with a mapping to `{value, label}` shape, or at minimum sync the hardcoded lists.

### 4.6 Remove Dead Exports from `ModelConstants.ts`

**Effort: 15 minutes**

- `CLAUDE_CLI_MODEL_ALIASES` (line 112): `= CLAUDE_CLI_MODELS` with no importers — delete
- `CLAUDE_CLI_DEFAULT_MODEL` (line 117): zero importers — delete
- `CODEX_CLI_DEFAULT_MODEL` (line 150): zero importers — delete

### 4.7 Collapse Duplicate Function Pair in `ModelRegistry.ts`

**Effort: 15 minutes**

`getOpenCodeModelIds()` and `getOpenCodeModelIdsSync()` (lines 388–401) are byte-for-byte identical. Remove `getOpenCodeModelIds` (the non-Sync variant) and update the single call site to use `getOpenCodeModelIdsSync`. Repeat for `getCliSupportedModelIds` / `getCliSupportedModelIdsSync` (lines 340/348).

### 4.8 Update Stale `FlightPathManager` References

**Effort: 30 minutes**

`FlightPathManager.ts` no longer exists — the class was renamed to `WorkflowOrchestrator`. Approximately 20 JSDoc/comment references across `PromptQueue.ts`, `WorkflowExecutor.ts`, `EndConditionHandler.ts`, etc. still say `FlightPathManager`. Do a project-wide find-and-replace in comments.

### 4.9 Clean Up `DashboardConstants.ts` Unimplemented Message Types

**Effort: 30 minutes** | **File: `src/types/DashboardConstants.ts`**

- `PROMPTS_APPENDED` (line 27): Marked `// Reserved: defined for future use (no handler exists yet)`. Either implement the handler or remove the constant and the send call.
- `DYNAMIC_QUEUE_ENABLED` / `DYNAMIC_QUEUE_DISABLED` (lines 34–35): Sent by `FlightPathWebviewProvider.ts` (lines 545–546) but have no handlers in the webview's `useMessageHandler.ts`. Messages are sent and silently dropped. Either add handlers or remove.

### 4.10 Delete or Archive the `archive/` Directory

**Effort: 5 minutes**

`archive/` contains the pre-React webview implementation (~22 vanilla JS/SCSS files, two `.ts.old` files). Nothing in the active codebase imports from it. For a clean release, delete it from the working tree (it will remain in git history).

This also fixes `.vscodeignore` concern (the directory currently ships in VSIX until the ignore rule is added in 1.1).

---

## Phase 5 — Publishing

### 5.1 Final Pre-Publish Checklist

Run through this checklist immediately before `vsce publish`:

- [ ] `npm run package` completes without errors
- [ ] `vsce ls` output reviewed — correct files included/excluded
- [ ] VSIX installed locally and dashboard tested (Phase 1.3)
- [ ] Version in `package.json` is `0.1.0`
- [ ] CHANGELOG has a proper `[0.1.0] - YYYY-MM-DD` entry
- [ ] GitHub repo is public and up to date
- [ ] `npm test` passes (or known failures documented)
- [ ] `npm run lint` passes with no errors

### 5.2 Publish

```bash
vsce login nhickster
vsce publish
```

Or publish with a specific version bump:

```bash
vsce publish patch    # 0.1.0 → 0.1.1
vsce publish minor    # 0.1.0 → 0.2.0
```

### 5.3 Verify the Marketplace Listing

After publishing:

- [ ] Visit `https://marketplace.visualstudio.com/items?itemName=nhickster.flightpath`
- [ ] Verify the README renders correctly (images load, links work)
- [ ] Verify the CHANGELOG tab shows the v0.1.0 entry
- [ ] Install from the marketplace into a clean VS Code instance and test

### 5.4 (Optional) Submit for Featured Listing

- Go to `https://github.com/microsoft/vscode-discussions` and open an issue requesting a featured or highlighted listing
- This is informal but can get the extension in the "New & Noteworthy" section

---

## Phase 6 — Post-Release Infrastructure (First Week)

### 6.1 GitHub Releases

Create a GitHub Release tagged `v0.1.0`:

- Attach the `.vsix` file from `vsce package`
- Copy the CHANGELOG entry as the release notes

### 6.2 Open VSX Registry (Optional, Recommended)

Publish to Open VSX for users on VSCodium or other VS Code forks:

```bash
npm install -g ovsx
ovsx publish flightpath-0.1.0.vsix -p <OVSX_PAT>
```

Get a PAT at https://open-vsx.org/

### 6.3 CI/CD for Future Releases

Wire up GitHub Actions to automate future publishes:

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run package
      - uses: HaaLeo/publish-vscode-extension@v2
        with:
          pat: ${{ secrets.VSCE_PAT }}
          registryUrl: https://marketplace.visualstudio.com
```

---

## Phase 7 — Publish `flightpath` CLI to npm

The `flightpath` CLI (`out/cli.js`) is excluded from the VS Code extension VSIX. It is a standalone tool that users install globally via npm:

```bash
npm install -g flightpath
```

This phase covers preparing and publishing the CLI as its own npm package.

### 7.1 Decide: Separate Package or Unified Package?

**Two options:**

**Option A — Single `package.json` (current structure):**  
The CLI and extension share one `package.json`. `npm publish` would publish the entire repo as both the VS Code extension binary and the npm CLI. This is unusual and can confuse npm users who expect a lean CLI install (not 80 MB of extension + node_modules).

**Option B — Dedicated `cli/` package (recommended):**  
Extract the CLI into `packages/cli/package.json` with its own name (`flightpath`), `bin`, `main`, and `dependencies`. The extension stays at the root. This cleanly separates the two distribution channels.

> **Decision needed:** Choose Option A or B before proceeding.

### 7.2 Prepare the CLI Package

If using Option A (simplest for v0.1.0):

- Verify `package.json` `"name"` and `"version"` are correct for npm publishing
- Add `"files"` field to `package.json` to limit what npm publishes (npm uses `files` the same way VS Code uses `.vscodeignore`):
  ```json
  "files": [
    "out/cli.js",
    "out/cli.js.map",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ]
  ```
- Confirm `"bin": { "flightpath": "./out/cli.js" }` is correct (it already exists in `package.json`)
- Add `"preferGlobal": true` (cosmetic hint, not enforced)
- The `"main"` field points to `./out/extension.js` (VS Code extension entry). For npm CLI-only use, this is harmless but can be confusing — document this in a note

If using Option B (separate package):

- Create `packages/cli/package.json` with minimal fields
- Copy/symlink `out/cli.js` into the CLI package output on build
- Update `scripts` in root `package.json` to build and publish the CLI package separately

### 7.3 Create a npm Account / Verify Access

- Ensure you have an npm account at https://www.npmjs.com
- Check if `flightpath` is available as a package name: `npm search flightpath`
- If the name is taken, consider `@nhickster/flightpath` (scoped) or `flightpath-cli`
- Log in: `npm login`

### 7.4 Test the CLI Package Locally

```bash
# Build the CLI
npm run build:prod

# Pack and inspect what would be published
npm pack --dry-run

# Install locally to test
npm pack
npm install -g ./flightpath-0.1.0.tgz
flightpath --help
```

Verify the CLI works for basic commands after a fresh global install (no extension or repo context).

### 7.5 Publish to npm

```bash
npm publish --access public
```

Or for a scoped package:

```bash
npm publish --access public  # required for scoped packages
```

### 7.6 Verify the npm Listing

- Visit `https://www.npmjs.com/package/flightpath` (or scoped URL)
- Confirm `npm install -g flightpath` works in a clean environment
- Run `flightpath --help` and verify the version matches `0.1.0`

### 7.7 Update README with npm Install Instructions

Add to the README (CLI section):

````md
## CLI Installation

The FlightPath CLI is available as a standalone npm package:

```bash
npm install -g flightpath
```
````

The CLI is separate from the VS Code extension. Install the extension from the VS Code Marketplace for the dashboard UI and workflow orchestration.

````

### 7.8 CI/CD for CLI Releases (Optional)

Wire up GitHub Actions to publish the CLI to npm on tag:

```yaml
# .github/workflows/npm-release.yml
on:
  push:
    tags: ["v*"]
jobs:
  npm-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run build:prod
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
````

---

## Summary Checklist

| #       | Item                                                            | Phase | Effort | Blocker? | Status  |
| ------- | --------------------------------------------------------------- | ----- | ------ | -------- | ------- |
| 1.1     | Fix `.vscodeignore` (webview bundle missing)                    | 1     | 30 min | **YES**  | ✅ DONE |
| 1.2     | Populate CHANGELOG for v0.1.0                                   | 1     | 2–4 hr | **YES**  |         |
| 1.3     | Verify production build end-to-end (Linux/WSL)                  | 1     | 1–2 hr | **YES**  |         |
| 1.4     | macOS testing (PTY, paths, file watch, both architectures)      | 1     | 2–4 hr | **YES**  |         |
| 2.1     | Create/verify Azure DevOps publisher                            | 2     | 30 min | **YES**  |         |
| 2.2     | Generate PAT                                                    | 2     | 15 min | **YES**  |         |
| 2.3     | Install vsce + login                                            | 2     | 15 min | **YES**  |         |
| 2.4     | Verify `vsce ls` output                                         | 2     | 15 min | **YES**  |         |
| 3.1     | README review and polish                                        | 3     | 1–2 hr | No       |         |
| 3.2     | Marketplace metadata in package.json                            | 3     | 30 min | No       |         |
| 3.3     | Add screenshots/GIF                                             | 3     | 1–2 hr | No       |         |
| 3.4     | Verify GitHub repo is public                                    | 3     | 5 min  | No       |         |
| 4.1     | Delete dead `CliTerminalFormatter.ts`                           | 4     | 5 min  | No       | ✅ DONE |
| 4.2     | Relocate `chat-log-investigation.ts`                            | 4     | 10 min | No       | ✅ DONE |
| 4.3     | Fix `console.*` bypassing log system                            | 4     | 1 hr   | No       | ✅ DONE |
| 4.4     | Fix webview `console.log` in `useVsCodeApi.ts`                  | 4     | 15 min | No       | ✅ DONE |
| 4.5     | Sync stale model lists                                          | 4     | 1–2 hr | No       | ✅ DONE |
| 4.6     | Remove dead exports from `ModelConstants.ts`                    | 4     | 15 min | No       | ✅ DONE |
| 4.7     | Collapse duplicate function pairs in `ModelRegistry.ts`         | 4     | 15 min | No       | ✅ DONE |
| 4.8     | Update stale `FlightPathManager` references                     | 4     | 30 min | No       | ✅ DONE |
| 4.9     | Clean up unimplemented message types in `DashboardConstants.ts` | 4     | 30 min | No       | ✅ DONE |
| 4.10    | Delete `archive/` directory                                     | 4     | 5 min  | No       | ✅ DONE |
| 5.1–5.4 | Publish extension + verify + optional featured listing          | 5     | 1 hr   | —        |         |
| 6.1–6.3 | Post-release: GitHub Release, Open VSX, CI/CD                   | 6     | 2–3 hr | —        |         |
| 7.1     | Decide single vs. separate CLI package structure                | 7     | 30 min | **YES**  |         |
| 7.2     | Prepare CLI package (`files` field or separate package)         | 7     | 1–2 hr | **YES**  |         |
| 7.3     | Verify npm account + package name availability                  | 7     | 15 min | **YES**  |         |
| 7.4     | Test CLI package locally with `npm pack`                        | 7     | 30 min | **YES**  |         |
| 7.5     | Publish CLI to npm                                              | 7     | 15 min | **YES**  |         |
| 7.6     | Verify npm listing and global install                           | 7     | 15 min | **YES**  |         |
| 7.7     | Update README with npm install instructions                     | 7     | 15 min | No       |         |
| 7.8     | CI/CD for CLI npm releases (optional)                           | 7     | 1–2 hr | No       |         |

**Estimated total for VS Code extension blockers only (Phases 1–2):** ~5–8 hours  
**Estimated total including recommended polish and cleanup (Phases 1–4):** ~12–18 hours  
**Estimated total for CLI npm publish (Phase 7, blockers only):** ~3–4 hours

---

## Known Issues Accepted for v0.1.0

These are documented bugs carried into the release with no fix planned for v0.1.0 (see `ROADMAP.md` § "Known Issues"):

- **Chat mode model switch** (`workbench.action.chat.changeModel`) can fail silently — shows warning and continues with current model
- **Codex headless completion detection** is fragile — `{"type":"turn.completed"}` JSONL parsing and notify hook fallback need hardening
- **Webview `style-src 'unsafe-inline'`** — required by Tailwind CSS and CodeMirror, cannot be removed without library migration; accepted risk
- **Webview message payload validation** — incoming messages from webview are not schema-validated; low priority given single-user local deployment model
