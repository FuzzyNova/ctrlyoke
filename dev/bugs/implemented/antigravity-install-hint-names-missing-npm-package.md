# Antigravity install hint names an npm package that does not exist

- **Found:** 2026-10-05 by Claude Code while adding harness version floors
- **Area:** `src/core/harness/antigravity/AntigravityCliProvider.ts`
- **Resolution:** fixed in this commit; every harness now shows its vendor installer for the host OS, and Antigravity's is Google's `install.sh`/`install.ps1`

## Symptom

When `agy` is not installed, every install surface (the dashboard's harness
picker tooltip, the first-run `HarnessPreflightPanel`, and the run-time
"unavailable" message) tells the user to run
`npm install -g @google/antigravity-cli`. That package is not on npm:
`npm view @google/antigravity-cli` returns `E404 Not Found`, so the suggested
command fails.

## Steps to Reproduce

1. On a machine without `agy`, open the dashboard and hover Antigravity in the
   harness picker (or run `npm view @google/antigravity-cli`).
2. Run the suggested command.
3. npm fails with a 404.

## Root Cause

`AntigravityCliProvider.config.installHint` is a guessed npm command. The
working `agy` install on the development machine lives at
`%LOCALAPPDATA%\agy\bin\agy.exe`, i.e. it came from a native installer, not
npm. `scripts/harness-version-floors.mjs` hits the same 404 when it derives the
package from the install hint, which is why Antigravity's version minimum is
chosen by hand.

## Suggested Fix

Replace the hint with Antigravity's documented installer (or a link to its
install page) once confirmed, and update `docs/harnesses/antigravity-cli.md`,
which currently only says "Install and authenticate `agy`". Updating is
unaffected: `versionPolicy.updateCommand` is `agy update`, which `agy --help`
lists.
