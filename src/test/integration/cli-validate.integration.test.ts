import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const temporaryRoots: string[] = [];

function runCli(args: string[], cwd: string): Promise<CliResult> {
  const cliPath = path.join(__dirname, "..", "..", "cli.js");
  return new Promise((resolve) => {
    execFile("node", [cliPath, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

suite("ctrlyoke validate compatibility command", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("preserves parse-only output and emits clean JSON when requested", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-validate-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "workflow.ctrlyoke.yaml");
    await fs.writeFile(workflow, "prompt: Validate this file\n", "utf8");

    const human = await runCli(["validate", workflow], root);
    assert.strictEqual(human.code, 0, human.stderr);
    assert.match(human.stdout, /workflow\.ctrlyoke\.yaml is valid/u);

    const json = await runCli(["validate", workflow, "--json"], root);
    assert.strictEqual(json.code, 0, json.stderr);
    assert.strictEqual(json.stderr, "");
    assert.strictEqual(json.stdout.trim().split(/\r?\n/u).length, 1);
    const result = JSON.parse(json.stdout) as {
      schemaVersion: number;
      parsed: boolean;
      target: unknown;
    };
    assert.strictEqual(result.schemaVersion, 1);
    assert.strictEqual(result.parsed, true);
    assert.strictEqual(result.target, null);
  });

  test("analyzes one target and filters all-installed targets to available harnesses", async function () {
    this.timeout(60000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-validate-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "scripts.ctrlyoke.yaml");
    await fs.writeFile(
      workflow,
      ["steps:", "  - type: script", "    script: echo script"].join("\n"),
      "utf8"
    );

    const targeted = await runCli(
      ["validate", workflow, "--harness", "codex-cli", "--json"],
      root
    );
    assert.strictEqual(targeted.stderr, "");
    const targetedResult = JSON.parse(targeted.stdout) as {
      target: { kind: string; harnesses: Array<{ harnessId: string }> };
    };
    assert.strictEqual(targetedResult.target.kind, "harness");
    assert.deepStrictEqual(
      targetedResult.target.harnesses.map((harness) => harness.harnessId),
      ["codex-cli"]
    );

    const all = await runCli(
      ["validate", workflow, "--all-installed-harnesses", "--json"],
      root
    );
    assert.strictEqual(all.stderr, "");
    const allResult = JSON.parse(all.stdout) as {
      target: {
        kind: string;
        harnesses: Array<{ harnessId: string; available: boolean }>;
      };
    };
    assert.strictEqual(allResult.target.kind, "allInstalledHarnesses");
    assert.ok(allResult.target.harnesses.every((harness) => harness.available));
  });

  test("rejects conflicting targets and invalid strict values as usage errors", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-validate-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "workflow.ctrlyoke.yaml");
    await fs.writeFile(workflow, "prompt: Validate this file\n", "utf8");

    const conflicting = await runCli(
      [
        "validate",
        workflow,
        "--harness",
        "codex-cli",
        "--all-installed-harnesses",
        "--json",
      ],
      root
    );
    assert.strictEqual(conflicting.code, 2);
    assert.strictEqual(conflicting.stderr, "");
    assert.match(conflicting.stdout, /cannot be used together/u);

    const invalidStrict = await runCli(
      [
        "validate",
        workflow,
        "--harness",
        "codex-cli",
        "--strict",
        "nope",
        "--json",
      ],
      root
    );
    assert.strictEqual(invalidStrict.code, 2);
    assert.strictEqual(invalidStrict.stderr, "");
    assert.match(invalidStrict.stdout, /Invalid strict policy/u);

    const invalidHarness = await runCli(
      ["validate", workflow, "--harness", "not-a-harness", "--json"],
      root
    );
    assert.strictEqual(invalidHarness.code, 2);
    assert.strictEqual(invalidHarness.stderr, "");
    assert.match(invalidHarness.stdout, /Invalid harness/u);

    const missingFile = await runCli(
      ["validate", path.join(root, "missing.yaml"), "--json"],
      root
    );
    assert.strictEqual(missingFile.code, 2);
    assert.strictEqual(missingFile.stderr, "");
    assert.match(missingFile.stdout, /File not found/u);
  });

  test("reports a half-configured comparison as a warning without failing", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-validate-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "incomplete.ctrlyoke.yaml");
    await fs.writeFile(
      workflow,
      [
        "steps:",
        "  - prompt: Do the work",
        "    endCondition:",
        "      script: npm test",
        "      compareSource: stdout",
      ].join("\n"),
      "utf8"
    );

    const human = await runCli(["validate", workflow], root);
    assert.strictEqual(human.code, 0, human.stderr);
    assert.match(human.stdout, /incomplete\.ctrlyoke\.yaml is valid/u);
    assert.match(human.stdout, /"stdout ==" is ignored/u);
    assert.match(human.stdout, /\/steps\/0\/endCondition\/expected/u);

    const json = await runCli(["validate", workflow, "--json"], root);
    assert.strictEqual(json.code, 0, json.stderr);
    const result = JSON.parse(json.stdout) as {
      success: boolean;
      warnings: Array<{
        code: string;
        message: string;
        propertyPointer: string;
      }>;
    };
    assert.strictEqual(
      result.success,
      true,
      "a workflow warning never fails validation"
    );
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(result.warnings[0].code, "script-comparison-incomplete");
    assert.strictEqual(
      result.warnings[0].propertyPointer,
      "/steps/0/endCondition/expected"
    );
  });

  test("fails on a semantic error the schema cannot catch", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-validate-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "empty-prompt.ctrlyoke.yaml");
    await fs.writeFile(
      workflow,
      ["steps:", '  - prompt: "   "'].join("\n"),
      "utf8"
    );

    const human = await runCli(["validate", workflow], root);
    assert.strictEqual(human.code, 2);
    assert.match(human.stderr, /Empty prompt text/u);

    const json = await runCli(["validate", workflow, "--json"], root);
    assert.strictEqual(json.code, 2);
    const result = JSON.parse(json.stdout) as {
      success: boolean;
      parsed: boolean;
      error: string;
    };
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.parsed, true);
    assert.match(result.error, /Empty prompt text/u);
  });
});
