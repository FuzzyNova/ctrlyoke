import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { HarnessFileManager } from "../../utils/HarnessFileManager";
import { SkillDiscovery } from "../../utils/SkillDiscovery";
import {
  HARNESS_FILE_TYPES,
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
    assert.match(exported, /### ctrlyoke_append_queue/);
    assert.match(exported, /--working-file/);
  });
});
