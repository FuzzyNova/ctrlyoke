import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { AgentExpander } from "../../utils/AgentExpander";
import {
  AgentDiscovery,
  getBuiltInAgentsDirectoryCandidates,
  parseAgentFrontmatter,
} from "../../utils/AgentDiscovery";
import { DISCOVERY_SOURCES } from "../../types/DashboardConstants";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

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

  test("parses frontmatter with an empty block or padded closing fence", () => {
    assert.deepStrictEqual(parseAgentFrontmatter("---\n---\nAgent body"), {});

    const paddedFence = parseAgentFrontmatter(
      "---\nname: Padded Agent\ndescription: discovered\n--- \nAgent body"
    );
    assert.strictEqual(paddedFence.name, "Padded Agent");
    assert.strictEqual(paddedFence.description, "discovered");

    assert.strictEqual(
      AgentExpander.stripFrontmatter("---\n---\nAgent body", "empty"),
      "Agent body"
    );
    assert.strictEqual(
      AgentExpander.stripFrontmatter(
        "---\nname: Padded Agent\nmodel: ignored\n---\t\nAgent body",
        "padded"
      ),
      "Agent body"
    );
  });

  test("reads declared skills as a YAML list or a comma-separated string", () => {
    assert.deepStrictEqual(
      parseAgentFrontmatter("---\nskills: [alpha, beta, alpha]\n---\nBody")
        .skills,
      ["alpha", "beta"]
    );
    assert.deepStrictEqual(
      parseAgentFrontmatter("---\nskills: alpha, beta\n---\nBody").skills,
      ["alpha", "beta"]
    );
    assert.strictEqual(
      parseAgentFrontmatter("---\nskills: []\n---\nBody").skills,
      undefined
    );
    assert.strictEqual(
      parseAgentFrontmatter("---\nskills: 3\n---\nBody").skills,
      undefined
    );
  });

  test("parses line-anchored frontmatter with inline fences and a BOM", async () => {
    const content =
      "\uFEFF---\nname: Reviewer\ndescription: Reviews diffs --- strictly\nmodel: gpt-5\n---\nAgent body";
    const frontmatter = parseAgentFrontmatter(content);

    assert.strictEqual(frontmatter.name, "Reviewer");
    assert.strictEqual(frontmatter.description, "Reviews diffs --- strictly");
    assert.strictEqual(
      AgentExpander.stripFrontmatter(content, "reviewer"),
      "Agent body"
    );

    const workspaceRoot = makeTempDir("ctrlyoke-bom-agent-");
    const agentDirectory = path.join(workspaceRoot, ".github", "agents");
    const agentPath = path.join(agentDirectory, "bom-agent.md");
    try {
      fs.mkdirSync(agentDirectory, { recursive: true });
      fs.writeFileSync(agentPath, content);
      const agents = await AgentDiscovery.discoverAgents(workspaceRoot);
      const discovered = agents.find((agent) => agent.name === "bom-agent");

      assert.ok(
        discovered,
        "BOM-prefixed plain Markdown agents are discovered"
      );
      assert.strictEqual(discovered?.description, "Reviews diffs --- strictly");
    } finally {
      removeTempDir(workspaceRoot);
    }
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
