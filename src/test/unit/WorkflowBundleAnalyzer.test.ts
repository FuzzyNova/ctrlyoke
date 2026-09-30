import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  analyzeWorkflowBundle,
  BUNDLE_MANIFEST_FILE_NAME,
  BUNDLE_MANIFEST_VERSION,
} from "../../utils/WorkflowBundleAnalyzer";
import { writeWorkflowBundle } from "../../utils/WorkflowBundleWriter";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(workspace, ".ctrlyoke", "attachments"), {
    recursive: true,
  });
  await fs.mkdir(path.join(workspace, ".ctrlyoke", "prompts"), {
    recursive: true,
  });
  await fs.mkdir(path.join(workspace, ".ctrlyoke", "temp"), {
    recursive: true,
  });
  return workspace;
}

function destination(workspace: string): string {
  return path.join(workspace, "workflows", "fix-tests.ctrlyoke.yaml");
}

async function analyze(
  workspace: string,
  workflow: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return analyzeWorkflowBundle(workflow, {
    workspaceRoot: workspace,
    destinationPath: destination(workspace),
    ...extra,
  });
}

suite("WorkflowBundleAnalyzer", () => {
  test("inlines generated prompt files, including empty drafts, without mutating input", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-prompt-");
    try {
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "prompts", "empty.prompt.md"),
        "",
        "utf8"
      );
      const input = {
        steps: [{ prompt: "./.ctrlyoke/prompts/empty.prompt.md" }],
        finalStep: { prompt: "./.ctrlyoke/prompts/empty.prompt.md" },
      };
      const result = await analyze(workspace, input, {
        sourceDefinitionPath: path.join(workspace, "authored", "source.yaml"),
      });

      assert.strictEqual((result.workflow.steps as any[])[0].prompt, "");
      assert.strictEqual((result.workflow.finalStep as any).prompt, "");
      assert.strictEqual(
        input.steps[0].prompt,
        "./.ctrlyoke/prompts/empty.prompt.md"
      );
      assert.strictEqual(result.plan.inlines.length, 2);
      assert.strictEqual(result.plan.copies.length, 0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("copies and rewrites @, selection, and typed symbol references", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-rewrite-");
    try {
      const filePath = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "shot one.txt"
      );
      await fs.writeFile(filePath, "attachment", "utf8");
      const result = await analyze(workspace, {
        steps: [
          {
            prompt:
              '@".ctrlyoke/attachments/shot one.txt" #selection:".ctrlyoke/attachments/shot one.txt":2-4 #sym.class:".ctrlyoke/attachments/shot one.txt":"My Symbol":2-4',
          },
        ],
      });

      const rewritten = (result.workflow.steps as any[])[0].prompt as string;
      assert.match(rewritten, /@"\.\/fix-tests\.assets\/shot one\.txt"/);
      assert.match(
        rewritten,
        /#selection:"\.\/fix-tests\.assets\/shot one\.txt":2-4/
      );
      assert.match(
        rewritten,
        /#sym\.class:"\.\/fix-tests\.assets\/shot one\.txt":"My Symbol":2-4/
      );
      assert.strictEqual(result.plan.copies.length, 1);
      assert.strictEqual(
        result.plan.copies[0].relativePath,
        "./fix-tests.assets/shot one.txt"
      );
      assert.strictEqual(result.plan.blockers.length, 0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("preserves a differently-cased user asset when choosing a name", async function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const workspace = await makeWorkspace("ctrlyoke-bundle-case-user-");
    try {
      const source = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "notes.txt"
      );
      const assets = path.join(workspace, "workflows", "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(source, "generated", "utf8");
      await fs.writeFile(path.join(assets, "Notes.txt"), "user owned", "utf8");

      const result = await analyze(workspace, {
        prompt: "Use @.ctrlyoke/attachments/notes.txt",
      });

      assert.notStrictEqual(
        path.basename(result.plan.copies[0].destinationPath),
        "notes.txt"
      );
      await writeWorkflowBundle({
        workflowPath: destination(workspace),
        serializedWorkflow: JSON.stringify(result.workflow),
        plan: result.plan,
      });
      assert.strictEqual(
        await fs.readFile(path.join(assets, "Notes.txt"), "utf8"),
        "user owned"
      );
      assert.strictEqual(
        await fs.readFile(result.plan.copies[0].destinationPath, "utf8"),
        "generated"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not prune a manifested asset when a save republishes its case variant", async function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const workspace = await makeWorkspace("ctrlyoke-bundle-case-managed-");
    try {
      const source = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "notes.txt"
      );
      const assets = path.join(workspace, "workflows", "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(source, "new generated", "utf8");
      await fs.writeFile(path.join(assets, "Notes.txt"), "old", "utf8");
      await fs.writeFile(
        path.join(assets, BUNDLE_MANIFEST_FILE_NAME),
        JSON.stringify({
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["Notes.txt"],
        }),
        "utf8"
      );

      const result = await analyze(workspace, {
        prompt: "Use @.ctrlyoke/attachments/notes.txt",
      });
      assert.deepStrictEqual(result.plan.pruneCandidates, []);
      await writeWorkflowBundle({
        workflowPath: destination(workspace),
        serializedWorkflow: JSON.stringify(result.workflow),
        plan: result.plan,
      });
      assert.strictEqual(
        await fs.readFile(path.join(assets, "Notes.txt"), "utf8"),
        "new generated"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("assigns distinct names to source files that differ only by case", async function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const workspace = await makeWorkspace("ctrlyoke-bundle-case-sources-");
    try {
      const upper = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "Notes.md"
      );
      const lower = path.join(workspace, ".ctrlyoke", "prompts", "notes.md");
      await fs.writeFile(upper, "AAA", "utf8");
      await fs.writeFile(lower, "BBB", "utf8");
      const result = await analyze(workspace, {
        prompt:
          "one @.ctrlyoke/attachments/Notes.md two @.ctrlyoke/prompts/notes.md",
      });

      assert.strictEqual(result.plan.copies.length, 2);
      assert.notStrictEqual(
        result.plan.copies[0].relativePath.toLowerCase(),
        result.plan.copies[1].relativePath.toLowerCase()
      );
      await writeWorkflowBundle({
        workflowPath: destination(workspace),
        serializedWorkflow: JSON.stringify(result.workflow),
        plan: result.plan,
      });
      const contents = await Promise.all(
        result.plan.copies.map((copy) =>
          fs.readFile(copy.destinationPath, "utf8")
        )
      );
      assert.deepStrictEqual(new Set(contents), new Set(["AAA", "BBB"]));
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("bundles a bare generated-store ref shadowed by a same-named file beside the workflow", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-shadow-");
    try {
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "attachments", "shot.txt"),
        "real attachment",
        "utf8"
      );
      // A file at <workflowDir>/<the exact ref path>. A bare reference is
      // workspace-relative, so this must not shadow the real target.
      const decoyDir = path.join(
        workspace,
        "authored",
        ".ctrlyoke",
        "attachments"
      );
      await fs.mkdir(decoyDir, { recursive: true });
      await fs.writeFile(path.join(decoyDir, "shot.txt"), "decoy", "utf8");

      const result = await analyze(
        workspace,
        { steps: [{ prompt: "@.ctrlyoke/attachments/shot.txt" }] },
        {
          sourceDefinitionPath: path.join(workspace, "authored", "source.yaml"),
        }
      );

      assert.strictEqual(result.plan.copies.length, 1);
      assert.strictEqual(
        await fs.readFile(result.plan.copies[0].sourcePath, "utf8"),
        "real attachment"
      );
      assert.strictEqual(
        (result.workflow.steps as any[])[0].prompt,
        "@./fix-tests.assets/shot.txt"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("resolves generated-store fallback paths and never inlines inline prompt refs", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-fallback-");
    try {
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "prompts", "shared.md"),
        "prompt body",
        "utf8"
      );
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "attachments", "shared.txt"),
        "attachment body",
        "utf8"
      );
      const result = await analyze(workspace, {
        steps: [
          { prompt: "Use @prompts/shared.md and @attachments/shared.txt" },
        ],
      });

      assert.strictEqual(result.plan.inlines.length, 0);
      assert.strictEqual(result.plan.copies.length, 2);
      assert.match(
        (result.workflow.steps as any[])[0].prompt,
        /@\.\/fix-tests\.assets\/shared\.md/
      );
      assert.match(
        (result.workflow.steps as any[])[0].prompt,
        /@\.\/fix-tests\.assets\/shared\.txt/
      );
      assert.strictEqual(
        (result.workflow.steps as any[])[0].prompt.includes("prompt body"),
        false
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("blocks generated-store failures and leaves scripts alone", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-blockers-");
    try {
      await fs.mkdir(path.join(workspace, ".ctrlyoke", "attachments", "dir"));
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "temp", "temp.txt"),
        "temp",
        "utf8"
      );
      const result = await analyze(workspace, {
        steps: [
          { prompt: "@.ctrlyoke/attachments/dir/" },
          { prompt: "@.ctrlyoke/prompts/missing.prompt.md" },
          { prompt: "@.ctrlyoke/temp/temp.txt" },
          { prompt: "@.ctrlyoke/attachments/{{var}}.png" },
          { type: "script", script: "cat @.ctrlyoke/temp/temp.txt" },
        ],
      });

      assert.ok(result.plan.blockers.length >= 4);
      assert.ok(
        result.plan.blockers.some(
          (item) => item.code === "generated-directory-reference"
        )
      );
      assert.ok(
        result.plan.blockers.some(
          (item) => item.code === "missing-generated-reference"
        )
      );
      assert.ok(
        result.plan.blockers.some((item) => item.code === "temporary-reference")
      );
      assert.ok(
        result.plan.blockers.some(
          (item) => item.code === "dynamic-generated-reference"
        )
      );
      assert.strictEqual(
        (result.workflow.steps as any[])[4].script,
        "cat @.ctrlyoke/temp/temp.txt"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("ignores fenced refs and leaves ordinary repo refs untouched", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-fenced-");
    try {
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "attachments", "image.png"),
        "image",
        "utf8"
      );
      const ordinary = path.join(workspace, "src", "file.ts");
      await fs.mkdir(path.dirname(ordinary), { recursive: true });
      await fs.writeFile(ordinary, "source", "utf8");
      const prompt =
        "\`\`\`text\n@.ctrlyoke/attachments/image.png\n\`\`\`\nUse @src/file.ts";
      const result = await analyze(workspace, { prompt });

      assert.strictEqual(result.workflow.prompt, prompt);
      assert.strictEqual(result.plan.copies.length, 0);
      assert.strictEqual(result.plan.blockers.length, 0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("warns for a lone external prompt but blocks an external inline ref", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-external-");
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-bundle-outside-")
    );
    try {
      const externalPrompt = path.join(outside, "external.prompt.md");
      const externalFile = path.join(outside, "external.txt");
      await fs.writeFile(externalPrompt, "external prompt", "utf8");
      await fs.writeFile(externalFile, "external file", "utf8");
      const lone = await analyze(workspace, { prompt: externalPrompt });
      assert.strictEqual(lone.plan.blockers.length, 0);
      assert.ok(
        lone.plan.warnings.some(
          (item) => item.code === "external-prompt-reference"
        )
      );

      const inline = await analyze(workspace, {
        prompt: 'Read @"' + externalFile + '"',
      });
      assert.ok(
        inline.plan.blockers.some(
          (item) => item.code === "external-inline-reference"
        )
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("dedupes equal content and gives unequal basename collisions stable hashes", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-names-");
    try {
      const first = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "a",
        "same.txt"
      );
      const second = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "b",
        "same.txt"
      );
      const equal = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "equal.txt"
      );
      await fs.mkdir(path.dirname(first), { recursive: true });
      await fs.mkdir(path.dirname(second), { recursive: true });
      await fs.writeFile(first, "one", "utf8");
      await fs.writeFile(second, "two", "utf8");
      await fs.writeFile(equal, "one", "utf8");
      const prompt =
        "@.ctrlyoke/attachments/a/same.txt @.ctrlyoke/attachments/b/same.txt @.ctrlyoke/attachments/equal.txt";
      const result = await analyze(workspace, { prompt });

      assert.strictEqual(result.plan.copies.length, 2);
      const hash = crypto
        .createHash("sha256")
        .update("two")
        .digest("hex")
        .slice(0, 8);
      assert.ok(
        result.plan.copies.some(
          (copy) =>
            copy.relativePath.endsWith("same-" + hash + ".txt") &&
            copy.relativePath.startsWith("./fix-tests.assets/")
        )
      );
      assert.strictEqual(
        (result.workflow.prompt as string).match(
          /\.\/fix-tests\.assets\/same\.txt/g
        )?.length,
        2
      );
      const repeat = await analyze(workspace, { prompt });
      assert.deepStrictEqual(
        repeat.plan.copies.map((copy) => copy.relativePath),
        result.plan.copies.map((copy) => copy.relativePath)
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not adopt an unmanifested pre-existing asset", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-owned-");
    try {
      const assets = path.join(workspace, "workflows", "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(assets, "owned.txt"), "same", "utf8");
      const source = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "owned.txt"
      );
      await fs.writeFile(source, "same", "utf8");
      const result = await analyze(workspace, {
        prompt: "@.ctrlyoke/attachments/owned.txt",
      });

      assert.notStrictEqual(
        result.plan.copies[0].relativePath,
        "./fix-tests.assets/owned.txt"
      );
      assert.match(
        result.plan.copies[0].relativePath,
        /\.\/fix-tests\.assets\/owned-[0-9a-f]{8}\.txt$/
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("re-bundles manifested assets when Save As moves the workflow", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-rebundle-");
    try {
      const sourceDefinitionPath = path.join(
        workspace,
        "workflows",
        "fix-tests.ctrlyoke.yaml"
      );
      const sourceAssets = path.join(
        workspace,
        "workflows",
        "fix-tests.assets"
      );
      const destinationPath = path.join(
        workspace,
        "tools",
        "fix-tests.ctrlyoke.yaml"
      );
      const destinationAssets = path.join(
        workspace,
        "tools",
        "fix-tests.assets"
      );
      const sourceAsset = path.join(sourceAssets, "shot.png");
      await fs.mkdir(sourceAssets, { recursive: true });
      await fs.writeFile(sourceAsset, "previous export", "utf8");
      await fs.writeFile(
        path.join(sourceAssets, BUNDLE_MANIFEST_FILE_NAME),
        JSON.stringify({
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["shot.png"],
        }),
        "utf8"
      );
      await fs.mkdir(destinationAssets, { recursive: true });
      await fs.writeFile(
        path.join(destinationAssets, "stale.png"),
        "stale",
        "utf8"
      );
      await fs.writeFile(
        path.join(destinationAssets, BUNDLE_MANIFEST_FILE_NAME),
        JSON.stringify({
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["stale.png"],
        }),
        "utf8"
      );

      const result = await analyzeWorkflowBundle(
        { prompt: "Review @./fix-tests.assets/shot.png" },
        {
          workspaceRoot: workspace,
          sourceDefinitionPath,
          destinationPath,
        }
      );

      assert.strictEqual(result.plan.copies.length, 1);
      assert.strictEqual(result.plan.copies[0].sourcePath, sourceAsset);
      assert.strictEqual(
        result.plan.copies[0].relativePath,
        "./fix-tests.assets/shot.png"
      );
      assert.strictEqual(
        result.workflow.prompt,
        "Review @./fix-tests.assets/shot.png"
      );
      assert.deepStrictEqual(result.plan.pruneCandidates, ["stale.png"]);

      await writeWorkflowBundle({
        workflowPath: destinationPath,
        serializedWorkflow: JSON.stringify(result.workflow),
        plan: result.plan,
      });
      assert.strictEqual(
        await fs.readFile(path.join(destinationAssets, "shot.png"), "utf8"),
        "previous export"
      );
      await assert.rejects(() =>
        fs.access(path.join(destinationAssets, "stale.png"))
      );
      assert.strictEqual(
        await fs.readFile(sourceAsset, "utf8"),
        "previous export"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("leaves an unmanifested assets-shaped repo directory untouched", async () => {
    const workspace = await makeWorkspace(
      "ctrlyoke-bundle-unmanifested-assets-"
    );
    try {
      const workflowDirectory = path.join(workspace, "workflows");
      const sourceDefinitionPath = path.join(
        workflowDirectory,
        "fix-tests.ctrlyoke.yaml"
      );
      const asset = path.join(workflowDirectory, "mygame.assets", "shot.png");
      await fs.mkdir(path.dirname(asset), { recursive: true });
      await fs.writeFile(asset, "repo asset", "utf8");

      const result = await analyzeWorkflowBundle(
        { prompt: "Review @./mygame.assets/shot.png" },
        {
          workspaceRoot: workspace,
          sourceDefinitionPath,
          destinationPath: destination(workspace),
        }
      );

      assert.strictEqual(result.plan.copies.length, 0);
      assert.strictEqual(result.plan.blockers.length, 0);
      assert.strictEqual(
        result.workflow.prompt,
        "Review @./mygame.assets/shot.png"
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("uses workflow-relative asset refs in a multi-root export", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-multi-root-");
    const secondaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-bundle-secondary-")
    );
    try {
      const source = path.join(
        secondaryRoot,
        ".ctrlyoke",
        "attachments",
        "image.png"
      );
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, "image", "utf8");
      const destinationPath = path.join(
        secondaryRoot,
        "workflows",
        "multi-root.ctrlyoke.yaml"
      );
      const result = await analyzeWorkflowBundle(
        { prompt: "Attach @secondary/.ctrlyoke/attachments/image.png" },
        {
          workspaceRoot: workspace,
          trustedRoots: [workspace, secondaryRoot],
          namedRoots: [
            { name: "primary", fsPath: workspace },
            { name: "secondary", fsPath: secondaryRoot },
          ],
          destinationPath,
        }
      );

      assert.strictEqual(result.plan.copies.length, 1);
      assert.strictEqual(
        result.plan.copies[0].relativePath,
        "./multi-root.assets/image.png"
      );
      assert.strictEqual(
        result.workflow.prompt as string,
        "Attach @./multi-root.assets/image.png"
      );
      assert.strictEqual(
        (result.workflow.prompt as string).includes("secondary/"),
        false
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(secondaryRoot, { recursive: true, force: true });
    }
  });

  test("returns no copy work for ordinary refs and computes safe manifest prunes", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-prune-");
    try {
      const assets = path.join(workspace, "workflows", "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(
        path.join(assets, ".ctrlyoke-assets.json"),
        JSON.stringify({
          version: BUNDLE_MANIFEST_VERSION,
          owner: "fix-tests.ctrlyoke.yaml",
          files: ["stale.txt"],
        }),
        "utf8"
      );
      const result = await analyze(workspace, { prompt: "Use @src/file.ts" });
      assert.strictEqual(result.plan.copies.length, 0);
      assert.deepStrictEqual(result.plan.pruneCandidates, ["stale.txt"]);
      assert.strictEqual(result.plan.blockers.length, 0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("blocks a same-stem JSON Save As from pruning the YAML owner's assets", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-sibling-owner-");
    try {
      const source = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "shot.png"
      );
      await fs.writeFile(source, "yaml asset", "utf8");
      const yamlPath = path.join(
        workspace,
        "workflows",
        "fix-tests.ctrlyoke.yaml"
      );
      const yamlAnalysis = await analyzeWorkflowBundle(
        { prompt: "Attach @.ctrlyoke/attachments/shot.png" },
        { workspaceRoot: workspace, destinationPath: yamlPath }
      );
      await writeWorkflowBundle({
        workflowPath: yamlPath,
        serializedWorkflow: JSON.stringify(yamlAnalysis.workflow),
        plan: yamlAnalysis.plan,
      });

      const jsonPath = path.join(
        workspace,
        "workflows",
        "fix-tests.ctrlyoke.json"
      );
      const jsonAnalysis = await analyzeWorkflowBundle(
        { prompt: "No generated references" },
        { workspaceRoot: workspace, destinationPath: jsonPath }
      );
      assert.ok(
        jsonAnalysis.plan.blockers.some((blocker) =>
          blocker.message.includes("fix-tests.ctrlyoke.yaml")
        )
      );
      assert.deepStrictEqual(jsonAnalysis.plan.pruneCandidates, []);
      await assert.rejects(() =>
        writeWorkflowBundle({
          workflowPath: jsonPath,
          serializedWorkflow: JSON.stringify(jsonAnalysis.workflow),
          plan: jsonAnalysis.plan,
        })
      );
      assert.strictEqual(
        await fs.readFile(
          path.join(workspace, "workflows", "fix-tests.assets", "shot.png"),
          "utf8"
        ),
        "yaml asset"
      );
      assert.strictEqual(
        await fs.access(jsonPath).then(
          () => true,
          () => false
        ),
        false
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("lets the owning workflow prune its own stale assets on re-save", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-owner-resave-");
    try {
      const source = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "shot.png"
      );
      await fs.writeFile(source, "yaml asset", "utf8");
      const yamlPath = path.join(
        workspace,
        "workflows",
        "fix-tests.ctrlyoke.yaml"
      );
      const firstSave = await analyzeWorkflowBundle(
        { prompt: "Attach @.ctrlyoke/attachments/shot.png" },
        { workspaceRoot: workspace, destinationPath: yamlPath }
      );
      await writeWorkflowBundle({
        workflowPath: yamlPath,
        serializedWorkflow: JSON.stringify(firstSave.workflow),
        plan: firstSave.plan,
      });

      const resave = await analyzeWorkflowBundle(
        { prompt: "No generated references" },
        { workspaceRoot: workspace, destinationPath: yamlPath }
      );
      assert.strictEqual(resave.plan.blockers.length, 0);
      assert.strictEqual(resave.plan.managedAssetsDirectory, true);
      assert.deepStrictEqual(resave.plan.pruneCandidates, ["shot.png"]);
      await writeWorkflowBundle({
        workflowPath: yamlPath,
        serializedWorkflow: JSON.stringify(resave.workflow),
        plan: resave.plan,
      });
      await assert.rejects(() =>
        fs.access(path.join(workspace, "workflows", "fix-tests.assets"))
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("adopts a legacy manifest only when no same-stem workflow sibling exists", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-legacy-adopt-");
    try {
      const assets = path.join(workspace, "workflows", "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(assets, "stale.png"), "stale", "utf8");
      await fs.writeFile(
        path.join(assets, BUNDLE_MANIFEST_FILE_NAME),
        JSON.stringify({ version: 1, files: ["stale.png"] }),
        "utf8"
      );

      const result = await analyze(workspace, { prompt: "No references" });
      assert.strictEqual(result.plan.blockers.length, 0);
      assert.strictEqual(result.plan.managedAssetsDirectory, true);
      assert.deepStrictEqual(result.plan.pruneCandidates, ["stale.png"]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("blocks adopting a legacy manifest when a same-stem sibling exists", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-legacy-sibling-");
    try {
      const assets = path.join(workspace, "workflows", "fix-tests.assets");
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(assets, "stale.png"), "stale", "utf8");
      await fs.writeFile(
        path.join(assets, BUNDLE_MANIFEST_FILE_NAME),
        JSON.stringify({ version: 1, files: ["stale.png"] }),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspace, "workflows", "fix-tests.ctrlyoke.json"),
        "{}",
        "utf8"
      );

      const result = await analyze(workspace, { prompt: "No references" });
      assert.ok(
        result.plan.blockers.some((blocker) =>
          blocker.message.includes("fix-tests.ctrlyoke.json")
        )
      );
      assert.strictEqual(result.plan.managedAssetsDirectory, undefined);
      assert.deepStrictEqual(result.plan.pruneCandidates, []);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a generated source symlink that escapes trusted roots", async function () {
    const workspace = await makeWorkspace("ctrlyoke-bundle-symlink-");
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-bundle-link-outside-")
    );
    try {
      const outsideFile = path.join(outside, "secret.txt");
      const link = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "secret.txt"
      );
      await fs.writeFile(outsideFile, "secret", "utf8");
      try {
        await fs.symlink(outsideFile, link);
      } catch {
        this.skip();
        return;
      }
      const result = await analyze(workspace, {
        prompt: "@.ctrlyoke/attachments/secret.txt",
      });
      assert.ok(result.plan.blockers.length > 0);
      assert.ok(
        result.plan.blockers.some((item) =>
          /outside|escape|symlink/i.test(item.message)
        )
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects an assets directory symlink independently of destination checks", async function () {
    const workspace = await makeWorkspace("ctrlyoke-bundle-destination-link-");
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-bundle-destination-outside-")
    );
    try {
      const source = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "image.png"
      );
      await fs.writeFile(source, "image", "utf8");
      await fs.mkdir(path.dirname(destination(workspace)), { recursive: true });
      await fs.symlink(
        outside,
        path.join(workspace, "workflows", "fix-tests.assets"),
        "junction"
      );
      const result = await analyze(workspace, {
        prompt: "@.ctrlyoke/attachments/image.png",
      });
      assert.ok(
        result.plan.blockers.some((item) =>
          /symbolic link|symlink|escape/i.test(item.message)
        )
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
        this.skip();
        return;
      }
      throw error;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("allows a plain Save As through a symlinked destination directory", async function () {
    const workspace = await makeWorkspace(
      "ctrlyoke-bundle-linked-destination-"
    );
    try {
      const realDirectory = path.join(workspace, "actual-workflows");
      const linkedDirectory = path.join(workspace, "workflows");
      await fs.mkdir(realDirectory, { recursive: true });
      await fs.symlink(
        realDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir"
      );

      const result = await analyze(workspace, { prompt: "Plain workflow" });

      assert.deepStrictEqual(result.plan.blockers, []);
      assert.strictEqual(result.plan.copies.length, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
        this.skip();
        return;
      }
      throw error;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("accepts generated references when the workspace root is a symlink", async function () {
    const workspace = await makeWorkspace("ctrlyoke-bundle-linked-root-");
    const linkedRoot = `${workspace}-link`;
    try {
      const source = path.join(
        workspace,
        ".ctrlyoke",
        "attachments",
        "image.png"
      );
      await fs.writeFile(source, "image bytes", "utf8");
      await fs.symlink(
        workspace,
        linkedRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
      const linkedDestination = path.join(
        linkedRoot,
        "workflows",
        "linked.ctrlyoke.yaml"
      );
      const result = await analyzeWorkflowBundle(
        { prompt: "Attach @.ctrlyoke/attachments/image.png" },
        { workspaceRoot: linkedRoot, destinationPath: linkedDestination }
      );

      assert.deepStrictEqual(result.plan.blockers, []);
      assert.strictEqual(result.plan.copies.length, 1);
      assert.strictEqual(
        await fs.readFile(result.plan.copies[0].sourcePath, "utf8"),
        "image bytes"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
        this.skip();
        return;
      }
      throw error;
    } finally {
      await fs.rm(linkedRoot, { recursive: true, force: true }).catch(() => {});
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("template mode inlines prompt files and names refused generated tokens", async () => {
    const workspace = await makeWorkspace("ctrlyoke-bundle-template-");
    try {
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "prompts", "template.prompt.md"),
        "template body",
        "utf8"
      );
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "attachments", "image.png"),
        "image",
        "utf8"
      );
      const result = await analyze(
        workspace,
        {
          steps: [
            { prompt: "./.ctrlyoke/prompts/template.prompt.md" },
            { prompt: "Attach @.ctrlyoke/attachments/image.png" },
          ],
        },
        { templateMode: true }
      );

      assert.strictEqual(
        (result.workflow.steps as any[])[0].prompt,
        "template body"
      );
      assert.ok(
        result.plan.blockers.some(
          (item) =>
            item.code === "template-generated-reference" &&
            item.fieldPath === "steps[1].prompt" &&
            item.token === "@.ctrlyoke/attachments/image.png"
        )
      );
      assert.strictEqual(result.plan.copies.length, 0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
