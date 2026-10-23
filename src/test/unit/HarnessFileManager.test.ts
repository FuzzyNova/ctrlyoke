import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import * as HarnessDirectoryUtils from "../../utils/HarnessDirectoryUtils";
import {
  HarnessFileManager,
  SKILL_ORIGIN_FILE_NAME,
} from "../../utils/HarnessFileManager";
import { SkillDiscovery } from "../../utils/SkillDiscovery";
import {
  HARNESS_FILE_TYPES,
  HARNESS_IDS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "../../types/DashboardConstants";

suite("HarnessFileManager", () => {
  let workspaceRoot: string;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-harness-file-manager-")
    );
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("enumerates bundled skills as exportable managed files", async () => {
    const files = await HarnessFileManager.resolveAllLocations(
      workspaceRoot,
      HARNESS_FILE_TYPES.SKILL
    );
    const builtIn = files.find((file) => file.name === "ctrlyoke-mcp-tools");

    assert.ok(builtIn);
    assert.strictEqual(builtIn?.type, HARNESS_FILE_TYPES.SKILL);
    assert.strictEqual(builtIn?.locations.length, 0);
    assert.ok(builtIn?.builtInSourcePath);
  });

  test("snapshots generated MCP tool references when exporting a built-in skill", async () => {
    const builtIn = (await SkillDiscovery.discoverBuiltInSkills()).find(
      (skill) => skill.name === "ctrlyoke-mcp-tools"
    );
    assert.ok(builtIn);

    await HarnessFileManager.exportToHarness(
      builtIn!.path,
      SPECIAL_TARGET_IDS.CTRLYOKE,
      workspaceRoot,
      HARNESS_FILE_TYPES.SKILL,
      false
    );

    const exportedPath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "skills",
      builtIn!.name,
      "SKILL.md"
    );
    const exported = await fs.readFile(exportedPath, "utf8");
    assert.match(exported, /## Available ctrlyoke MCP tools/);
    assert.match(exported, /### append_step/);
    assert.match(exported, /--working-file/);
    assert.match(exported, /<mcp-server\.js path>/);
    assert.match(exported, /<path>/);
  });

  test("deletes a plain markdown agent from the Agents target", async () => {
    const agentPath = path.join(workspaceRoot, ".agents", "reviewer.md");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(agentPath, "---\nname: reviewer\n---\n");

    await HarnessFileManager.deleteFromHarness(
      "reviewer",
      SPECIAL_TARGET_IDS.AGENTS,
      workspaceRoot,
      HARNESS_FILE_TYPES.AGENT
    );

    await assert.rejects(fs.access(agentPath));
  });

  test("deletes a Claude agent using its discovered markdown path", async () => {
    const agentPath = path.join(
      workspaceRoot,
      ".claude",
      "agents",
      "reviewer.agent.md"
    );
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(agentPath, "---\nname: reviewer\n---\n");

    await HarnessFileManager.deleteFromHarness(
      "reviewer",
      HARNESS_IDS.CLAUDE_CLI,
      workspaceRoot,
      HARNESS_FILE_TYPES.AGENT
    );

    await assert.rejects(fs.access(agentPath));
  });

  test("deletes an agent discovered in a later target directory", async () => {
    const secondDir = path.join(workspaceRoot, "alternate", "claude-agents");
    const agentPath = path.join(secondDir, "reviewer.md");
    const originalGetHarnessAgentDirs = Object.getOwnPropertyDescriptor(
      HarnessDirectoryUtils,
      "getHarnessAgentDirs"
    );
    Object.defineProperty(HarnessDirectoryUtils, "getHarnessAgentDirs", {
      configurable: true,
      value: (harnessId: string, root: string) =>
        harnessId === HARNESS_IDS.CLAUDE_CLI
          ? [path.join(root, ".claude", "agents"), secondDir]
          : originalGetHarnessAgentDirs!.value(harnessId, root),
    });

    try {
      await fs.mkdir(secondDir, { recursive: true });
      await fs.writeFile(agentPath, "---\nname: reviewer\n---\n");

      await HarnessFileManager.deleteFromHarness(
        "reviewer",
        HARNESS_IDS.CLAUDE_CLI,
        workspaceRoot,
        HARNESS_FILE_TYPES.AGENT
      );

      await assert.rejects(fs.access(agentPath));
    } finally {
      if (originalGetHarnessAgentDirs) {
        Object.defineProperty(
          HarnessDirectoryUtils,
          "getHarnessAgentDirs",
          originalGetHarnessAgentDirs
        );
      }
    }
  });

  test("delete all removes each discovered agent path directly", async () => {
    const agentDir = path.join(workspaceRoot, ".claude", "agents");
    const agentPath = path.join(agentDir, "reviewer.md");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(agentPath, "---\nname: reviewer\n---\n");

    await HarnessFileManager.deleteAllFromHarness(
      HARNESS_IDS.CLAUDE_CLI,
      workspaceRoot,
      HARNESS_FILE_TYPES.AGENT
    );

    await assert.rejects(fs.access(agentPath));
  });

  test("reports failure when deleting a nonexistent agent", async () => {
    await assert.rejects(
      HarnessFileManager.deleteFromHarness(
        "missing",
        SPECIAL_TARGET_IDS.AGENTS,
        workspaceRoot,
        HARNESS_FILE_TYPES.AGENT
      ),
      /Agent "missing" was not found/
    );
  });

  suite("installSkillFiles", () => {
    const origin = {
      registry: "skills.sh",
      source: "anthropics/skills",
      slug: "pdf",
      commitSha: "dbd4588f9e1033efb41dad4bef2f7947c8993d44",
      skillMdPath: "skills/pdf/SKILL.md",
    };
    const text = (value: string) => new TextEncoder().encode(value);
    const skillsDir = () => path.join(workspaceRoot, ".ctrlyoke", "skills");

    test("writes the files and an origin record into the ctrlyoke skills folder", async () => {
      const dest = await HarnessFileManager.installSkillFiles(
        "pdf",
        [
          { path: "SKILL.md", content: text("---\nname: pdf\n---\n") },
          { path: "scripts/fill.py", content: text("print(1)") },
        ],
        origin,
        workspaceRoot,
        SETTING_SCOPES.WORKSPACE
      );

      assert.strictEqual(dest, path.join(skillsDir(), "pdf"));
      assert.strictEqual(
        await fs.readFile(path.join(dest, "scripts", "fill.py"), "utf8"),
        "print(1)"
      );
      const record = JSON.parse(
        await fs.readFile(path.join(dest, SKILL_ORIGIN_FILE_NAME), "utf8")
      );
      assert.strictEqual(record.schemaVersion, 1);
      assert.strictEqual(record.commitSha, origin.commitSha);
      assert.ok(record.installedAt);
      // Staging lives beside the skills folder and is gone afterwards.
      assert.deepStrictEqual(
        await fs.readdir(path.join(workspaceRoot, ".ctrlyoke")),
        ["skills"]
      );
      const files = await HarnessFileManager.resolveAllLocations(
        workspaceRoot,
        HARNESS_FILE_TYPES.SKILL
      );
      assert.ok(files.some((file) => file.name === "pdf"));
    });

    test("refuses to replace an existing skill unless asked to", async () => {
      await fs.mkdir(path.join(skillsDir(), "pdf"), { recursive: true });
      await assert.rejects(
        HarnessFileManager.installSkillFiles(
          "pdf",
          [{ path: "SKILL.md", content: text("x") }],
          origin,
          workspaceRoot,
          SETTING_SCOPES.WORKSPACE
        ),
        /already exists/
      );
    });

    test("never overwrites a skill whose origin a newer ctrlyoke wrote", async () => {
      const dest = path.join(skillsDir(), "pdf");
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(
        path.join(dest, SKILL_ORIGIN_FILE_NAME),
        JSON.stringify({ schemaVersion: 99 })
      );
      await assert.rejects(
        HarnessFileManager.installSkillFiles(
          "pdf",
          [{ path: "SKILL.md", content: text("x") }],
          origin,
          workspaceRoot,
          SETTING_SCOPES.WORKSPACE,
          true
        ),
        /newer version of ctrlyoke/
      );
    });

    test("rejects unsafe paths and leaves nothing behind", async () => {
      for (const unsafe of ["../escape.md", "a/../../b.md", "nul", "a\\b.md"]) {
        await assert.rejects(
          HarnessFileManager.installSkillFiles(
            "pdf",
            [
              { path: "SKILL.md", content: text("x") },
              { path: unsafe, content: text("x") },
            ],
            origin,
            workspaceRoot,
            SETTING_SCOPES.WORKSPACE
          ),
          /unsafe skill path/,
          unsafe
        );
      }
      await assert.rejects(fs.access(path.join(skillsDir(), "pdf")));
      await assert.rejects(fs.access(path.join(workspaceRoot, "escape.md")));
      await assert.rejects(
        HarnessFileManager.installSkillFiles(
          "..",
          [{ path: "SKILL.md", content: text("x") }],
          origin,
          workspaceRoot,
          SETTING_SCOPES.WORKSPACE
        ),
        /Not a valid skill folder name/
      );
    });

    test("keeps the origin record out of harness exports", async () => {
      const dest = await HarnessFileManager.installSkillFiles(
        "pdf",
        [{ path: "SKILL.md", content: text("---\nname: pdf\n---\n") }],
        origin,
        workspaceRoot,
        SETTING_SCOPES.WORKSPACE
      );
      await HarnessFileManager.exportToHarness(
        dest,
        HARNESS_IDS.CLAUDE_CLI,
        workspaceRoot,
        HARNESS_FILE_TYPES.SKILL
      );
      const exported = path.join(workspaceRoot, ".claude", "skills", "pdf");
      assert.deepStrictEqual(await fs.readdir(exported), ["SKILL.md"]);
    });
  });
});
