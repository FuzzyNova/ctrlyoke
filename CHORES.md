# ctrlyoke Developer Chores

Regular maintenance tasks for ctrlyoke development. These are manual tasks that don't happen automatically during builds.

## Quick Start

Run the automated chore script:

```bash
# Run all chores
npm run chores -- --task all

# Run specific chore
npm run chores -- --task update-clis
npm run chores -- --task sync-models
npm run chores -- --task update-deps
npm run chores -- --task check-all
```

## Manual Chore Checklist

### 1. Update CLI Tools

**Frequency**: Monthly or when new CLI versions are released

Update to the latest versions of the CLI tools ctrlyoke integrates with:

#### Copilot CLI

Copilot CLI uses a native installer (not npm). Use the built-in update command:

```bash
# Check current version
copilot --version

# Update to latest
copilot update
```

#### Claude Code CLI

Claude Code uses a native installer (not npm). Use the built-in upgrade command:

```bash
# Check current version
claude --version

# Update to latest
claude upgrade
```

#### Codex CLI

Codex CLI is an npm package:

```bash
# Check current version
codex --version

# Update to latest
npm install -g @openai/codex
```

#### Qwen CLI

Qwen CLI is an npm package:

```bash
# Check current version
qwen --version

# Update to latest
qwen update
```

#### OpenCode CLI

OpenCode CLI is an npm package:

```bash
# Check current version
opencode --version

# Update to latest
opencode upgrade
```

#### Antigravity CLI

Antigravity CLI is an npm package:

```bash
# Check current version
agy --version

# Update to latest
agy update
```

**After updating**: Test CLI integrations with manual test files in `manual-test/`

---

### 2. Update Models

**Frequency**: When new Copilot/Claude/Codex/Gemini models are released

Model lists split into two tracks with very different levels of automation. Copilot CLI
models are fully scriptable; everything else either needs one manual VS Code step or is
inherently manual because the vendor CLI has no scriptable "list models" command.

#### 2a. Copilot CLI models — fully automated, no VS Code needed

`COPILOT_CLI_MODEL_IDS` comes straight from `copilot help config`, which is a plain CLI
command. This can be run headlessly and needs no F5/export step at all:

```bash
npm run sync-models:discover   # updates COPILOT_CLI_MODEL_IDS in ModelConstants.ts
npm run sync-models            # propagates to package.json + workflow-schema.json
```

Or just run `npm run chores -- --task sync-models`, which does both automatically.

#### 2b. `COPILOT_MODELS` superset — requires one manual VS Code step

`COPILOT_MODELS` is the full display-name superset used to populate workflow-schema model
examples for autocomplete. (It no longer backs a harness — the copilot-chat harness was
removed — but the schema still uses it.) It can only be read from VS Code's
`vscode.lm.selectChatModels()` Language Model API, which isn't reachable outside the
extension host. This one step can't be scripted:

1. **Launch extension in dev mode**:
   - Press `F5` in VS Code to start debugging session

2. **Export discovered models**:
   - Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Run: `ctrlyoke: Export Discovered Models`
   - This creates/updates `scripts/discovered-models.json`

Once that file exists, the rest is scriptable again:

```bash
npm run sync-models:import   # imports COPILOT_MODELS from discovered-models.json
npm run sync-models          # propagates to package.json + workflow-schema.json
```

`npm run chores -- --task sync-models` also picks this up automatically if
`scripts/discovered-models.json` is present (and skips it with a reminder if not).

#### 2c. Codex / Claude CLI models — inherently manual

None of these have a scriptable model-list command to discover from:

- **Codex CLI**: the model list only surfaces via the interactive `/model` slash command
  inside a session — there's no headless `codex <flag>` equivalent to `copilot help config`.
- **Claude CLI**: has no list-models command at all (see the note in `ModelRegistry.ts`);
  its aliases (`sonnet`/`opus`/`haiku`) rarely change.

When these change, update `CODEX_CLI_MODELS` or `CLAUDE_CLI_MODELS`
in `src/utils/ModelConstants.ts` directly, based on vendor release notes or docs, then run
`npm run sync-models` to propagate the change.

#### 2d. Model pricing — fully automated, no hand-maintained table

`src/utils/ModelPricing.ts` has **no hand-typed price table for any harness.** Every harness
(Copilot, Claude, Codex, OpenCode, Qwen, Antigravity) is priced by looking the model up in a
downloaded registry snapshot via `getModelPricingFromRegistry()`
(`src/utils/ModelPricingRegistry.ts`). Adding/removing a model ID in `ModelConstants.ts` never
requires touching `ModelPricing.ts` — there's nothing to edit there.

The registry comes from [models.dev](https://models.dev) — a single, MIT-licensed,
community-maintained model/pricing database
([source](https://github.com/anomalyco/models.dev)) that covers every vendor ctrlyoke's six
harnesses touch, including a `github-copilot` provider bucket that tracks GitHub's own Copilot
billing docs and an `opencode` provider bucket that is the literal upstream catalog OpenCode's
own CLI uses for its model list and cost display (confirmed 2026-08-21) — so OpenCode's own
`<provider>/<model>` IDs match its provider buckets natively.

```bash
npm run sync-model-pricing                      # re-downloads models.dev, regenerates the snapshot
npm run chores -- --task sync-model-pricing      # same, via chores
```

This writes `src/utils/generated/modelPricingRegistryData.json` — a trimmed (cost-fields-only)
snapshot of the full registry, committed to the repo. It is **read at build time via a normal
`import`, never fetched over the network at runtime** — ctrlyoke's cost estimation stays offline
by design (see the "Cost is not spend" notes in
`dev/implemented/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`). Re-run the sync task periodically (it's
covered by `--task all`) to pick up new models/rates; there is no per-model editing to do by hand
for any harness.

`src/utils/ModelPricingRegistry.ts` matches ctrlyoke's internal model IDs against the registry
per harness:

- **Copilot CLI**: exact/near-exact match against the `github-copilot` provider bucket.
- **Codex CLI**: exact match against the `openai` provider bucket (Codex's own model IDs are
  already fully versioned, e.g. `gpt-5.6-sol`).
- **Claude CLI**: its short aliases (`sonnet`/`opus`/`haiku`/`fable`, plus the `[1m]` variants)
  name a *family*, not a specific dated model — the resolver picks whichever version of that
  family is newest in the `anthropic` bucket every time pricing is resolved, so there's no
  "current version" fact to hand-update as Anthropic ships new models.
- **OpenCode**: its own model IDs are literally `<provider>/<model>` — the resolver uses that
  prefix as an explicit provider hint straight into the matching bucket.
- **Qwen**: matched against the `alibaba` provider bucket.
- **Antigravity**: strips its own reasoning-effort ID suffix (`-high`/`-medium`/`-low`/
  `-thinking`) before matching across the `anthropic`/`google`/`groq` buckets (its fixed model
  list spans those three vendors).

Every match falls back to an exact-only sweep across the rest of the registry as a last resort,
so an unexpected new model ID still has a chance of resolving even before the buckets above are
updated.

**This does not, by itself, unlock cost estimates for Qwen/Antigravity.** Both still have
`HARNESS_TOKEN_SEMANTICS` set to `UNKNOWN` in `ModelPricing.ts` (cache-read/reasoning-token
relationships unverified against a live CLI run — see `dev/backlog/SETTINGS_UI_PARITY_PLAN.md`
and `dev/implemented/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`), and `calculateAttemptCost` refuses to
compute a cost whenever semantics are `UNKNOWN`, on purpose — a guessed cache/reasoning formula
would produce a confidently wrong number, which is worse than no estimate. What the registry
does change is the *reason* shown when cost is unavailable, from "unknown model" to "unverified
token semantics" — and once someone verifies those semantics against a live run and updates
`HARNESS_TOKEN_SEMANTICS`, estimates start flowing immediately with no further pricing work
needed. OpenCode doesn't have this blocker in practice: `OpenCodeLogParser` already reads a
self-reported `part.cost` per attempt, which `calculateAttemptCost` prefers over any registry
price, so the registry only matters there as a rare gap-filler when `part.cost` is missing.

Run `npm test` (`src/test/unit/ModelPricing.test.ts` and
`src/test/unit/ModelPricingRegistry.test.ts`) after re-syncing pricing.

#### Verify + commit (all tracks)

1. **Verify changes**:
   - Check `src/utils/ModelConstants.ts`
   - Check `src/utils/generated/modelPricingRegistryData.json` if 2d was re-run
   - Check `package.json` settings
   - Check `schemas/workflow-schema.json`
   - Check `schemas/workflow-schema.yaml`

   **Note**: The YAML schema is auto-generated during the next `npm run compile`.

2. **Commit all updated files**:
   ```bash
   git add src/utils/ModelConstants.ts src/utils/ModelPricing.ts src/utils/generated/ package.json schemas/
   git commit -m "chore: update model registry with latest models"
   ```

---

### 3. Update VS Code Commands

**Frequency**: When VS Code updates or when we need to refresh command lists

ctrlyoke references VS Code commands (especially chat commands). Keep these up-to-date.

#### Steps:

1. **Launch extension in dev mode**:
   - Press `F5` in VS Code

2. **List all VS Code commands**:
   - Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Run: `ctrlyoke: List All Commands`
   - This outputs all commands to Output panel

3. **List chat-specific commands**:
   - Run: `ctrlyoke: List Chat Commands`
   - Outputs chat-related commands

4. **Update reference documentation**:
   - Copy relevant commands to `docs/reference/VSCODE_COMMANDS.md`
   - Copy chat commands to `docs/reference/CHAT_COMMANDS.md`

5. **Check for new useful commands**:
   - Look for new `workbench.action.chat.*` commands
   - Update `src/core/chat/CopilotChatIntegration.ts` if needed

---

### 4. Update Dependencies

**Frequency**: Monthly or when security vulnerabilities are reported

Keep dependencies up-to-date and secure.

#### Steps:

1. **Check for outdated packages**:

   ```bash
   npm outdated
   ```

2. **Update dependencies**:

   ```bash
   # Update all minor/patch versions
   npm update

   # Or update specific packages
   npm update <package-name>

   # For major version updates
   npm install <package-name>@latest
   ```

3. **Run security audit**:

   ```bash
   npm audit

   # Auto-fix vulnerabilities
   npm audit fix

   # Force fix (may introduce breaking changes)
   npm audit fix --force
   ```

4. **Test after updates**:

   ```bash
   # Compile
   npm run compile

   # Run tests
   npm test

   # Run lint
   npm run lint

   # Format code
   npm run format
   ```

5. **Update TypeScript and VS Code types**:

   ```bash
   npm install --save-dev typescript@latest
   npm install --save-dev @types/vscode@latest
   npm install --save-dev @types/node@latest
   ```

6. **Commit changes**:
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: update dependencies"
   ```

---

### 5. Sync Models Between Components

**Frequency**: After updating ModelConstants.ts or when models are out of sync

Ensures model definitions are consistent across:

- `src/utils/ModelConstants.ts` (source of truth)
- `package.json` (settings enums)
- `schemas/workflow-schema.json` (validation examples)

```bash
# Check if models are in sync
npm run sync-models:check

# Sync models
npm run sync-models
```

---

### 6. Create PNG Icon for Publishing

**Frequency**: Before first release (one-time), or when updating icon

ctrlyoke currently has SVG icons only. VS Code Marketplace requires a PNG icon (at least 128x128px).

**Steps**:

1. Check current icons:

   ```bash
   ls images/
   ```

2. Create PNG version:
   - Use `images/icon.svg` as source
   - Export to `images/icon.png` at 512x512px (recommended) or minimum 128x128px
   - Tools: Inkscape, GIMP, or online SVG-to-PNG converter

3. Update `package.json`:

   ```json
   {
     "icon": "images/icon.png"
   }
   ```

4. Verify icon appears correctly:
   - Package extension: `vsce package`
   - Install VSIX locally and check extension icon

See [images/README.md](images/README.md) for design recommendations.

---

## Pre-Release Checklist

Before releasing a new version, run these tasks:

- [ ] Update CLI tools (check for latest versions)
- [ ] Update models (`npm run chores -- --task sync-models`; export Chat models from VS Code first if needed)
- [ ] Update VS Code commands (list and document)
- [ ] Update dependencies (`npm update` + `npm audit`)
- [ ] Run full test suite (`npm test`)
- [ ] Run linter (`npm run lint:fix`)
- [ ] Format code (`npm run format`)
- [ ] Build production package (`npm run package`)
- [ ] Test extension manually with various workflows
- [ ] Create PNG icon if not done (see chore #6)
- [ ] Update CHANGELOG.md with changes
- [ ] Update version in package.json
- [ ] Create .vscodeignore file (if first release)
- [ ] Package VSIX and test locally
- [ ] Tag release and push to GitHub

See [docs/RELEASE_GUIDE.md](docs/RELEASE_GUIDE.md) for complete publishing instructions.

---

## Automation Script

The `scripts/chores.mjs` script automates common chores:

```bash
# Run all chores
npm run chores -- --task all

# Run specific tasks
npm run chores -- --task sync-models
npm run chores -- --task sync-model-pricing
npm run chores -- --task update-clis
npm run chores -- --task check-clis
npm run chores -- --task update-deps
npm run chores -- --task check-all
```

**Available tasks**:

- `sync-models` - Discover Copilot CLI models (`copilot help config`) + sync the model
  registry to `package.json`/schema; also imports Chat models if `discovered-models.json`
  has been exported from VS Code
- `sync-model-pricing` - Re-download the models.dev registry snapshot used to price every
  harness's models (see section 2d)
- `update-clis` - Update CLI tools (copilot, claude, codex) via their native updaters
- `check-clis` - Check installed CLI tool versions
- `update-deps` - Update and audit dependencies
- `check-all` - Run all checks (lint, format, tests)
- `all` - Run all automated chores (CLI tools, model sync, fallback pricing sync, deps, checks)

---

## Tips

- **Schedule regular maintenance**: Set a monthly reminder to run through these chores
- **After VS Code updates**: Check for new commands and API changes
- **After Copilot updates**: Copilot CLI models refresh automatically via `sync-models`; export from VS Code only if the Chat model superset changed
- **Before major releases**: Run all chores and full test suite
- **Document breaking changes**: Update CHANGELOG.md when CLIs introduce breaking changes

---

## Troubleshooting

### Models not showing in autocomplete

Run the model update workflow (chore #2)

### CLI integration not working

Check CLI versions and update to latest (chore #1)

### Security vulnerabilities

Run `npm audit fix` (chore #4)

### Schema or icon changes not appearing

Run `npm run compile` to regenerate schemas and icons (happens automatically during build)
