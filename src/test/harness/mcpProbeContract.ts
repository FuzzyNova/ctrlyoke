export const MCP_PROBE_CALLS = [
  { tool: "workflow_status" },
  { tool: "post_note", parameters: { text: "mcp probe note" } },
  {
    tool: "claim_paths",
    parameters: { paths: ["probe.txt"], reason: "mcp probe" },
  },
  { tool: "release_paths", parameters: { paths: ["probe.txt"] } },
] as const;

export const MCP_PROBE_TOOLS = MCP_PROBE_CALLS.map((call) => call.tool);
