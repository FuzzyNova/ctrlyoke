import * as assert from "assert";
import { suite, test } from "mocha";
import { AgentDiscovery } from "../../utils/AgentDiscovery";
import { DISCOVERY_SOURCES } from "../../types/DashboardConstants";

suite("AgentDiscovery", () => {
  test("discovers manifest-curated built-in agents with their descriptions", async () => {
    const agents = await AgentDiscovery.discoverBuiltInAgents();
    const supportAgent = agents.find(
      (agent) => agent.name === "ctrlyoke-tech-support"
    );

    assert.ok(supportAgent, "the bundled support agent should be discovered");
    assert.strictEqual(supportAgent.source, DISCOVERY_SOURCES.BUILT_IN);
    assert.ok(supportAgent.path.endsWith("ctrlyoke-tech-support.agent.md"));
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
