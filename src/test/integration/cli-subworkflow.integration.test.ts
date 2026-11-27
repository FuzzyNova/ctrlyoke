import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

const temporaryRoots: string[] = [];

suite("CLI sub-workflow runs", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("uses the parent's exit code for child failures according to onFail", async function () {
    this.timeout(60_000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-subfail-")
    );
    temporaryRoots.push(root);
    await writeWorkflow(root, "child.ctrlyoke.json", {
      name: "Child",
      steps: [{ type: "script", script: 'node -e "process.exit(1)"' }],
    });

    const continuing = await writeWorkflow(root, "continue.ctrlyoke.json", {
      steps: [
        {
          type: "workflow",
          workflow: "child.ctrlyoke.json",
          onFail: "continue",
        },
      ],
    });
    const stopping = await writeWorkflow(root, "stop.ctrlyoke.json", {
      steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
    });

    const continuedRun = await runCli(
      ["run", continuing, "--headless", "--cwd", root],
      root
    );
    const failedRun = await runCli(
      ["run", stopping, "--headless", "--cwd", root],
      root
    );
    assert.strictEqual(continuedRun.code, 0, continuedRun.stderr);
    assert.notStrictEqual(failedRun.code, 0, failedRun.stderr);
  });

  test("reports nested script progress with child names and JSON child addresses", async function () {
    this.timeout(60_000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-nested-")
    );
    temporaryRoots.push(root);
    await writeWorkflow(root, "grandchild.ctrlyoke.json", {
      name: "Grandchild",
      steps: [
        {
          type: "script",
          name: "leaf-script",
          script: "node -e \"console.log('grandchild-marker')\"",
        },
      ],
    });
    await writeWorkflow(root, "child.ctrlyoke.json", {
      name: "Child",
      steps: [
        {
          type: "script",
          name: "child-script",
          script: "node -e \"console.log('child-marker')\"",
        },
        { type: "workflow", workflow: "grandchild.ctrlyoke.json" },
      ],
    });
    const parent = await writeWorkflow(root, "parent.ctrlyoke.json", {
      name: "Parent",
      steps: [
        {
          type: "script",
          name: "parent-script",
          script: "node -e \"console.log('parent-marker')\"",
        },
        { type: "workflow", workflow: "child.ctrlyoke.json" },
      ],
    });
    const env = { CTRLYOKE_HOME: path.join(root, "state"), FORCE_COLOR: "0" };

    const text = await runCli(
      ["run", parent, "--headless", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(text.code, 0, text.stderr);
    assert.match(text.stdout, /\[Child\]/);
    assert.match(text.stdout, /\[Grandchild\]/);
    assert.match(text.stdout, /parent-marker/);
    assert.match(text.stdout, /child-marker/);
    assert.match(text.stdout, /grandchild-marker/);

    const json = await runCli(
      ["run", parent, "--headless", "--json", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(json.code, 0, json.stderr);
    const result = JSON.parse(json.stdout) as {
      subWorkflowRuns: Array<{
        stepId: string;
        workflowKey: string;
        runRef: string;
        status: string;
      }>;
    };
    assert.strictEqual(result.subWorkflowRuns.length, 1);
    assert.strictEqual(result.subWorkflowRuns[0]?.status, "completed");
    assert.ok(result.subWorkflowRuns[0]?.workflowKey);
    assert.ok(result.subWorkflowRuns[0]?.runRef);
    assert.ok(result.subWorkflowRuns[0]?.stepId);
  });
});

async function writeWorkflow(
  root: string,
  filename: string,
  workflow: Record<string, unknown>
): Promise<string> {
  const file = path.join(root, filename);
  await fs.writeFile(file, JSON.stringify(workflow), "utf8");
  return file;
}
