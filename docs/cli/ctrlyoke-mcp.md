# `ctrlyoke-mcp`

`ctrlyoke-mcp` is the standalone ctrlyoke MCP server binary.

## What it is for

- exposing queue inspection and queue-extension tools to harnesses
- supporting workflows that use `mcpServers: ["ctrlyoke"]`
- letting external MCP-aware tooling talk to ctrlyoke's queue layer

## Typical usage

Most users do not need to start it by hand inside the extension. ctrlyoke can provision the built-in server when a workflow includes the `"ctrlyoke"` server ID.

If you are wiring it into an external MCP client, use it as a stdio server and pair it with the same workspace or queue state that ctrlyoke is operating on.
