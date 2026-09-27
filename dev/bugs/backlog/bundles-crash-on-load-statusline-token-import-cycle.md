# Extension, CLI and MCP server bundles crash on load (DashboardConstants ↔ TokenFormatting import cycle)

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/utils/StatuslineFormat.ts`, `src/utils/TokenFormatting.ts`, `src/utils/TokenSemantics.ts`, `src/types/DashboardConstants.ts`, `esbuild.js` bundles
- **Severity:** critical

## Symptom

After building with `node esbuild.js`, every main bundle throws while loading,
before any code runs:

```
$ node out/cli.js --version
TypeError: Cannot read properties of undefined (reading 'CLAUDE_CLI')
    at src/utils/TokenSemantics.ts (out/cli.js:207:20)
    at src/utils/TokenFormatting.ts (out/cli.js:327:5)
    at src/utils/StatuslineFormat.ts (out/cli.js:386:5)
    at src/types/DashboardConstants.ts (out/cli.js:580:5)
    ...
```

The same `CLAUDE_CLI` error is thrown by `out/mcp-server.js` (any `--tool` call) and by
`out/extension.js` (checked by `require`-ing it with a stubbed `vscode` module). So the
VS Code extension can't activate, and the `ctrlyoke` and `ctrlyoke-mcp` binaries can't
start. The statusline script bundle (`out/scripts/ctrlyoke-statusline-format.js`) still
loads.

`npm test` did not catch this. The mocha suite loads tsc's per-file output in an order
that happens to work, and nothing smoke-loads the esbuild bundles.

## Steps to Reproduce

1. `node esbuild.js`
2. `node out/cli.js --version`, which throws the error above.
3. `node out/mcp-server.js --tool workflow_status --args '{}'`, which throws the same error.

## Root Cause

Commit `63c11521` ("fix(tokens): promote to the next unit when rounding reaches 1000")
added `import { formatCompactTokenMagnitude } from "./TokenFormatting"` to
`StatuslineFormat.ts`. Before that commit the module had no imports. This closed the cycle:

`DashboardConstants.ts` (line 15 imports `formatUsageWindowLabel` from `StatuslineFormat`)
→ `StatuslineFormat.ts` → `TokenFormatting.ts` → `TokenSemantics.ts`
→ `DashboardConstants.ts` (still initialising)

Bisect proof: bundling `src/mcp-server.ts` with the same esbuild options, but with
`StatuslineFormat.ts` taken from `63c11521^`, produces a bundle that loads and exports
`CtrlYokeMCPServer`. The HEAD bundle throws.

`TokenSemantics.ts` builds `HARNESS_TOKEN_SEMANTICS` at module-evaluation time using
`HARNESS_IDS.CLAUDE_CLI` as a computed key. When `DashboardConstants` starts evaluating
first, which it does in the bundles, `HARNESS_IDS` is not yet defined.

The same cycle also pulls `DashboardConstants` and its dependencies into the standalone
statusline script, which runs from the shared `~/.ctrlyoke/bin` launcher and previously
had no dependencies.

## Suggested Fix

Break the cycle at its source rather than reordering imports:

- Move the compact k/M/B magnitude ladder (`formatCompactTokenMagnitude` and whatever it
  needs) into a new import-free leaf module, e.g. `src/utils/CompactMagnitude.ts`, and
  import it from both `TokenFormatting.ts` and `StatuslineFormat.ts`. The webview's
  `number.ts` already reuses the ladder, so point it at the same leaf.
- `StatuslineFormat.ts` should import only import-free leaf modules. Add a short comment
  saying so, because the module is bundled standalone into the shared launcher script.

Add regression coverage that would have caught this:

- A `node --test` script in the `test:packaging` list (see `scripts/*.test.mjs`) that,
  after the build, runs `node out/cli.js --version` and
  `node out/mcp-server.js --tool list_harnesses ...`, or simply `require`s both bundles,
  and `require`s `out/extension.js` with a stubbed `vscode` module. It should assert that
  none of them throws at load.
- Optionally, a unit test asserting that `StatuslineFormat.ts` imports nothing except
  import-free leaf modules.
