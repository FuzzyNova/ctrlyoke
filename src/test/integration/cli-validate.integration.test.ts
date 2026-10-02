import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

const temporaryRoots: string[] = [];

suite("ctrlyoke validate compatibility command", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      // A CLI child killed by a timeout can still hold the directory on
      // Windows; residual cleanup must never fail an otherwise green run.
      await fs
        .rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        })
        .catch(() => {});
    }
  });

  test("preserves parse-only output and emits clean JSON when requested", async function () {
    // Above the suite default: the first test in this file pays the cold start
    // of two spawned CLI processes, which timed out under a full npm test load.
    this.timeout(60000);
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

  test("workflow file arguments stay relative to process cwd when --cwd differs", async function () {
    this.timeout(60000);
    const processRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-file-cwd-")
    );
    temporaryRoots.push(processRoot);
    const workspaceRoot = path.join(processRoot, "workspace");
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(
      path.join(processRoot, "workflow.ctrlyoke.yaml"),
      "prompt: Check this workflow\n",
      "utf8"
    );

    const checks = await runCli(
      ["secret", "check", "workflow.ctrlyoke.yaml", "--cwd", workspaceRoot],
      processRoot
    );
    assert.strictEqual(checks.code, 0, checks.stderr);

    const grants = await runCli(
      ["trust-secret-grants", "workflow.ctrlyoke.yaml", "--cwd", workspaceRoot],
      processRoot
    );
    assert.strictEqual(grants.code, 0, grants.stderr);
    assert.match(grants.stdout, /No pending secret grants/u);

    const roots = await runCli(
      [
        "trust-workflow-external-roots",
        "workflow.ctrlyoke.yaml",
        "--cwd",
        workspaceRoot,
      ],
      processRoot
    );
    assert.strictEqual(roots.code, 0, roots.stderr);
    assert.match(roots.stdout, /No pending workflow external file roots/u);
  });

  test("refuses newer workflow formats with exit 2 and a distinct JSON code", async function () {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-validate-newer-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "future.ctrlyoke.yaml");
    await fs.writeFile(
      workflow,
      "schemaVersion: 2\nfutureWorkflowProperty: true\n",
      "utf8"
    );

    const human = await runCli(["validate", workflow], root);
    assert.strictEqual(human.code, 2);
    assert.match(
      human.stderr,
      /future\.ctrlyoke\.yaml \(YAML\) uses workflow format 2/u
    );
    assert.match(human.stderr, /supports format 1/u);

    const json = await runCli(["validate", workflow, "--json"], root);
    assert.strictEqual(json.code, 2);
    const result = JSON.parse(json.stdout) as {
      error: string;
      errorCode: string;
    };
    assert.strictEqual(result.errorCode, "workflow-newer-format");
    assert.strictEqual(result.error, human.stderr.trim());
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

  test("rejects an unknown harness for run, rerun, and append", async function () {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-harness-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "workflow.ctrlyoke.yaml");
    await fs.writeFile(workflow, "prompt: Must not run\n", "utf8");

    const commands = [
      ["run", workflow, "--harness", "bogus", "--headless", "--json"],
      [
        "rerun",
        "--workflow",
        "missing-workflow",
        "--harness",
        "bogus",
        "--json",
      ],
      [
        "append",
        "--workflow",
        "missing-workflow",
        "--run",
        "1",
        "--harness",
        "bogus",
        "--prompt",
        "Must not run",
        "--json",
      ],
    ];

    for (const args of commands) {
      const result = await runCli(args, root);
      assert.strictEqual(result.code, 2, `${args[0]}: ${result.stderr}`);
      assert.match(result.stderr, /Invalid harness: bogus/u);
    }
  });

  test("reports a half-configured comparison as a warning without failing", async function () {
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

  test("reports unknown fields with exact paths and fails them in strict mode", async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-validate-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "typo.ctrlyoke.yaml");
    await fs.writeFile(
      workflow,
      ["steps:", "  - prompt: Do the work", "    endConditon: {}"].join("\n"),
      "utf8"
    );

    const human = await runCli(["validate", workflow], root);
    assert.strictEqual(human.code, 0, human.stderr);
    assert.match(human.stdout, /\/steps\/0\/endConditon/u);
    assert.match(human.stdout, /did you mean 'endCondition'/iu);
    assert.match(human.stdout, /newer ctrlyoke/u);

    const json = await runCli(["validate", workflow, "--json"], root);
    assert.strictEqual(json.code, 0, json.stderr);
    const result = JSON.parse(json.stdout) as {
      success: boolean;
      warnings: Array<{ code: string; propertyPointer: string }>;
    };
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      result.warnings.map((warning) => [warning.code, warning.propertyPointer]),
      [["unknown-property", "/steps/0/endConditon"]]
    );

    const strict = await runCli(
      ["validate", workflow, "--strict", "--json"],
      root
    );
    assert.strictEqual(strict.code, 2, strict.stderr);
    const strictResult = JSON.parse(strict.stdout) as {
      success: boolean;
      error: string;
      warnings: Array<{ propertyPointer: string }>;
    };
    assert.strictEqual(strictResult.success, false);
    assert.match(strictResult.error, /Unknown workflow fields/u);
    assert.strictEqual(
      strictResult.warnings[0].propertyPointer,
      "/steps/0/endConditon"
    );
  });

  test("fails on a semantic error the schema cannot catch", async function () {
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

  test("keeps parser diagnostics out of JSON stdout across validation and secret gates", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-parse-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "invalid.ctrlyoke.yaml");
    await fs.writeFile(workflow, "steps:\n  - bogus: 1\n", "utf8");

    const validation = await runCli(["validate", workflow, "--json"], root);
    assert.strictEqual(validation.code, 2);
    assert.strictEqual(validation.stderr, "");
    assert.strictEqual(validation.stdout.trim().split(/\r?\n/u).length, 1);
    const result = JSON.parse(validation.stdout) as {
      success: boolean;
      error: string;
    };
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Validation failed:/u);
    assert.match(result.error, /steps/u);

    const secretCheck = await runCli(["secret", "check", workflow], root);
    assert.strictEqual(secretCheck.code, 2);
    assert.strictEqual(secretCheck.stdout, "");

    const trustGrants = await runCli(["trust-secret-grants", workflow], root);
    assert.strictEqual(trustGrants.code, 2);
    assert.strictEqual(trustGrants.stdout, "");
  });
});
