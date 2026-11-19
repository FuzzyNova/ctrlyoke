# Settings Key Prefix Alignment

**Status:** Deferred. Do this only alongside the next settings schema bump that is needed for
another reason.

## Why

The Global Settings drawer was regrouped (Advanced Permissions removed, Queue merged into
Execution, a new Advanced tab, the terminal toggles moved to Terminal). A few settings now sit
on a tab, or next to settings, whose namespace doesn't match their own key. The UI does not
depend on the prefix (tab placement comes from `settingsCatalog.ts`, and search matches
labels), so this is only about `settings.json` reading sensibly.

It is not worth a bump on its own. Settings v2 shipped in 0.7.1, so a rename means settings
v3, and a file written as v3 is read-only in older ctrlyoke. That hurts a workspace
`settings.json` shared by people on different versions more than the mismatched names do.

## Renames

| Current key                                   | Proposed key                                  | Shown in                                                                   |
| --------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `execution.closeTerminalOnComplete`           | `terminal.closeOnComplete`                    | Terminal → Terminal Behavior                                               |
| `execution.reuseRunningTerminal`              | `terminal.reuseRunning`                       | Terminal → Terminal Behavior                                               |
| `ui.offerTrustForUntrustedFileLinks`          | `permissions.offerTrustForUntrustedFileLinks` | Workflow Defaults → Permissions, beside `permissions.trustedExternalRoots` |
| `permissions.heuristicSecretRedactionEnabled` | `secrets.heuristicRedaction`                  | Secrets tab (there is no `secrets.*` namespace yet)                        |

Judgment calls, left as they are unless the bump happens anyway:

- `execution.ctrlyokeMcpMode`, `execution.autoDeleteTempFiles` and
  `execution.inlineGeneratedPromptOnStdin` are shown on Advanced. They do govern execution,
  so `execution.*` still fits.
- `storage.*` (run history location, trash retention) sits under Run History next to
  `runs.*`. Merging them into one namespace would read better but is not wrong today.

## Doing it

1. `npm run schema:bump`, then add a settings v2 → v3 migration in
   `src/utils/FormatMigrations.ts` that moves each value (keeping an explicitly set new key if
   both are present) and a fixture. Follow "Changing the schemas" in `CONTRIBUTING.md`.
2. Rename the keys in `schemas/settings-schema.json`, `src/types/CtrlYokeSettings.ts`,
   `SETTING_PATHS` and every reader. As of this note: `closeTerminalOnComplete` appears in
   9 source files, `reuseRunningTerminal` in 21, `offerTrustForUntrustedFileLinks` in 9,
   `heuristicSecretRedactionEnabled` in 11 (counts include tests).
3. Update the catalog ids in `settingsCatalog.ts` and the `settingKey`s in the sections.
4. `npm run schema:update`, then fix hand-written docs that name the old keys
   (`docs/guide/terminal.md` names both terminal keys).
5. Changelog under **Changed**, naming old and new keys and that the migration is automatic.
