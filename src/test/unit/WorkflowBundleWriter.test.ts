import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import * as AtomicFileUtils from "../../utils/AtomicFileUtils";
import {
  BUNDLE_MANIFEST_FILE_NAME,
  BUNDLE_MANIFEST_VERSION,
  type BundlePlan,
} from "../../utils/WorkflowBundleAnalyzer";
import { writeWorkflowBundle } from "../../utils/WorkflowBundleWriter";

async function makeWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function plan(
  assetsDirectory: string,
  sourcePath: string,
  destinationPath: string,
  extra: Partial<BundlePlan> = {}
): BundlePlan {
  return {
    copies: [
      {
        sourcePath,
        destinationPath,
        relativePath: path.relative(
          path.dirname(assetsDirectory),
          destinationPath
        ),
        contentHash: "",
        references: ["@source.txt"],
      },
    ],
    inlines: [],
    warnings: [],
    blockers: [],
    pruneCandidates: [],
    assetsDirectory,
    ...extra,
  };
}

async function cleanup(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

suite("WorkflowBundleWriter", () => {
  test("preserves pre-existing files and removes only prior-manifest orphans", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-writer-prune-");
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      const source = path.join(workspace, "source.txt");
      const current = path.join(assets, "current.txt");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(source, "new", "utf8");
      await fs.writeFile(path.join(assets, "stale.txt"), "stale", "utf8");
      await fs.writeFile(path.join(assets, "hand-added.txt"), "hand", "utf8");
      await fs.writeFile(path.join(assets, "keep.txt"), "keep", "utf8");
      await fs.writeFile(
        path.join(assets, BUNDLE_MANIFEST_FILE_NAME),
        JSON.stringify({
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["stale.txt", "keep.txt"],
        }),
        "utf8"
      );

      await writeWorkflowBundle({
        workflowPath: path.join(workspace, "fix-tests.ctrlyoke.yaml"),
        serializedWorkflow: "prompt: '@fix-tests.assets/keep.txt'\n",
        plan: plan(assets, source, current, {
          pruneCandidates: ["stale.txt", "keep.txt"],
        }),
      });

      await assert.rejects(() => fs.access(path.join(assets, "stale.txt")));
      assert.strictEqual(
        await fs.readFile(path.join(assets, "hand-added.txt"), "utf8"),
        "hand"
      );
      assert.strictEqual(
        await fs.readFile(path.join(assets, "keep.txt"), "utf8"),
        "keep"
      );
      assert.strictEqual(await fs.readFile(current, "utf8"), "new");
    } finally {
      await cleanup(workspace);
    }
  });

  test("does not prune a pre-existing file when no manifest exists", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-writer-first-save-");
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      const source = path.join(workspace, "source.txt");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(assets, "user-owned.txt"), "user", "utf8");
      await fs.writeFile(source, "asset", "utf8");

      await writeWorkflowBundle({
        workflowPath: path.join(workspace, "fix-tests.ctrlyoke.yaml"),
        serializedWorkflow: "prompt: new\n",
        plan: plan(assets, source, path.join(assets, "source.txt")),
      });

      assert.strictEqual(
        await fs.readFile(path.join(assets, "user-owned.txt"), "utf8"),
        "user"
      );
    } finally {
      await cleanup(workspace);
    }
  });

  test("never prunes a destination published by the same save", async function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const workspace = await makeWorkspace("ctrlyoke-bundle-writer-case-prune-");
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      const source = path.join(workspace, "source.txt");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(source, "published", "utf8");
      await fs.writeFile(path.join(assets, "Notes.txt"), "old", "utf8");

      await writeWorkflowBundle({
        workflowPath: path.join(workspace, "fix-tests.ctrlyoke.yaml"),
        serializedWorkflow: "prompt: no references\n",
        plan: plan(assets, source, path.join(assets, "notes.txt"), {
          pruneCandidates: ["Notes.txt"],
        }),
      });

      assert.strictEqual(
        await fs.readFile(path.join(assets, "Notes.txt"), "utf8"),
        "published"
      );
    } finally {
      await cleanup(workspace);
    }
  });

  test("removes an emptied managed assets directory", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-writer-empty-");
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(assets, "old.txt"), "old", "utf8");
      await fs.writeFile(
        path.join(assets, BUNDLE_MANIFEST_FILE_NAME),
        JSON.stringify({
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["old.txt"],
        }),
        "utf8"
      );

      await writeWorkflowBundle({
        workflowPath: path.join(workspace, "fix-tests.ctrlyoke.yaml"),
        serializedWorkflow: "prompt: new\n",
        plan: {
          copies: [],
          inlines: [],
          warnings: [],
          blockers: [],
          pruneCandidates: ["old.txt"],
          assetsDirectory: assets,
          managedAssetsDirectory: true,
        },
      });

      await assert.rejects(() => fs.access(assets));
    } finally {
      await cleanup(workspace);
    }
  });

  test("keeps an assets directory this save never managed", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-writer-unmanaged-");
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await writeWorkflowBundle({
        workflowPath: path.join(workspace, "fix-tests.ctrlyoke.yaml"),
        serializedWorkflow: "prompt: no references\n",
        plan: {
          copies: [],
          inlines: [],
          warnings: [],
          blockers: [],
          pruneCandidates: [],
          assetsDirectory: assets,
        },
      });

      assert.strictEqual((await fs.stat(assets)).isDirectory(), true);
    } finally {
      await cleanup(workspace);
    }
  });

  test("fails safe for a corrupt manifest without deleting user files", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-writer-corrupt-");
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      const manifest = path.join(assets, BUNDLE_MANIFEST_FILE_NAME);
      const userFile = path.join(assets, "user.txt");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(manifest, "not json", "utf8");
      await fs.writeFile(userFile, "user", "utf8");

      const result = await writeWorkflowBundle({
        workflowPath: path.join(workspace, "fix-tests.ctrlyoke.yaml"),
        serializedWorkflow: "prompt: hello\n",
        plan: {
          copies: [],
          inlines: [],
          warnings: [
            {
              code: "invalid-assets-manifest",
              message: "Ignoring invalid assets manifest.",
            },
          ],
          blockers: [],
          pruneCandidates: [],
          assetsDirectory: assets,
        },
      });

      assert.ok(result.warnings.length > 0);
      assert.strictEqual(await fs.readFile(manifest, "utf8"), "not json");
      assert.strictEqual(await fs.readFile(userFile, "utf8"), "user");
    } finally {
      await cleanup(workspace);
    }
  });

  test("leaves the old workflow untouched when staging a copy fails", async () => {
    const workspace = await makeWorkspace(
      "ctrlyoke-bundle-writer-copy-failure-"
    );
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      const workflow = path.join(workspace, "fix-tests.ctrlyoke.yaml");
      await fs.writeFile(workflow, "prompt: old\n", "utf8");

      await assert.rejects(
        () =>
          writeWorkflowBundle({
            workflowPath: workflow,
            serializedWorkflow: "prompt: new\n",
            plan: plan(
              assets,
              path.join(workspace, "missing.txt"),
              path.join(assets, "missing.txt")
            ),
          }),
        /ENOENT|missing/i
      );

      assert.strictEqual(await fs.readFile(workflow, "utf8"), "prompt: old\n");
      const entries = await fs.readdir(assets);
      assert.deepStrictEqual(entries, []);
    } finally {
      await cleanup(workspace);
    }
  });

  test("warns when manifest replacement fails and keeps the saved workflow", async () => {
    const workspace = await makeWorkspace(
      "ctrlyoke-bundle-writer-manifest-failure-"
    );
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      const source = path.join(workspace, "source.txt");
      const oldAsset = path.join(assets, "old.png");
      const newAsset = path.join(assets, "source.txt");
      const manifestPath = path.join(assets, BUNDLE_MANIFEST_FILE_NAME);
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(source, "asset", "utf8");
      await fs.writeFile(oldAsset, "old asset", "utf8");
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["old.png"],
        }),
        "utf8"
      );

      const atomicFileUtils = require("../../utils/AtomicFileUtils") as {
        writeFileAtomic: typeof AtomicFileUtils.writeFileAtomic;
      };
      const originalWriteFileAtomic = atomicFileUtils.writeFileAtomic;
      atomicFileUtils.writeFileAtomic = async (filePath, contents, options) => {
        if (filePath === manifestPath) {
          throw new Error("simulated manifest write failure");
        }
        await originalWriteFileAtomic(filePath, contents, options);
      };

      let result: Awaited<ReturnType<typeof writeWorkflowBundle>>;
      try {
        result = await writeWorkflowBundle({
          workflowPath: path.join(workspace, "fix-tests.ctrlyoke.yaml"),
          serializedWorkflow: "prompt: new\n",
          plan: plan(assets, source, newAsset, {
            pruneCandidates: ["old.png"],
          }),
        });
      } finally {
        atomicFileUtils.writeFileAtomic = originalWriteFileAtomic;
      }

      assert.ok(result.warnings.some((warning) => /manifest/i.test(warning)));
      assert.strictEqual(await fs.readFile(oldAsset, "utf8"), "old asset");
      assert.strictEqual(await fs.readFile(newAsset, "utf8"), "asset");
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(manifestPath, "utf8")),
        {
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["old.png"],
        }
      );
      assert.strictEqual(
        await fs.readFile(
          path.join(workspace, "fix-tests.ctrlyoke.yaml"),
          "utf8"
        ),
        "prompt: new\n"
      );
    } finally {
      await cleanup(workspace);
    }
  });

  test("saves idempotently when an asset source is its destination", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-writer-idempotent-");
    try {
      const assets = path.join(workspace, "fix-tests.assets");
      const source = path.join(workspace, "source.png");
      const workflow = path.join(workspace, "fix-tests.ctrlyoke.yaml");
      const asset = path.join(assets, "source.png");
      const serializedWorkflow = 'prompt: @"./fix-tests.assets/source.png"\n';
      await fs.writeFile(source, "image", "utf8");

      await writeWorkflowBundle({
        workflowPath: workflow,
        serializedWorkflow,
        plan: plan(assets, source, asset),
      });
      const first = await fs.readFile(workflow, "utf8");

      const samePathPlan = plan(assets, asset, asset);
      samePathPlan.pruneCandidates = [];
      await writeWorkflowBundle({
        workflowPath: workflow,
        serializedWorkflow,
        plan: samePathPlan,
      });
      const second = await fs.readFile(workflow, "utf8");
      assert.strictEqual(second, first);
      assert.strictEqual(await fs.readFile(asset, "utf8"), "image");

      await writeWorkflowBundle({
        workflowPath: workflow,
        serializedWorkflow,
        plan: plan(assets, asset, asset),
      });
      assert.deepStrictEqual(await fs.readFile(workflow), Buffer.from(first));
      assert.deepStrictEqual(
        JSON.parse(
          await fs.readFile(
            path.join(assets, BUNDLE_MANIFEST_FILE_NAME),
            "utf8"
          )
        ),
        {
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["source.png"],
        }
      );
    } finally {
      await cleanup(workspace);
    }
  });
});
