import * as assert from "assert";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import { AgentExpander } from "../../utils/AgentExpander";
import { HARNESS_IDS, type HarnessId } from "../../types/DashboardConstants";
import { SkillDiscovery, type SkillInfo } from "../../utils/SkillDiscovery";
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

suite("SkillDiscovery helpers", () => {
  let tempRoot: string;
  let workspaceRoot: string;

  setup(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-skills-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    await fsp.mkdir(workspaceRoot, { recursive: true });
  });

  teardown(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  function skill(name: string, skillPath: string): SkillInfo {
    return {
      name,
      displayName: name,
      path: skillPath,
      description: "",
      source: "workspace",
    };
  }

  async function createSkill(directory: string, name: string): Promise<string> {
    const skillDirectory = path.join(directory, name);
    await fsp.mkdir(skillDirectory, { recursive: true });
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fsp.writeFile(skillPath, "# skill\n");
    return skillPath;
  }

  test("identifies a skill native to one harness but not another", async () => {
    const claudePath = await createSkill(
      path.join(workspaceRoot, ".claude", "skills"),
      "shared"
    );
    const discovered = skill("shared", claudePath);

    assert.strictEqual(
      SkillDiscovery.isSkillNativeToHarness(
        discovered,
        HARNESS_IDS.CLAUDE_CLI,
        workspaceRoot
      ),
      true
    );
    assert.strictEqual(
      SkillDiscovery.isSkillNativeToHarness(
        discovered,
        HARNESS_IDS.COPILOT_CLI,
        workspaceRoot
      ),
      false
    );
    assert.strictEqual(
      SkillDiscovery.findSkillForHarness(
        [discovered],
        "shared",
        HARNESS_IDS.CLAUDE_CLI,
        workspaceRoot
      ),
      discovered
    );
    assert.strictEqual(
      SkillDiscovery.findSkillForHarness(
        [discovered],
        "shared",
        HARNESS_IDS.COPILOT_CLI,
        workspaceRoot
      ),
      undefined
    );
  });

  test("identifies a ctrlyoke-only skill", async () => {
    const ctrlyokePath = await createSkill(
      path.join(workspaceRoot, ".ctrlyoke", "skills"),
      "portable"
    );
    const discovered = skill("portable", ctrlyokePath);

    for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
      assert.strictEqual(
        SkillDiscovery.isSkillNativeToHarness(
          discovered,
          harnessId,
          workspaceRoot
        ),
        false
      );
    }
    assert.strictEqual(
      SkillDiscovery.resolveCtrlYokeSkillInvocation(
        [discovered],
        "portable",
        HARNESS_IDS.COPILOT_CLI,
        workspaceRoot
      ),
      discovered
    );
  });

  test("resolves duplicate names using discovery precedence", () => {
    const first = skill("duplicate", path.join(tempRoot, "first", "SKILL.md"));
    const second = skill(
      "duplicate",
      path.join(tempRoot, "second", "SKILL.md")
    );

    assert.strictEqual(
      SkillDiscovery.resolveCtrlYokeSkillInvocation(
        [first, second],
        "duplicate",
        HARNESS_IDS.COPILOT_CLI,
        workspaceRoot
      ),
      first
    );
  });
});
