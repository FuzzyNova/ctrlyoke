# Older-CLI notice counts bundled and repo-checkout CLIs as npm installs

- **Found:** 2026-10-22 by Nathan, installing a local 0.2.1 VSIX during release prep
- **Area:** `src/utils/CtrlyokeInstallations.ts`, `src/cli/CliInstallationNotice.ts`, `src/ui/CtrlyokeCliCommands.ts`
- **Resolution:** fixed in this commit

## Symptom

After the extension updates, it can show:

> ctrlyoke CLI 0.2.0 is older than this extension (0.2.1)
>
> The CLI installed at C:\dev\ctrlyoke.worktrees\bug-fix shares run history and settings with
> this extension. Keep both on the same version so they read that state the same way.

The "CLI" it names is not an npm install. On a dev machine it is a repo checkout. The same thing
probably happens to users with the CLI copy bundled inside the previous extension version's folder.

## Steps to Reproduce

1. Run a checkout's compiled CLI (`node out/cli.js …`, or `npm run test:harness`, which runs it)
   from a worktree whose `package.json` version is older than the extension you will install.
2. Install a newer extension (`npm run package:install`) and reload VS Code.
3. The older-CLI notice names that worktree. `~/.ctrlyoke/installations.json` lists every checkout
   that has run its CLI in the last 30 days as `kind: "cli"`.

Likely user-facing variant (not reproduced): run `ctrlyoke` in a VS Code terminal with the extension
at 0.2.0, either yourself or through an agent, since the bundled `bin/` is on PATH for terminals and
harness processes. Then let the Marketplace update the extension to 0.2.1. While
`~/.vscode/extensions/fuzzynova.ctrlyoke-0.2.0` still exists, the notice names it, even though the
user never installed the npm CLI.

## Root Cause

`noteCliInstallation()` (`src/cli/CliInstallationNotice.ts`) records every CLI run as
`INSTALLATION_KINDS.CLI`, and only checks `isBundledInExtension()` afterwards, to suppress the CLI's
own stderr warning. `findOlderCli()` (`src/utils/CtrlyokeInstallations.ts`) then treats every `cli`
record older than the extension as an npm install. It assumes a bundled copy shares the _current_
extension's root and version. A bundled copy in a previous version's folder breaks that assumption,
and so does a repo checkout, whose `package.json` also declares `engines.vscode`.

## Suggested Fix

Count only real npm packages as "an older CLI": skip `cli` records whose `packageRoot` passes
`isBundledInExtension()` (its `package.json` declares `engines.vscode`, which covers the bundled copy
and repo checkouts). Apply the check when reading the registry rather than when writing it, so records
already on disk are covered without a format change. Move `isBundledInExtension()` into `src/utils/` so
the extension side can use it without importing from `src/cli/`. Add `findOlderCli()` cases for a
bundled root from an older extension folder and for a checkout root.
