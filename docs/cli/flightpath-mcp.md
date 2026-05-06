# `flightpath-mcp`

`flightpath-mcp` is the standalone FlightPath MCP server binary.

## What it is for

- exposing queue inspection and queue-extension tools to harnesses
- supporting workflows that use `mcpServers: ["flightpath"]`
- letting external MCP-aware tooling talk to FlightPath's queue layer

## Typical usage

Most users do not need to start it by hand inside the extension. FlightPath can provision the built-in server when a workflow includes the `"flightpath"` server ID.

If you are wiring it into an external MCP client, use it as a stdio server and pair it with the same workspace or queue state that FlightPath is operating on.
