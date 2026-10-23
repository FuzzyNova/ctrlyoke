import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { HarnessFileMessageService } from "../../ui/HarnessFileMessageService";
import { HarnessFileManager } from "../../utils/HarnessFileManager";
import { createWebviewClientContext } from "../../ui/WebviewClientContext";
import {
  HARNESS_FILE_TYPES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  SETTING_SCOPES,
} from "../../types/DashboardConstants";
import type {
  RegistrySkillAudit,
  RegistrySkillEntry,
  RegistrySkillLocation,
} from "../../types/WebviewMessageTypes";
import type {
  DownloadedSkillFile,
  SkillsRegistry,
} from "../../utils/SkillsRegistryClient";

/**
 * Every mutating harness-file op shares one success payload shape. This pins
 * that uniformity: `DELETE_ALL_FROM_HARNESS` used to omit `targetDirectories`
 * while the other four included it, and the webview store treats an absent
 * field as "keep whatever you already had" rather than "there are none".
 */
suite("HarnessFileMessageService", () => {
  let workspaceRoot: string;
  let posted: any[];
  let service: HarnessFileMessageService;

  const ctx = () =>
    createWebviewClientContext("test-client", (message) => {
      posted.push(message);
    });

  const lastResult = () => posted[posted.length - 1];

  const skillType = HARNESS_FILE_TYPES.SKILL;
  const scope = SETTING_SCOPES.WORKSPACE;
  const harnessId = HARNESS_IDS.CLAUDE_CLI;

  function sourceSkillPath(): string {
    return path.join(workspaceRoot, "source", "demo-skill");
  }

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-harnessfiles-")
    );
    posted = [];
    service = new HarnessFileMessageService(() => workspaceRoot, {
      revealInOs: async () => ({ status: "opened" }),
    });
    await fs.mkdir(sourceSkillPath(), { recursive: true });
    await fs.writeFile(
      path.join(sourceSkillPath(), "SKILL.md"),
      "# demo skill\n",
      "utf8"
    );
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("every file op reports the same success payload shape", async () => {
    const ops: Array<[string, () => Promise<void>]> = [
      [
        "import",
        () =>
          service.handleImportToCtrlYoke(ctx(), {
            type: MESSAGE_TYPES.IMPORT_TO_CTRLYOKE,
            sourcePath: sourceSkillPath(),
            fileType: skillType,
            overwrite: true,
          }),
      ],
      [
        "export",
        () =>
          service.handleExportToHarness(ctx(), {
            type: MESSAGE_TYPES.EXPORT_TO_HARNESS,
            sourcePath: sourceSkillPath(),
            harnessId,
            fileType: skillType,
            overwrite: true,
            scope,
          }),
      ],
      [
        "syncAll",
        () =>
          service.handleSyncAllToHarness(ctx(), {
            type: MESSAGE_TYPES.SYNC_ALL_TO_HARNESS,
            files: [{ sourcePath: sourceSkillPath(), name: "demo-skill" }],
            targetHarnessId: harnessId,
            fileType: skillType,
            scope,
          }),
      ],
      [
        "delete",
        () =>
          service.handleDeleteFromHarness(ctx(), {
            type: MESSAGE_TYPES.DELETE_FROM_HARNESS,
            name: "demo-skill",
            harnessId,
            fileType: skillType,
            scope,
          }),
      ],
      [
        "deleteAll",
        () =>
          service.handleDeleteAllFromHarness(ctx(), {
            type: MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS,
            harnessId,
            fileType: skillType,
            scope,
          }),
      ],
    ];

    for (const [label, run] of ops) {
      posted = [];
      await run();

      const result = lastResult();
      assert.ok(result, `${label} emitted no result`);
      assert.strictEqual(result.type, MESSAGE_TYPES.HARNESS_FILE_OP_RESULT);
      assert.strictEqual(result.success, true, `${label} did not succeed`);
      assert.deepStrictEqual(
        Object.keys(result).sort(),
        ["files", "success", "targetDirectories", "type"],
        `${label} success payload shape drifted`
      );
      assert.ok(
        Array.isArray(result.files),
        `${label} did not return a file list`
      );
      assert.ok(
        result.targetDirectories.length > 0,
        `${label} did not return target directories`
      );
    }
  });

  test("delete-all leaves the harness directory empty and still reports targets", async () => {
    await service.handleExportToHarness(ctx(), {
      type: MESSAGE_TYPES.EXPORT_TO_HARNESS,
      sourcePath: sourceSkillPath(),
      harnessId,
      fileType: skillType,
      overwrite: true,
      scope,
    });
    const exported = lastResult();
    assert.strictEqual(exported.success, true);

    posted = [];
    await service.handleDeleteAllFromHarness(ctx(), {
      type: MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS,
      harnessId,
      fileType: skillType,
      scope,
    });

    const result = lastResult();
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      result.targetDirectories,
      exported.targetDirectories,
      "target directories are a pure function of workspaceRoot + fileType"
    );
    assert.strictEqual(
      result.files.some((file: { name: string }) => file.name === "demo-skill"),
      false,
      "the deleted skill should no longer be reported"
    );
  });

  test("a failed op reports the error without a file list", async () => {
    await service.handleExportToHarness(ctx(), {
      type: MESSAGE_TYPES.EXPORT_TO_HARNESS,
      sourcePath: sourceSkillPath(),
      harnessId,
      fileType: skillType,
      overwrite: true,
      scope,
    });

    posted = [];
    await service.handleExportToHarness(ctx(), {
      type: MESSAGE_TYPES.EXPORT_TO_HARNESS,
      sourcePath: sourceSkillPath(),
      harnessId,
      fileType: skillType,
      overwrite: false,
      scope,
    });

    const result = lastResult();
    assert.strictEqual(result.type, MESSAGE_TYPES.HARNESS_FILE_OP_RESULT);
    assert.strictEqual(result.success, false);
    assert.ok(
      /already exists/i.test(result.error),
      `unexpected error: ${result.error}`
    );
    assert.deepStrictEqual(Object.keys(result).sort(), [
      "error",
      "success",
      "type",
    ]);
  });

  test("a successful op refreshes the dashboard's agent and skill lists; a failed one does not", async () => {
    let refreshes = 0;
    service = new HarnessFileMessageService(
      () => workspaceRoot,
      { revealInOs: async () => ({ status: "opened" }) },
      async () => {
        refreshes++;
      }
    );
    const exportSkill = (overwrite: boolean) =>
      service.handleExportToHarness(ctx(), {
        type: MESSAGE_TYPES.EXPORT_TO_HARNESS,
        sourcePath: sourceSkillPath(),
        harnessId,
        fileType: skillType,
        overwrite,
        scope,
      });

    await exportSkill(true);
    assert.strictEqual(lastResult().success, true);
    assert.strictEqual(refreshes, 1);

    await exportSkill(false);
    assert.strictEqual(lastResult().success, false);
    assert.strictEqual(refreshes, 1);
  });

  test("unsupported OS reveal returns the directory for the browser viewer", async () => {
    const targetDirectory = HarnessFileManager.getTargetDir(
      harnessId,
      workspaceRoot,
      skillType,
      scope
    );
    await fs.mkdir(targetDirectory, { recursive: true });
    service = new HarnessFileMessageService(() => workspaceRoot, {
      revealInOs: async () => ({ status: "unsupported" }),
    });

    await service.handleOpenHarnessDir(ctx(), {
      type: MESSAGE_TYPES.OPEN_HARNESS_DIR,
      harnessId,
      fileType: skillType,
      scope,
    });

    assert.deepStrictEqual(lastResult(), {
      type: MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT,
      success: true,
      path: path.relative(workspaceRoot, targetDirectory).replace(/\\/g, "/"),
    });
  });

  suite("skills registry", () => {
    const location: RegistrySkillLocation = {
      source: "anthropics/skills",
      slug: "pdf",
      commitSha: "dbd4588f9e1033efb41dad4bef2f7947c8993d44",
      folderPath: "skills/pdf",
      skillMdPath: "skills/pdf/SKILL.md",
      name: "pdf",
    };

    class FakeSkillsRegistry implements SkillsRegistry {
      failWith: string | undefined;
      async searchSkills(): Promise<RegistrySkillEntry[]> {
        if (this.failWith) throw new Error(this.failWith);
        return [
          {
            id: "anthropics/skills/pdf",
            source: "anthropics/skills",
            slug: "pdf",
            name: "pdf",
            installs: 3,
          },
        ];
      }
      async getSkillAudits(
        _source: string,
        slug: string
      ): Promise<RegistrySkillAudit[] | null> {
        if (slug === "broken") throw new Error("skills.sh audit failed");
        return slug === "unaudited" ? null : [];
      }
      async resolveSkill(): Promise<RegistrySkillLocation> {
        if (this.failWith) throw new Error(this.failWith);
        return location;
      }
      async downloadSkill(): Promise<DownloadedSkillFile[]> {
        if (this.failWith) throw new Error(this.failWith);
        return [
          {
            path: "SKILL.md",
            content: new TextEncoder().encode("---\nname: pdf\n---\n"),
          },
        ];
      }
    }

    let registry: FakeSkillsRegistry;
    let refreshes: number;

    setup(() => {
      registry = new FakeSkillsRegistry();
      refreshes = 0;
      service = new HarnessFileMessageService(
        () => workspaceRoot,
        { revealInOs: async () => ({ status: "opened" }) },
        async () => {
          refreshes += 1;
        },
        registry
      );
    });

    test("search answers with the request id, and errors become a payload", async () => {
      await service.handleSkillsRegistrySearch(ctx(), {
        type: MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH,
        requestId: 7,
        query: "pdf",
      });
      assert.strictEqual(lastResult().requestId, 7);
      assert.strictEqual(lastResult().skills.length, 1);

      registry.failWith = "skills.sh search is unavailable (HTTP 503)";
      await service.handleSkillsRegistrySearch(ctx(), {
        type: MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH,
        requestId: 8,
        query: "pdf",
      });
      assert.deepStrictEqual(lastResult(), {
        type: MESSAGE_TYPES.SKILLS_REGISTRY_SEARCH_RESULT,
        requestId: 8,
        skills: [],
        error: "skills.sh search is unavailable (HTTP 503)",
      });
    });

    test("audits report one result per skill, failures included", async () => {
      await service.handleSkillsRegistryAudits(ctx(), {
        type: MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_AUDITS,
        skills: [
          { source: "a/b", slug: "ok" },
          { source: "a/b", slug: "unaudited" },
          { source: "a/b", slug: "broken" },
        ],
      });
      assert.deepStrictEqual(lastResult(), {
        type: MESSAGE_TYPES.SKILLS_REGISTRY_AUDITS_RESULT,
        results: [
          { source: "a/b", slug: "ok", audits: [] },
          { source: "a/b", slug: "unaudited", audits: null },
          {
            source: "a/b",
            slug: "broken",
            audits: null,
            error: "skills.sh audit failed",
          },
        ],
      });
    });

    test("install writes the skill into the scope and refreshes pickers", async () => {
      await service.handleInstallRegistrySkill(ctx(), {
        type: MESSAGE_TYPES.INSTALL_REGISTRY_SKILL,
        location,
        scope,
      });
      assert.deepStrictEqual(lastResult(), {
        type: MESSAGE_TYPES.REGISTRY_SKILL_INSTALL_RESULT,
        source: location.source,
        slug: location.slug,
        success: true,
      });
      assert.strictEqual(refreshes, 1);
      await fs.access(
        path.join(workspaceRoot, ".ctrlyoke", "skills", "pdf", "SKILL.md")
      );
    });

    test("a failed install reports the error and refreshes nothing", async () => {
      registry.failWith =
        "GitHub download of SKILL.md is unavailable (HTTP 404)";
      await service.handleInstallRegistrySkill(ctx(), {
        type: MESSAGE_TYPES.INSTALL_REGISTRY_SKILL,
        location,
        scope,
      });
      assert.strictEqual(lastResult().success, false);
      assert.match(lastResult().error, /GitHub download/);
      assert.strictEqual(refreshes, 0);
    });
  });
});
