import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { buildSubWorkflowReferenceStep } from "../../core/SubWorkflowReferenceStep";
import { PromptFileResolver } from "../../core/PromptFileResolver";
import { STEP_TYPES } from "../../types/DashboardConstants";
import { removeTempDir } from "../helpers/tempWorkspace";

suite("buildSubWorkflowReferenceStep", () => {
  let tempRoot: string;
  let primary: string;
  let secondary: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-subref-"));
    primary = path.join(tempRoot, "alpha");
    secondary = path.join(tempRoot, "beta");
    await fs.mkdir(path.join(primary, "flows"), { recursive: true });
    await fs.mkdir(path.join(secondary, "flows"), { recursive: true });
  });

  teardown(async () => {
    await removeTempDir(tempRoot);
  });

  async function writeWorkflow(filePath: string): Promise<string> {
    await fs.writeFile(filePath, "steps:\n  - prompt: child\n", "utf8");
    return filePath;
  }

  test("a file inside the workspace is referenced workspace-relative", async () => {
    const file = await writeWorkflow(
      path.join(primary, "flows", "verify.ctrlyoke.yaml")
    );

    assert.deepStrictEqual(buildSubWorkflowReferenceStep(file, primary), {
      type: STEP_TYPES.WORKFLOW,
      workflow: "flows/verify.ctrlyoke.yaml",
    });
  });

  test("a file outside the workspace is referenced by its absolute path", async () => {
    const file = await writeWorkflow(
      path.join(secondary, "flows", "outside.ctrlyoke.yaml")
    );

    const step = buildSubWorkflowReferenceStep(file, primary);

    assert.strictEqual(step.type, STEP_TYPES.WORKFLOW);
    assert.strictEqual(step.workflow, path.resolve(file));
  });

  test("in a multi-root workspace a file in another folder is prefixed with that folder's name and resolves", async () => {
    const namedRoots = [
      { name: "alpha", fsPath: primary },
      { name: "beta", fsPath: secondary },
    ];
    const inPrimary = await writeWorkflow(
      path.join(primary, "flows", "a.ctrlyoke.yaml")
    );
    const inSecondary = await writeWorkflow(
      path.join(secondary, "flows", "b.ctrlyoke.yaml")
    );

    const primaryStep = buildSubWorkflowReferenceStep(
      inPrimary,
      primary,
      namedRoots
    );
    const secondaryStep = buildSubWorkflowReferenceStep(
      inSecondary,
      primary,
      namedRoots
    );

    assert.strictEqual(primaryStep.workflow, "flows/a.ctrlyoke.yaml");
    assert.strictEqual(secondaryStep.workflow, "beta/flows/b.ctrlyoke.yaml");
    // The reference must resolve back to the same file the way a
    // sub-workflow step's `workflow` path is resolved at launch (D5).
    const resolver = new PromptFileResolver({
      workspaceRoot: primary,
      namedRoots,
      trustedRoots: [primary, secondary],
    });
    for (const [step, file] of [
      [primaryStep, inPrimary],
      [secondaryStep, inSecondary],
    ] as const) {
      const resolved = await resolver.resolvePath(step.workflow as string);
      assert.strictEqual(resolved.status, "resolved");
      assert.strictEqual(
        await fs.realpath(resolved.path!),
        await fs.realpath(file)
      );
    }
  });
});
