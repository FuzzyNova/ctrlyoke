# Managed secrets set in the dashboard are invisible to the CLI, and the reverse

- **Found:** 2026-10-11 while writing `docs/workflows/secrets.md` (docs Wave 3)
- **Area:** `src/extension.ts`, `src/platform/VsCodeAdapter.ts`, `src/platform/OsCredentialStore.ts`, `src/ui/webview-react/components/settings/SecretsSection.tsx`
- **Severity:** medium

## Symptom

A managed workflow secret set from **Settings → Secrets** in VS Code is not found by
`ctrlyoke run` or `ctrlyoke secret list`, and a secret set with `ctrlyoke secret set` does
not appear in the dashboard's Secrets tab. A workflow that works from the dashboard fails
(or warns about a missing value) when the same workflow runs from a terminal or CI shell
on the same machine.

The Secrets tab copy says ctrlyoke "encrypts it in OS-backed storage", which suggests one
shared store.

## Steps to Reproduce

1. In the dashboard, **Settings → Secrets → Set secret**, name `DEMO_API_KEY`, any value.
2. In a terminal in the same workspace, run `ctrlyoke secret list`.
3. `DEMO_API_KEY` is not listed; a workflow granting `!DEMO_API_KEY` run with
   `ctrlyoke run` reports the value as missing.

## Root Cause

`extension.ts` builds two stores. License and server tokens use a `FallbackSecretStore`
that prefers `OsCredentialStore` (shared by every profile, the CLI and `ctrlyoke server`).
Managed workflow secrets deliberately keep `VsCodeAdapter.getSecretStore()`, which is VS
Code's per-profile `context.secrets` (see the comment above `machineSecretStore`). The CLI
only reads `OsCredentialStore`.

## Suggested Fix

Move managed workflow secrets onto the same OS-first `FallbackSecretStore` the license
uses, with a one-time migration of existing entries out of `context.secrets`. If the split
is kept on purpose, say so in the Secrets tab and in `docs/workflows/secrets.md` (which
currently documents the split as-is).
