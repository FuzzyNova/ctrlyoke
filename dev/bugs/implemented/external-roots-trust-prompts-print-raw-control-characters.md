# External-roots trust prompts show workspace-supplied control characters raw

- **Found:** 2026-11-09 by bug-hunt final step (pass 28), claude-cli
- **Area:** `src/cli/ExternalRootsTrustCommands.ts`, `src/ui/ExternalRootsApproval.ts`
- **Resolution:** fixed in this commit

## Symptom

`dev/bugs/implemented/cli-trust-prompts-print-raw-control-characters.md`
(~2c8fac8) added `escapeUntrustedDisplayText` and applied it to the
workspace-settings trust prompts and to `ensureCliTrustDecided`, the gate
that `ctrlyoke run` uses. The two explicit review commands for external file
roots were missed. `ctrlyoke trust-external-roots` (roots from
`permissions.trustedExternalRoots` in the workspace's `.ctrlyoke/settings.json`)
and `ctrlyoke trust-workflow-external-roots <file>` (roots from a workflow's
`trustedExternalRoots`) still write each requested root to the terminal byte
for byte, then ask `Trust all N listed folder(s)? [y/N]`.

Reproduced against `out/cli.js`:

```
$ cat .ctrlyoke/settings.json
{"permissions":{"trustedExternalRoots":["/tmp/evil\u001b[2K\r/Users/me/safe"]}}
$ ctrlyoke trust-external-roots </dev/null 2>&1 | cat -v
This workspace requests 1 external file root(s):
  - /tmp/evil^[[2K^M/Users/me/safe
```

The workflow command behaves the same with
`trustedExternalRoots: ["/tmp/evil2\e[2K\r/Users/me/docs"]`. In a real
terminal, `ESC[2K` erases the line and `\r` returns to column 0, so the user
sees `  - /Users/me/safe` and is asked to trust it. If they answer `y`, the
root that is actually trusted is the hidden one.

The dashboard and VS Code prompt for the same roots
(`promptBatchApprovalForPendingRoots`) renders through React, so terminal
escapes are inert there. However, its item `label` is the raw root, so
bidirectional overrides (U+202E and friends) and zero-width characters still
reorder or hide parts of the path. The workspace-settings prompt escapes
those.

## Steps to Reproduce

1. In a scratch git repo, write the `.ctrlyoke/settings.json` above.
2. Run `node <repo>/out/cli.js trust-external-roots` in a terminal, or with
   `</dev/null 2>&1 | cat -v` to see the bytes.
3. The listed root shows as `/Users/me/safe`.

## Root Cause

- `trustExternalRootsCommand` in `src/cli/ExternalRootsTrustCommands.ts`
  (line 26) writes `` `  - ${root}` `` without escaping. Both CLI commands
  (`trustExternalRootsCommand` and `trustWorkflowExternalRootsCommand` in
  `src/cli.ts`) call it through `reviewExternalRootsCommand`.
- `promptBatchApprovalForPendingRoots` in `src/ui/ExternalRootsApproval.ts`
  (line 236) passes `label: root` unescaped.

## Suggested Fix

Apply `escapeUntrustedDisplayText(root, { escapeNewlines: true })` from
`src/utils/EscapeUntrustedDisplayText.ts` to each root when it is displayed:
the CLI list line in `ExternalRootsTrustCommands.ts`, and the `label` (not the
`value`) in `promptBatchApprovalForPendingRoots`. Keep the stored decision
keyed on the real root string, so existing decisions stay valid. Add a test in
`src/test/unit/ExternalRootsTrustCommands.test.ts` for a root containing
ESC/CR/U+202E: the escaped text is listed, no raw control byte is written, and
`setDecisions` still receives the raw root. Add a test in
`src/test/unit/ExternalRootsApproval.test.ts` that the item label is escaped
and the value is raw.
