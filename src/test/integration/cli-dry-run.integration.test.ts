import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const temporaryRoots: string[] = [];

function runCli(args: string[], cwd: string): Promise<CliRunResult> {
  const cliPath = path.join(__dirname, "..", "..", "cli.js");
  return new Promise((resolve) => {
    execFile(
      "node",
      [cliPath, ...args],
      { cwd, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            typeof error?.code === "number"
              ? error.code
              : error
                ? 1
                : 0,
          stdout,
          stderr,
        });
      }
    );
  });
}

suite("CLI dry-run process", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("returns the preview without running scripts or writing harness artifacts", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-dry-run-"));
    temporaryRoots.push(root);
    const fixture = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "src",
      "test",
      "fixtures",
      "prompts",
      "single.ctrlyoke.yaml"
    );

    const result = await runCli(
      [
        "run",
        fixture,
        "--dry-run",
        "--json",
        "--cwd",
        root,
        "--var",
        "target=auth",
      ],
      root
    );

    assert.strictEqual(result.code, 0, result.stderr);
    const preview = JSON.parse(result.stdout) as {
      steps: Array<{ variables: Array<{ name: string; value: string }> }>;
    };
    assert.deepStrictEqual(preview.steps[0].variables, [
      { name: "target", source: "prompt", value: "auth", redactions: [] },
    ]);
    assert.strictEqual(await pathExists(path.join(root, ".github")), false);
    assert.strictEqual(
      await pathExists(path.join(root, ".ctrlyoke", "temp")),
      false
    );
  });

  test("exits nonzero for an invalid workflow/provider combination", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-dry-run-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "invalid.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        harness: "not-a-harness",
        steps: [{ prompt: "This must not execute" }],
      }),
      "utf8"
    );

    const result = await runCli(
      ["run", workflow, "--dry-run", "--json", "--cwd", root],
      root
    );

    assert.notStrictEqual(result.code, 0);
    assert.match(result.stderr, /Failed to load workflow file|Validation failed/);
  });
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
