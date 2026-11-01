# CLI and privacy docs say headless commands make no network requests, but `ctrlyoke license` contacts Keygen

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `docs/cli/index.md`, `docs/guide/privacy.md`
- **Severity:** low

## Symptom

- `docs/cli/index.md:77-83` says "Headless CLI commands other than
  `ctrlyoke server` do not check a license" and that they "send no telemetry
  and make no network requests of their own".
- `docs/guide/privacy.md:33-38` makes the same "no network requests of their
  own" claim in bold.

Both are wrong for the `ctrlyoke license` commands:

- `license activate` calls `LicenseService.activateWithKey`, which validates
  the key and activates the machine with Keygen
  (`src/cli/LicenseCommands.ts:140-160`, `src/license/LicenseService.ts`).
- `license deactivate` releases the machine with Keygen.
- `license status` checks the stored license through `getEntitlement`
  (`src/cli/LicenseCommands.ts:66-73`), so "do not check a license" is also wrong.

The docs contradict themselves: `docs/cli/ctrlyoke.md:584-585` says activation
"registers this machine with Keygen", and the privacy page's own table
("Other network requests") lists Keygen on activate and deactivate.

## Steps to Reproduce

1. Read `docs/cli/index.md` "License and privacy" and the privacy guide's
   headless paragraph.
2. Run `ctrlyoke license activate --stdin` with a key: it contacts Keygen.

## Root Cause

`dev/bugs/implemented/cli-docs-claim-server-makes-no-network-or-license-calls.md`
added `ctrlyoke server` as the only exception. The `license` commands landed
later and the wording was never updated.

## Suggested Fix

Name `ctrlyoke license activate|deactivate` (and `status`, if `getEntitlement`
can refresh online) as exceptions in both pages, linking to the privacy
page's "Other network requests" table. Verify against `LicenseService` whether
`license status` can actually make a network request before claiming it does.
