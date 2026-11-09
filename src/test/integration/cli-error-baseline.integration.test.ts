import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

suite("CLI error contract baseline", () => {
  test("pins run option parser stderr and exit codes", async function () {
    this.timeout(60000);
    const cwd = process.cwd();
    const cases = [
      {
        args: ["run", "--sandbox-mode", "invalid", "--prompt", "x"],
        stderr:
          "error: option '--sandbox-mode <mode>' argument 'invalid' is invalid. --sandbox-mode must be one of: workspace-write, read-only\n",
      },
      {
        args: ["run", "--permission-mode", "invalid", "--prompt", "x"],
        stderr:
          "error: option '--permission-mode <mode>' argument 'invalid' is invalid. --permission-mode must be one of: dangerouslyAllowAll, allowAll, custom, none\n",
      },
      {
        args: ["run", "--var", "invalid", "--prompt", "x"],
        stderr:
          "error: option '--var <assignment>' argument 'invalid' is invalid. --var \"invalid\" must be in key=value format\n",
      },
    ];

    for (const baseline of cases) {
      const result = await runCli(baseline.args, cwd);
      assert.strictEqual(result.code, 2, result.stderr);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, baseline.stderr);
    }
  });

  test("pins missing run input text and JSON behavior", async function () {
    this.timeout(60000);
    const cwd = process.cwd();
    const text = await runCli(["run"], cwd);
    assert.strictEqual(text.code, 2, text.stderr);
    assert.strictEqual(text.stdout, "");
    assert.strictEqual(
      text.stderr,
      "Error: Provide a file argument or --prompt <text>\n"
    );

    const json = await runCli(["run", "--json"], cwd);
    assert.strictEqual(json.code, 2, json.stderr);
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      schemaVersion: 1,
      success: false,
      error: { message: "Provide a file argument or --prompt <text>" },
    });
    assert.strictEqual(json.stderr, "");
  });

  test("history errors use stderr text unless JSON is requested", async function () {
    this.timeout(60000);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-history-errors-"));
    try {
      const text = await runCli(["history", "runs", "--workflow", "nope"], cwd);
      assert.strictEqual(text.code, 2, text.stderr);
      assert.strictEqual(text.stdout, "");
      assert.match(text.stderr, /^Error: .*nope/);

      const json = await runCli(["history", "runs", "--workflow", "nope", "--json"], cwd);
      assert.strictEqual(json.code, 2, json.stderr);
      const envelope = JSON.parse(json.stdout);
      assert.strictEqual(envelope.schemaVersion, 1);
      assert.strictEqual(envelope.success, false);
      assert.match(envelope.error.message, /nope/);
      assert.strictEqual(json.stderr, "");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("pins step and validate error text and JSON envelopes", async function () {
    this.timeout(60000);
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-errors-")
    );
    try {
      const invalid = path.join(cwd, "invalid.yaml");
      const newer = path.join(cwd, "newer.yaml");
      await fs.writeFile(invalid, "steps: nope\n");
      await fs.writeFile(newer, "schemaVersion: 999\nsteps:\n  - prompt: hi\n");

      for (const args of [
        ["validate", path.join(cwd, "missing.yaml")],
        ["validate", path.join(cwd, "missing.yaml"), "--json"],
        ["validate", invalid],
        ["validate", invalid, "--json"],
        ["validate", newer],
        ["validate", newer, "--json"],
        ["validate", path.join(cwd, "missing.yaml"), "--json"],
      ]) {
        const result = await runCli(args, cwd);
        assert.strictEqual(
          result.code,
          2,
          `${args.join(" ")}\n${result.stderr}`
        );
        if (args.includes("--json")) {
          assert.doesNotThrow(() => JSON.parse(result.stdout), result.stdout);
          assert.ok(result.stdout.length > 0, args.join(" "));
        } else {
          assert.ok(result.stderr.length > 0, args.join(" "));
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
