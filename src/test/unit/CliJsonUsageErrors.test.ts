import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { runCli } from "../integration/helpers/cliProcess";

suite("CLI JSON usage errors", () => {
  let tempRoot: string;
  let stateHome: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-json-"));
    stateHome = path.join(tempRoot, "state");
    await fs.mkdir(stateHome);
  });

  teardown(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function assertErrorEnvelope(
    args: string[],
    runResult = false,
    expectStderr = true
  ) {
    const result = await runCli(args, tempRoot, { CTRLYOKE_HOME: stateHome });
    assert.strictEqual(result.code, 2, result.stderr);
    if (expectStderr) assert.match(result.stderr, /error:/i);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error);
    if (runResult) {
      assert.strictEqual(parsed.status, "error");
      assert.ok(parsed.summary);
      assert.ok(Array.isArray(parsed.steps));
      assert.ok("finalStep" in parsed);
    }
  }

  test("wraps a rejected run option value", async () => {
    await assertErrorEnvelope(["run", "s.yaml", "--timeout", "1.5", "--json"], true);
  });

  test("wraps a rejected import choice", async () => {
    await assertErrorEnvelope(["import", "/x", "--changes", "bogus", "--json"]);
  });

  test("wraps a missing required option", async () => {
    await assertErrorEnvelope(["history", "runs", "--json"]);
  });

  test("uses the run-result envelope for conflicting run usage", async () => {
    await assertErrorEnvelope(
      ["run", "s.yaml", "--prompt", "x", "--json"],
      true,
      false
    );
  });
});
