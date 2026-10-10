# Development Guide

## Linting & Formatting

This project uses **ESLint** for linting and **Prettier** for code formatting.

### Available Commands

#### Linting

```bash
# Run ESLint to check for code issues
npm run lint

# Run ESLint and auto-fix issues where possible
npm run lint:fix
```

#### Formatting

```bash
# Format all files with Prettier
npm run format

# Check if files are formatted correctly (without changing them)
npm run format:check
```

### Editor Setup

For the best development experience, install these VS Code extensions:

- **ESLint** (`dbaeumer.vscode-eslint`) - Shows linting errors in real-time
- **Prettier** (`esbenp.prettier-vscode`) - Format on save support

### Configuration Files

- `.prettierrc.json` - Prettier configuration
- `.prettierignore` - Files to exclude from formatting
- `eslint.config.mjs` - ESLint configuration (ESM format)

### Pre-commit Workflow

Before committing code, run:

```bash
npm run lint:fix   # Fix linting issues
npm run format     # Format code
npm run compile    # Ensure TypeScript compiles
npm test           # Run tests
```

### Prettier Settings

- **Semi-colons**: Required (`;`)
- **Quotes**: Double quotes (`"`)
- **Line width**: 80 characters
- **Indentation**: 2 spaces
- **Trailing commas**: ES5 compatible
- **Line endings**: LF (Unix-style)

### ESLint Rules

Key rules enforced:

- TypeScript naming conventions for imports
- Curly braces required for all control structures
- Strict equality (`===`) required
- No throwing literals (throw proper Error objects)
- Semi-colons required

### VS Code Settings

Add to your `.vscode/settings.json` for auto-format on save:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.codeActionsOnSave": {
      "source.fixAll.eslint": "explicit"
    }
  }
}
```

This will:

- Format files with Prettier on save
- Auto-fix ESLint issues on save

## Testing the CLI Locally

`npx` has no notion of dev builds. Use `npm link` for fast iteration, or a packed tarball to test the real npm package.

### Fast iteration: `npm link`

```powershell
npm run compile:extension   # rebuilds out/cli.js
npm link                    # one time
```

The root `package.json` declares `"bin": { "ctrlyoke": "./out/cli.js" }`, so `npm link` puts a global `ctrlyoke` command on your PATH that points at this checkout. Run it from any directory:

```powershell
cd C:\some\other\project
ctrlyoke run my-workflow.ctrlyoke.yaml
```

After that, each `npm run compile:extension` is picked up immediately. Remove the link with `npm unlink -g ctrlyoke`.

Caveats:

- This is the extension-layout build with the repo's root `package.json`, not the exact package users install.
- It shadows any published `ctrlyoke` installed globally until you unlink.

### Pre-publish check: pack the real npm package

`scripts/build-npm-package.mjs` assembles the publishable package in `dist/npm/` with its own generated `package.json` (the root one is never published).

```powershell
npm run build:extension                # production build (IS_DEV_MODE=false)
node scripts/build-npm-package.mjs     # assembles dist/npm/
cd dist\npm
npm pack                               # creates ctrlyoke-<version>.tgz
```

Install the tarball elsewhere:

```powershell
npm install -g C:\dev\ctrlyoke\dist\npm\ctrlyoke-<version>.tgz
# or without installing:
npx --package C:\dev\ctrlyoke\dist\npm\ctrlyoke-<version>.tgz ctrlyoke run ...
```

This exercises the package's file list, the runtime assets under `out/`, and the shims, so a missing asset shows up here and not in the linked build. `scripts/build-npm-package.test.mjs` automates the same pack, install, `--version` and `validate` sequence.

## Developer Chores

Regular maintenance tasks are documented in **[CHORES.md](./CHORES.md)**:

- Updating CLI tools (Copilot, Claude, Codex)
- Syncing model registries
- Updating VS Code command references
- Dependency updates and security audits

**Quick reference**:

```bash
# Run automated chores
npm run chores -- --task all

# Run specific task
npm run chores -- --task update-deps
npm run chores -- --task sync-models
npm run chores -- --task check-all

# See all available tasks
npm run chores -- --help
```

See [CHORES.md](./CHORES.md) for complete documentation.
