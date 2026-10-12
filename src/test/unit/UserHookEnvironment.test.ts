import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { suite, test } from "mocha";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { prepareUserHookEnvironments } from "../../core/harness/shared/UserHookEnvironment";

const launcherPath = path.resolve(
  __dirname,
  "../../scripts/ctrlyoke-hook-run.js"
);

suite("UserHookEnvironment", () => {
  test("writes isolated per-hook values and registers the file for cleanup", async () => {
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-env-")
    );
    try {
      const prepared = prepareUserHookEnvironments({
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        extensionPath: tempDirectory,
        hookTempDirectory: tempDirectory,
        promptIndex: 3,
        hooks: [
          { event: "stop", command: "node first.js", env: { TOKEN: "first" } },
          { event: "stop", command: "node second.js", env: { TOKEN: "second" } },
        ],
      });
      assert.ok(prepared.tempFilePath);
      assert.ok(prepared.mutation);
      await prepared.mutation.apply();

      const envByHookId = JSON.parse(
        await fs.readFile(prepared.tempFilePath!, "utf8")
      ) as Record<string, Record<string, string>>;
      assert.strictEqual(envByHookId["hook-0"].TOKEN, "first");
      assert.strictEqual(envByHookId["hook-1"].TOKEN, "second");
      assert.strictEqual(prepared.hooks?.[0].env, undefined);
      assert.strictEqual(prepared.hooks?.[1].env, undefined);

      const launcher = prepared.hooks?.[0].command ?? "";
      assert.ok(launcher.includes("ctrlyoke-hook-run.js"));
      assert.ok(launcher.includes("hook-0"));
      const printTokenCommand = "node -e \"process.stdout.write(process.env.TOKEN)\"";
      for (const [hookId, expectedToken] of [
        ["hook-0", "first"],
        ["hook-1", "second"],
      ]) {
        const result: SpawnSyncReturns<string> = spawnSync(
          process.execPath,
          [
            launcherPath,
            prepared.tempFilePath!,
            hookId,
            Buffer.from(printTokenCommand, "utf8").toString("base64"),
          ],
          { encoding: "utf8" }
        );
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, expectedToken);
      }

      await fs.rm(prepared.tempFilePath!, { force: true });
      await assert.rejects(fs.access(prepared.tempFilePath!));
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("launcher passes stdin and stdout through and returns the command exit code", async () => {
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-launcher-")
    );
    const envFile = path.join(tempDirectory, "env.json");
    try {
      await fs.writeFile(
        envFile,
        JSON.stringify({ "hook-0": { HOOK_TOKEN: "first" }, "hook-1": { HOOK_TOKEN: "second" } })
      );
      const command =
        'node -e "process.stdin.pipe(process.stdout); process.exitCode = process.env.HOOK_TOKEN === \'first\' ? 7 : 8"';
      const result = spawnSync(
        process.execPath,
        [
          launcherPath,
          envFile,
          "hook-0",
          Buffer.from(command, "utf8").toString("base64"),
        ],
        { input: "permission payload", encoding: "utf8" }
      );
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.stdout, "permission payload");
      assert.strictEqual(result.status, 7);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
