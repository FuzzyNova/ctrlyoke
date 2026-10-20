# Codex mapper test still expects deniedTools to be "not enforced"

- **Found:** 2026-10-20 by Claude while running `npm test` on the `bug-fix` worktree
- **Area:** `src/test/unit/HarnessToolPermissionMappers.test.ts`, `src/core/harness/codex/CodexToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

`HarnessToolPermissionMappers > CodexToolPermissionMapper > prepare > reports unsupported lists only when the permission mode applies them` fails on every run, in isolation as well as in the full suite:

```
-     code: 'compatibility.permissions.deniedTools.notEnforced'
+     code: 'compatibility.permissions.deniedTools.partial'
```

## Steps to Reproduce

1. `MOCHA_GREP="HarnessToolPermissionMappers" npm run test:extension`
2. The test above fails on its `deniedTools` diagnostic.

## Root Cause

`aa5007b7f` ("enforce Codex MCP denials") changed `CODEX_PERMISSION_CAPABILITIES.deniedTools` to `fidelity: "partial"` (`CodexToolPermissionMapper.ts`, the `deniedTools` entry), because denied `mcp__<server>__<tool>` patterns now become that server's `disabled_tools`. `getCompatibilityDiagnosticCode` in `src/types/CompatibilityTypes.ts` therefore reports `DENIED_TOOLS_PARTIAL` for a custom-mode `deniedTools` list. The test still asserts `DENIED_TOOLS_NOT_ENFORCED`, the code from before that commit.

## Suggested Fix

Change the test's expected `deniedTools` code to `COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL`, after confirming that "partial" is the intended user-facing diagnostic for a non-MCP denial list (the denial `["shell"]` in the test is not enforced at all, only MCP denials are).
