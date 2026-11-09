import * as assert from "assert";
import { suite, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

suite("CLI error contract baseline", () => {
  test("pins run option parser stderr and exit codes", async function () {
    this.timeout(60000);
    const cwd = process.cwd();
    const cases = [
      {
        args: ["run", "--sandbox-mode", "invalid", "--prompt", "x"],
        stderr: "error: option '--sandbox-mode <mode>' argument 'invalid' is invalid. --sandbox-mode must be one of: workspace-write, read-only\n",
      },
      {
        args: ["run", "--permission-mode", "invalid", "--prompt", "x"],
        stderr: "error: option '--permission-mode <mode>' argument 'invalid' is invalid. --permission-mode must be one of: dangerouslyAllowAll, allowAll, custom, none\n",
      },
      {
        args: ["run", "--var", "invalid", "--prompt", "x"],
        stderr: 'error: option \'--var <assignment>\' argument \'invalid\' is invalid. --var "invalid" must be in key=value format\n',
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
    assert.strictEqual(text.stderr, "Error: Provide a file argument or --prompt <text>\n");

    const json = await runCli(["run", "--json"], cwd);
    assert.strictEqual(json.code, 2, json.stderr);
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      schemaVersion: 1,
      success: false,
      error: { message: "Provide a file argument or --prompt <text>" },
    });
    assert.strictEqual(json.stderr, "");
  });
});
