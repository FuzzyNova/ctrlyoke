# Editing an MCP server splits any argument that contains whitespace

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/shared/McpServerForm.tsx`
- **Resolution:** fixed in this commit

## Symptom

If a stdio MCP server has an argument that contains whitespace, any Edit → Save in the MCP manager splits that argument into several. It happens even when the user changed something unrelated, such as the description. Empty-string arguments are dropped too. The saved server then starts with the wrong argv, or fails to start.

## Steps to Reproduce

1. In `.ctrlyoke/settings.json` (`defaults.mcpServers`), configure a stdio MCP server:
   `{"id":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","C:\\Users\\John Doe\\proj"]}`
2. Open the dashboard Settings → MCP manager and click Edit on the `fs` server.
3. Change only the description and click Save.
4. Re-read `settings.json`. `args` is now `["-y","@modelcontextprotocol/server-filesystem","C:\\Users\\John","Doe\\proj"]`, so the server receives two bogus paths.

## Root Cause

- `src/ui/webview-react/components/shared/McpServerForm.tsx:69` (`serverToMcpServerFormState`) turns the args array into one space-joined string with `server.args.join(" ")`, which loses the argument boundaries.
- `src/ui/webview-react/components/shared/McpServerForm.tsx:148-151` (`mcpServerFormStateToServer`) always deletes `server.args` and re-tokenizes with `form.args.trim().split(/\s+/)`. That ignores quoting and drops empty args. It never falls back to `form.originalServer.args` when the text is unchanged.
- `src/ui/webview-react/components/settings/McpManagerSection.tsx:694-697` (`handleSaveEdit`) runs this conversion on every save, so every edit corrupts the args whether or not the Arguments field was touched.

## Suggested Fix

Any of these would work:

1. **Simplest:** in `mcpServerFormStateToServer`, keep `originalServer.args` when `form.args` still equals the joined string that `serverToMcpServerFormState` produced. Re-tokenize only when the user actually edited the field.
2. **Better:** make `args` a `string[]` in `McpServerFormState` and edit it with a one-row-per-argument editor, like the `KeyValueRowsEditor` used for env and headers. Then there is no string round-trip at all.
3. **Alternative:** serialize args with shell-style quoting and parse them back with a quote-aware tokenizer that keeps empty strings.

Whichever option is chosen, add a round-trip test for args that contain spaces and for empty-string args.
