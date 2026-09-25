# CLI Distribution Plan

**Status:** Decided 2026-09-24. §3.1 implemented 2026-09-25 (see the note at the end of §3.1); §3.2–§3.4 not started.

**Decision:** ship the CLI through both channels, built from one artifact with one version
number:

1. **Bundled in the VSIX, exposed automatically inside VS Code.** `out/cli.js` ships in the
   extension. `ctrlyoke` is on `PATH` in VS Code integrated terminals and in the harness processes
   ctrlyoke spawns. Nothing is written to the user's system `PATH`.
2. **Published to npm as `ctrlyoke`** for use outside VS Code (CI, servers, containers, plain
   terminals): `npm install -g ctrlyoke`, or `npx ctrlyoke`. The npm version is always the
   extension version, and one release tag publishes both.

Not chosen: npm only, VSIX only, silently editing the system PATH, and standalone native
executables (see §5).

**Supersedes:** `RELEASE_CHECKLIST.md` Phase 11 ("npm CLI Package (deferred)") and the Phase 8
check "`out/cli.js` **not** included". Both were updated to point here. Resolves
[`DOCUMENTATION_GAPS_PLAN.md`](DOCUMENTATION_GAPS_PLAN.md) §3.1.

## 1. Facts that drove the decision

- **The CLI already expects the extension's folder layout.** `CliAdapter.getExtensionPath()`
  (`src/platform/CliAdapter.ts:148`) takes the directory above `out/cli.js` as the package root
  and finds `out/templates/`, `out/schemas/`, `out/scripts/` and `out/mcp-server.js` from there.
  A copy of `cli.js` inside the installed extension's `out/` therefore works with no code
  changes. The npm package has to reproduce the same `out/` layout.
- **No native dependencies on the CLI path.** esbuild marks `node-pty` external ("not used by CLI
  paths", `esbuild.js:450`), and everything else is bundled. `OsCredentialStore` spawns the OS
  tools rather than loading a native addon. The npm package can have **zero `dependencies`**.
- **Users already need `node` on PATH.** The extension launches the MCP server for every harness
  as `command: "node"` (`CliMcpConfigGenerator.ts:364`), and skill mode runs
  `node "<mcp-server.js>" --tool …` (`McpToolSkillGenerator.ts:107`). Five of the six harness
  CLIs are usually installed through npm. Requiring Node for the CLI adds nothing new.
- **Agents inside a run are CLI users too.** The docs point agents and users at
  `ctrlyoke append`, `ctrlyoke continue` and `ctrlyoke commit` from inside a workflow. If the
  CLI only came from npm, those instructions would fail for most extension users.
- **CI has no VS Code.** `cli/ci.md`, a P0 in the docs plan, needs an install path that doesn't
  involve an editor.
- **Version skew is a real risk.** The CLI and the extension share `~/.ctrlyoke` state:
  - settings
  - run storage and `runner.json` locks
  - the history-search index
  - the trust stores

  Both also write absolute `<extensionPath>/out/scripts/*` hook and statusline paths into
  global harness config: `~/.claude/settings.json`, `~/.gemini/config/hooks.json`, and others
  (for example `ClaudeCliProvider.ts:633`, `AntigravityCliProvider.ts:594`). An npm CLI pinned
  to an old version next to a newer extension can mis-read state and keep rewriting those global
  paths back and forth. Inside VS Code, the bundled copy removes this entirely. Outside, keeping
  the versions identical and adding a skew warning (§3.4) contains it.

- **The npm name is free.** `npm view ctrlyoke` returned 404 on 2026-09-24, and so did
  `@fuzzynova/ctrlyoke`. Once the docs say `npm install -g ctrlyoke`, someone else owning that
  name is a supply-chain risk. **Claim it before the repo goes public.**

## 2. Why "both" and not one channel

| Option                         | Works in VS Code terminals | Works in CI / no editor | Versions stay in sync                      | Extra install step for extension users | Touches system PATH                   |
| ------------------------------ | -------------------------- | ----------------------- | ------------------------------------------ | -------------------------------------- | ------------------------------------- |
| npm only                       | only after manual install  | yes                     | no                                         | yes                                    | npm's own                             |
| VSIX only                      | yes                        | **no**                  | yes                                        | no                                     | no                                    |
| VSIX plus system PATH edit     | yes                        | no                      | yes                                        | no                                     | **yes** (intrusive; Windows registry) |
| **VSIX (terminal PATH) + npm** | **yes**                    | **yes**                 | inside VS Code: yes; outside: same release | no                                     | no                                    |

## 3. Implementation

### 3.1 Bundle and expose the CLI in the extension

1. `.vscodeignore`: add `!out/cli.js`, and replace the comment "cli.js is released as a standalone
   npm package, not bundled with the VSIX". Expect roughly +2 MB compressed; `out/cli.js` is
   about 7.9 MB unminified. Check that the production build minifies it, the same as
   `extension.js`.
2. Ship launcher shims in the VSIX: `bin/ctrlyoke` (POSIX `sh`, executable bit set) and
   `bin/ctrlyoke.cmd` (Windows). Both run `node "<dir>/../out/cli.js" "$@"`. Do the same for
   `ctrlyoke-mcp`.
   - **Fallback when `node` is missing:** the shim runs VS Code's own runtime with
     `ELECTRON_RUN_AS_NODE=1`. The extension would have to write the shims into
     `globalStorageUri` at activation to embed `process.execPath`. Only do this if support
     reports show users without Node.
3. On activation, `context.environmentVariableCollection.prepend("PATH", <extensionPath>/bin + delimiter)`.
   Set a `description` on the collection so VS Code's terminal "environment changed" UI explains
   it. The collection is replaced on every activation, so an extension update never leaves a
   stale versioned path behind. It is also removed on uninstall.
4. The harness processes ctrlyoke spawns (node-pty and headless `child_process`) don't inherit
   `environmentVariableCollection`. Prepend the same `bin` directory in the central harness
   spawn environment, next to where `CTRLYOKE_WORKING_FILE` is set, so agents can run
   `ctrlyoke append` during a run. Single-source the directory in one helper used by both
   paths.
5. Add the command **ctrlyoke: Install CLI for Use Outside VS Code**. It opens a terminal with
   `npm install -g ctrlyoke@<extensionVersion>` typed in but **not run**. It never installs
   silently. Add it to the Getting Started walkthrough as an optional step.

**Implemented 2026-09-25.** Items 1 and 3–5 are in (`src/utils/CtrlyokeCliPath.ts`,
`src/ui/CtrlyokeCliCommands.ts`, `bin/`, `scripts/cli-distribution-packaging.test.mjs`), and so
are item 2's shims. Two things are deliberately held until the npm package (§3.2) is published,
because until then the command would type an install that fails:

- `ctrlyoke.installCli` is registered but hidden from the Command Palette
  (`contributes.menus.commandPalette` entry with `when: false` in `package.json`). Remove that
  entry in the same change that first publishes to npm.
- The optional walkthrough step is not written yet; add it in that same change.

As planned, the item 2 fallback (`ELECTRON_RUN_AS_NODE` when `node` is missing) was not built.
The same PATH prepend also covers the dashboard's own shell terminals (`PtyProcessManager`), not
only harness processes. Measured VSIX size: 16.1 MB (was 14.1 MB).

### 3.2 npm package

1. Add `scripts/build-npm-package.mjs`, which assembles `dist/npm/`:
   - a generated `package.json` (see below)
   - `out/cli.js` and `out/mcp-server.js`
   - `out/templates/`, `out/schemas/` and `out/scripts/`, i.e. whatever the CLI resolves
     through `getExtensionPath()`. Audit every `extensionPath`/`getExtensionPath()` join
     reachable from `cli.ts` and add a test that fails if a path is missing from the package.
   - the history-search worker bundles, if the CLI's `history search` spawns them
   - `LICENSE.md`, `THIRD_PARTY_NOTICES.md`, and a short npm `README.md` that links to the docs

   Do **not** publish the root `package.json`. It carries `contributes`, `devDependencies` and
   extension-only fields.

2. The generated `package.json`:
   - `name: "ctrlyoke"`
   - `version` equal to the root version
   - `bin: { ctrlyoke: "out/cli.js", "ctrlyoke-mcp": "out/mcp-server.js" }`
   - `engines.node: ">=22.12.0"`
   - `license: "SEE LICENSE IN LICENSE.md"`
   - `homepage`, `repository` and `bugs` copied from root
   - no `dependencies`
   - a `files` allowlist
3. Add a packaging test to `test:packaging` (`scripts/*.test.mjs`) that builds `dist/npm/`, runs
   `npm pack --dry-run --json`, and checks the file list. Then install the tarball into a temp
   prefix and run `ctrlyoke --version` and `ctrlyoke validate` against a fixture workflow.
4. `release.yml`: after the Marketplace publish, run `node scripts/build-npm-package.mjs` and
   `npm publish dist/npm --provenance --access public`. Prefer npm **trusted publishing**
   (GitHub OIDC; `permissions: id-token: write`) over a long-lived `NPM_TOKEN`. If a token is
   unavoidable, make it a granular automation token scoped to this one package.
   `verify-release-tag.mjs` already guarantees tag == root version, and so == npm version.
5. Account setup (business side): create an npm org or user owned by Fuzzy Nova LLC, enable
   2FA, and reserve `ctrlyoke`. A `0.0.0` placeholder that prints "coming soon" is fine if the
   real publish slips. Mirror MFA status into the checklist's account-hardening list.

### 3.3 Licensing and telemetry

- The npm package uses the same commercial `LICENSE.md`; npm allows `SEE LICENSE IN`. The CLI
  has no `LicenseService` gate today, so the free-use terms and thresholds in `LICENSE.md`
  apply exactly as they do to the extension. Say this on `cli/index.md`.
- Check what telemetry, if any, the CLI sends and how to opt out without VS Code. Document it on
  the `guide/privacy.md` page from the docs plan.

### 3.4 Coexistence: extension and npm CLI installed together

This section covers what happens when a user has the extension installed and also runs
`npm install -g ctrlyoke`.

#### What is not a problem: the MCP server

Each host starts **its own** `out/mcp-server.js`, resolved from its own package root:
`path.join(extensionPath, "out/mcp-server.js")` in `CliProviderUtils.ts:529`, where
`getExtensionPath()` is the installed extension folder in VS Code and the npm package root for
the CLI. Skill mode embeds the same host-relative path (`McpToolSkillGenerator.ts:107`). So in
any single run, the host and its MCP server are always the same version, and two installs never
share or replace each other's server process. Both packages must still ship `mcp-server.js`
(§3.2).

#### Which copy runs `ctrlyoke`

- **Integrated terminal inside VS Code:** the extension's bundled copy. The terminal `PATH`
  prepend (§3.1) puts it ahead of npm's global `bin`.
- **Harness processes ctrlyoke spawns** (the `ctrlyoke append` calls agents make): the host's
  own copy, via the spawn-environment prepend.
- **Any other shell, CI, cron:** the npm copy.

A user who installs both therefore gets the matching copy everywhere inside VS Code. The two
diverge only when a plain shell or CI job runs the npm copy **against the same machine's state**
while the extension has moved to a different version. VS Code auto-updates extensions and npm
global installs don't, so in practice this is "the npm CLI is older than the extension".

#### What the two copies share, and what goes wrong on a version mismatch

| Shared thing                                                                                                                                  | Where                                | Same version, both installed                                                                                                                                                                                                                                                                                                                         | Different versions                                                                                                                                                                                                                                                                                                                                                                    | Risk                       |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Run working files, `workflow.json`, `events.jsonl`                                                                                            | `~/.ctrlyoke/projects/<slug>/.runs/` | fine; the dashboard mirrors CLI runs live                                                                                                                                                                                                                                                                                                            | The extension mirrors a CLI run, and `ctrlyoke append`/`continue`/`step` mutate runs the extension owns. Step objects survive a round trip because they are spread (`{ ...step }`), but top-level snapshots are rebuilt field by field (`WorkflowStepSanitizer.ts`). An older writer can therefore **drop newer fields**, or misread a new step type or setting and execute it wrong. | **High**: silent data loss |
| Runner lock `runner.json`                                                                                                                     | per lineage                          | fine; the same lock protocol                                                                                                                                                                                                                                                                                                                         | If the lock format changes, an older reader could judge a live lock invalid or stale and start a **second runner** on the same lineage.                                                                                                                                                                                                                                               | **High**: concurrent runs  |
| History search index                                                                                                                          | `.ctrlyoke/.search-index/`           | fine                                                                                                                                                                                                                                                                                                                                                 | Any schema mismatch drops and rebuilds the index (`HistorySearchIndexService.ts:991`, strict `!==`). Alternating hosts rebuild it on every search.                                                                                                                                                                                                                                    | Medium: performance only   |
| Global harness config: statusline in `~/.claude`, `~/.copilot`, `~/.qwen` `settings.json`; Antigravity hooks in `~/.gemini/config/hooks.json` | machine-global                       | Path ping-pong: each run rewrites the command to _its_ host's `out/scripts/…` (`StatuslineManager.install` treats the other copy's path as "already ctrlyoke" and re-points it). This works, but it's churn. If the npm copy is later uninstalled, **the user's plain `claude` statusline points at a deleted script** until the next extension run. | Same, plus a concurrent run on each host can connect a statusline script from one version to the other's sidecar.                                                                                                                                                                                                                                                                     | Medium                     |
| ctrlyoke settings `~/.ctrlyoke/settings.json`, `.ctrlyoke/settings.json`                                                                      | user and workspace                   | fine                                                                                                                                                                                                                                                                                                                                                 | Settings aren't validated at runtime, so an older copy silently ignores keys it doesn't know and uses defaults for renamed ones. The same workflow can behave differently depending on which copy runs it.                                                                                                                                                                            | Low–medium: confusing      |
| Trust stores, secret registry, coordination board, usage history                                                                              | `~/.ctrlyoke/…`, project state       | fine                                                                                                                                                                                                                                                                                                                                                 | Same class of problem as run files, at lower traffic.                                                                                                                                                                                                                                                                                                                                 | Medium                     |

#### Rules

1. **Lockstep releases.** One tag publishes the VSIX and npm package at the same version
   (§3.2). Mismatch is then always "one side hasn't updated yet", never two unrelated
   version lines.
2. **A host registry, so each side knows about the other.** On startup, every host (extension or
   CLI) records `{ kind, version, packageRoot, lastSeen }` in `~/.ctrlyoke/installations.json`.
   - The **CLI** warns once per version pair, to stderr and never to `--json` stdout, when a
     newer extension is recorded: "ctrlyoke CLI 0.2.1 is older than your VS Code extension
     (0.3.0). Run `npm install -g ctrlyoke@0.3.0`."
   - The **extension** shows a one-time, dismissable notice when the npm CLI is older.
   - `ctrlyoke --version` prints the version plus the package root, so support can tell the
     two copies apart.
3. **Format versions on shared persisted state, and read-only below a newer format.** Add an
   integer `formatVersion` to each of these:
   - run working files
   - `workflow.json`
   - `runner.json`
   - the trust stores
   - the coordination store

   Bump it only on a breaking change. A host that sees a **newer** `formatVersion`:
   - **may read and display** the data, so the dashboard can still mirror a newer CLI run
   - **must not write, mutate, continue or append** to it, and fails with an actionable "update
     ctrlyoke" message (CLI exit code `2`)
   - **must treat a newer `runner.json` as held** (fail closed), never as stale

   This turns the two **High** rows into a clear error instead of silent corruption. Pre-1.0
   the policy stays "no migrations"; only the refuse-to-write guard is required.

   **Implemented 2026-09-25** in `src/utils/PersistedSchemaGuard.ts`, using the codebase's
   existing field name `schemaVersion` rather than `formatVersion`. `runner.json` (already at
   `2`) and `workflow.json` (already at `1`, but never checked) kept their fields; run files carry
   theirs as `_runtime.schemaVersion`, because `_runtime` never reaches an exported definition.
   Trust stores share a new `TrustDecisionFile` helper, and coordination-board entries are
   stamped one by one. Two known gaps: a mid-run refusal inside the executor may surface as a
   workflow failure (exit `1`) rather than exit `2`, since only direct step/CLI commands reach
   the exit-`2` handler; and the usage-history stores still quarantine a mismatched schema, which
   would discard a newer file (Medium row, not in rule 3's list).

4. **Version the search index directory** (`.search-index/v<INDEX_SCHEMA_VERSION>/`). Each
   version then keeps its own index instead of rebuilding the other's. Prune directories for
   versions not seen in `installations.json` for 30 days.
5. **Point global harness config at a stable path.** Statusline and global hook entries should
   reference a version-independent launcher, `~/.ctrlyoke/bin/ctrlyoke-statusline.js`, instead
   of an `out/scripts/…` path inside a versioned install folder.
   - Each host copies its script there only when its version is **≥** the version recorded
     beside it. Newest wins; an older host never downgrades it.
   - The launcher stays valid when either install is removed or updated. That also fixes the
     existing problem of the path moving on every extension update (the `alreadyCtrlyoke`
     re-point in `StatuslineManager`).
   - The sidecar protocol needs a version field too, so a mismatched launcher and sidecar fail
     quietly (no statusline data) instead of mis-parsing.
6. **Uninstall hygiene.** `StatuslineManager.uninstall()` restores the user's captured command.
   It, and any future CLI equivalent, should do that only when no other installation is recorded
   as active in `installations.json`. That stops one copy from tearing down integration the other
   still uses.

## 4. Docs and checklist follow-ups

- `docs/cli/index.md` and `docs/guide/installation.md`:
  - "Inside VS Code the CLI is already available in the integrated terminal"
  - "Elsewhere, `npm install -g ctrlyoke` (Node ≥ 22.12)"
  - "keep it on the same version as the extension"
  - remove the "once installed" placeholder text
- The P0 page `docs/cli/ci.md` (docs plan §4.4) uses `npx ctrlyoke@<version>` in its GitHub
  Actions example.
- `RELEASE_CHECKLIST.md`:
  - Phase 8: change the check to `out/cli.js` **included** and `bin/` shims included.
  - Phase 10 and Phase 11: add the npm publish, `npm view ctrlyoke version` matching the tag,
    and a clean-machine `npx ctrlyoke --version`.
- `.github/instructions/cli-binary.instructions.md`: add the distribution constraint. Anything
  the CLI loads at runtime must live under `out/` and be listed in both `.vscodeignore` and the
  npm `files` allowlist. The packaging test enforces it.

## 5. Rejected alternatives

- **npm only.** Extension users would need a manual second install before `ctrlyoke append`
  works inside their own workflows, and the two installs would drift apart in version.
- **VSIX only.** No answer for CI, servers or containers, which the CLI's headless and `--json`
  modes exist for.
- **Editing the system PATH on install.** Intrusive. On Windows it means registry edits and
  broadcasting environment changes, and the path is versioned by the extension folder, so it goes
  stale after every update. VS Code's own `code` command needed a dedicated install command for
  the same reasons. The terminal-scoped collection covers the in-editor case without any of that.
- **Standalone native executables** (Node SEA, `bun build --compile`, `pkg`). These need a build
  per OS and architecture, plus code signing and notarization to avoid SmartScreen and Gatekeeper
  warnings, and they still launch `node` for the MCP server. Revisit only if users without Node
  appear.
- **Homebrew / winget / Scoop.** Worth adding after launch as thin wrappers over the npm
  tarball. Not needed for v0.1.

## 6. Order

1. Reserve `ctrlyoke` on npm under Fuzzy Nova, with 2FA. Do this **before the Phase 14 repo
   visibility flip**.
2. §3.1 bundling and terminal PATH. Small, and it lets the docs say "it's already there".
3. §3.2 npm package, packaging test and `release.yml` publish. Ship it with the first public tag
   if ready. Otherwise ship it as a 0.1.x fast-follow; until then the docs say VS Code only.
4. §3.4 rule 3 (`formatVersion` plus refuse-to-write) and rule 2 (host registry and warnings).
   These **must land before or with the first npm publish**, because that is the first moment
   two versions can touch the same state. Rules 4–6 (index directories, stable statusline
   launcher, uninstall hygiene) can follow. Rule 5 also fixes an extension-only problem, the
   path moving on every update, so it's worth doing anyway.
5. §4 docs and checklist. The `cli/index.md` page also gets a short "Using the CLI and the
   extension together" section: which copy runs where, keep the npm copy on the extension's
   version, and what the "update ctrlyoke" refusal means.
