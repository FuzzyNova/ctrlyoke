import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { rebaseWorkflowStepPaths } from "../../core/WorkflowStepPathRebaser";
import { parseAllFileReferences } from "../../utils/FileReferenceParser";
import type { PromptStep } from "../../types/CtrlYokeTypes";

suite("WorkflowStepPathRebaser", () => {
  let workspaceRoot: string;
  let sourcePath: string;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-rebaser-"));
    await fs.mkdir(path.join(workspaceRoot, "sub"));
    sourcePath = path.join(workspaceRoot, "sub", "extra.ctrlyoke.yaml");
    await fs.writeFile(sourcePath, "steps: []\n");
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function rebasePrompt(prompt: string): Promise<string> {
    const [step] = await rebaseWorkflowStepPaths(
      [{ prompt }],
      sourcePath,
      workspaceRoot
    );
    return (step as PromptStep).prompt;
  }

  test("keeps an extensionless rebased @ path parseable by quoting it", async () => {
    const rebased = await rebasePrompt("Build with @../Makefile now");

    assert.strictEqual(rebased, 'Build with @"Makefile" now');
    const [reference] = parseAllFileReferences(rebased);
    assert.strictEqual(reference?.path, "Makefile");
  });

  test("rebases selection references and preserves their line range", async () => {
    const rebased = await rebasePrompt("See #selection:../root.ts:3-5 please");

    assert.strictEqual(rebased, "See #selection:root.ts:3-5 please");
    const [reference] = parseAllFileReferences(rebased);
    assert.strictEqual(reference?.path, "root.ts");
    assert.strictEqual(reference?.startLine, 3);
    assert.strictEqual(reference?.endLine, 5);
  });

  test("keeps an already quoted path quoted without doubling quotes", async () => {
    const rebased = await rebasePrompt('Read @"./my notes.md"');

    assert.strictEqual(rebased, 'Read @"sub/my notes.md"');
  });

  test("leaves workspace-relative references unchanged", async () => {
    const rebased = await rebasePrompt("Read @docs/guide.md");

    assert.strictEqual(rebased, "Read @docs/guide.md");
  });
});
