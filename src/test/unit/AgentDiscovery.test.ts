import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import {
  AgentDiscovery,
  getBuiltInAgentsDirectoryCandidates,
  parseAgentFrontmatter,
} from "../../utils/AgentDiscovery";
import { DISCOVERY_SOURCES } from "../../types/DashboardConstants";

suite("AgentDiscovery", () => {
  test("reads agent name and folded description from YAML frontmatter", () => {
    const frontmatter = parseAgentFrontmatter(`---
name: Focused Reviewer
description: >
  Reviews a focused change and reports actionable findings
  without modifying files.
---
Agent instructions`);

    assert.strictEqual(frontmatter.name, "Focused Reviewer");
    assert.strictEqual(
      frontmatter.description,
      "Reviews a focused change and reports actionable findings without modifying files.\n"
    );
  });

  test("resolves the esbuild extension bundle template location", () => {
    const extensionBundleDirectory = path.resolve(__dirname, "../..");
    const candidates = getBuiltInAgentsDirectoryCandidates(
      extensionBundleDirectory
    );

    assert.ok(
      candidates.includes(
        path.join(extensionBundleDirectory, "templates", "agents")
      ),
      "an esbuild bundle in out/ must look for out/templates/agents"
    );
  });

  test("discovers built-in agents with frontmatter descriptions", async () => {
    const agents = await AgentDiscovery.discoverBuiltInAgents();
    const supportAgent = agents.find(
      (agent) => agent.name === "ctrlyoke-tech-support"
    );

    assert.ok(supportAgent, "the bundled support agent should be discovered");
    assert.strictEqual(supportAgent.source, DISCOVERY_SOURCES.BUILT_IN);
    assert.ok(supportAgent.path.endsWith("ctrlyoke-tech-support.agent.md"));
    assert.strictEqual(supportAgent.displayName, "Ctrlyoke Tech Support");
    assert.ok(supportAgent.description?.includes("ctrlyoke setup"));
  });

  test("includes built-in agents when no workspace is supplied", async () => {
    const agents = await AgentDiscovery.discoverAgents();

    assert.ok(
      agents.some((agent) => agent.name === "ctrlyoke-workflow-composer"),
      "built-in agents should be available before a workspace is opened"
    );
  });
});
