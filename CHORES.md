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

**After updating**: Test CLI integrations with manual test files in `manual-test/`

---

### 2. Update Chat Models

**Frequency**: When new Copilot/Claude/Codex models are released

This workflow discovers new models available in GitHub Copilot Chat and updates ctrlyoke's model registry.

#### Steps:

1. **Launch extension in dev mode**:
   - Press `F5` in VS Code to start debugging session

2. **Export discovered models**:
   - Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Run: `ctrlyoke: Export Discovered Models`
   - This creates/updates `scripts/discovered-models.json`

3. **Import models to ModelConstants.ts**:

   ```bash
   npm run sync-models:import
   ```

4. **Sync to package.json and schema**:

   ```bash
   npm run sync-models
   ```

   This updates:
   - `package.json` settings enums
   - `schemas/workflow-schema.json` model examples

5. **Verify changes**:
   - Check `src/utils/ModelConstants.ts`
   - Check `package.json` settings
   - Check `schemas/workflow-schema.json`
   - Check `schemas/workflow-schema.yaml`

   **Note**: The YAML schema is auto-generated during the next `npm run compile`.

6. **Commit all updated files**:
   ```bash
   git add src/utils/ModelConstants.ts package.json schemas/
   git commit -m "chore: update model registry with latest models"
   ```

**Alternative - Check CLI models**:

```bash
# See current CLI-supported models
node scripts/sync-models.mjs --discover
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
- [ ] Update chat models (export and sync)
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
npm run chores

# Run specific tasks
npm run chores -- --task update-models
npm run chores -- --task update-deps
npm run chores -- --task check-all
```

**Available tasks**:

- `update-models` - Update model registry
- `update-deps` - Update and audit dependencies
- `check-all` - Run all checks (lint, format, tests)
- `all` - Run all chores

---

## Tips

- **Schedule regular maintenance**: Set a monthly reminder to run through these chores
- **After VS Code updates**: Check for new commands and API changes
- **After Copilot updates**: Export models and check for new features
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
