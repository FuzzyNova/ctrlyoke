import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { AgentExpander } from "../../utils/AgentExpander";
import { SkillDiscovery } from "../../utils/SkillDiscovery";
import { SkillExpander } from "../../utils/SkillExpander";

suite("Execution-root asset discovery", () => {
  test("workspace agents and skills resolve from the supplied root", async () => {
    const executionRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-asset-root-")
    );
    const agentPath = path.join(
      executionRoot,
      ".ctrlyoke",
      "agents",
      "execution-agent.agent.md"
    );
    const skillPath = path.join(
      executionRoot,
      ".ctrlyoke",
      "skills",
      "execution-skill",
      "SKILL.md"
    );

    try {
      fs.mkdirSync(path.dirname(agentPath), { recursive: true });
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(agentPath, "---\nname: Execution Agent\n---\nagent body");
      fs.writeFileSync(
        skillPath,
        "---\ndescription: execution skill\n---\nskill body"
      );

      const agent = await AgentExpander.expandAgent(
        "execution-agent",
        executionRoot
      );
      const skills = await SkillExpander.expandSkills(
        ["execution-skill"],
        executionRoot
      );

      assert.strictEqual(agent, "agent body");
      assert.ok(skills?.includes(path.join(executionRoot, ".ctrlyoke")));
      assert.ok(skills?.includes("execution skill"));
    } finally {
      fs.rmSync(executionRoot, { recursive: true, force: true });
    }
  });

  test("findGitRoot recognizes a linked-worktree .git pointer file", async () => {
    const worktreeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-linked-worktree-")
    );
    const nestedDirectory = path.join(worktreeRoot, "nested", "src");

    try {
      fs.mkdirSync(nestedDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeRoot, ".git"),
        "gitdir: /shared/repository/.git/worktrees/linked"
      );

      assert.strictEqual(
        await SkillDiscovery.findGitRoot(nestedDirectory),
        worktreeRoot
      );
    } finally {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });
});
