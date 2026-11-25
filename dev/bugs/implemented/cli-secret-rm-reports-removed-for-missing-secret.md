# `secret rm` reports a secret removed when nothing was stored under that name and scope

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/cli/SecretCommands.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke secret rm <NAME> --yes` always prints
`Removed secret <NAME> from <scope> scope.` (JSON: `"removed": true`) and exits
0, whether or not that key existed. Because `--scope` defaults to `user`, a
secret stored at **workspace** scope is left in the credential store while the
CLI tells the user it is gone. That matters for a user revoking a leaked
token. A typo'd name is reported as removed too.

## Steps to Reproduce

```
$ printf v1 | ctrlyoke secret set ZZTESTBUG --scope workspace --stdin --json
{"schemaVersion":1,"success":true,"name":"ZZTESTBUG","scope":"workspace","stored":true}
$ ctrlyoke secret rm ZZTESTBUG --yes --json        # exit 0
{"schemaVersion":1,"success":true,"name":"ZZTESTBUG","scope":"user","removed":true}
$ ctrlyoke secret list --json
{"schemaVersion":1,"success":true,"entries":[{"name":"ZZTESTBUG","scope":"workspace","state":"managed-and-set",...}]}
```

## Root Cause

`removeSecretCommand` (`src/cli/SecretCommands.ts:160-195`) calls
`dependencies.secretStore.delete(secretKeyForScope(scope, workspaceRoot, name))`,
which returns nothing, then unconditionally writes `{ name, scope, removed: true }`
and the "Removed secret" text. It never checks whether that key existed.

## Suggested Fix

Before deleting, read the key (`secretStore.get(key)`, or check
`secretStore.keys()`), and report `removed: false` with text such as
`No secret <NAME> is stored at user scope.` when it was absent. When the other
scope holds the name, add a hint to pass `--scope workspace` (or `user`). Keep
exit code 0 for an absent key (idempotent removal; `removed: false` is
additive within `schemaVersion: 1`). Document the `removed: false` case in the
`secret` section of `docs/cli/ctrlyoke.md`, add a `CHANGELOG.md` **Changed**
entry, and cover both cases in `src/test/unit/SecretCommands.test.ts`.
