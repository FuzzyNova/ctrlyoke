import { describe, expect, it } from "vitest";
import { CTRLYOKE_USER_TOOLS } from "@components/shared/McpServersEditor";
import { MCP_WORKFLOW_TOOL_NAMES } from "@root/utils/McpToolDefinitions";

describe("CTRLYOKE_USER_TOOLS", () => {
  it("covers every workflow tool the built-in server exposes", () => {
    // The per-tool checkboxes are the only way to deny an individual ctrlyoke
    // tool, and the header renders "N of CTRLYOKE_USER_TOOLS.length enabled".
    // A tool added to MCP_WORKFLOW_TOOL_NAMES but not here is unreachable in
    // the UI and miscounted, with nothing else to catch it.
    const listed = CTRLYOKE_USER_TOOLS.map((tool) => tool.id);
    expect([...listed].sort()).toEqual([...MCP_WORKFLOW_TOOL_NAMES].sort());
  });

  it("gives every tool a distinct label and description", () => {
    const labels = CTRLYOKE_USER_TOOLS.map((tool) => tool.label);
    const descriptions = CTRLYOKE_USER_TOOLS.map((tool) => tool.description);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
