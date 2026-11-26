import * as assert from "assert";
import { execFileSync, spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

const temporaryRoots: string[] = [];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(root: string, args: string[]): Promise<CliResult> {
  const cliPath = path.join(__dirname, "..", "..", "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      cwd: root,
      env: {
        ...process.env,
        CTRLYOKE_HOME: path.join(root, "state"),
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

suite("CLI import continuation", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  for (const json of [false, true]) {
    test(`imports and continues a pending run in ${json ? "JSON" : "text"} mode`, async function () {
      this.timeout(90_000);
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-cli-import-continue-")
      );
      temporaryRoots.push(root);
      const workflowPath = path.join(root, "workflow.ctrlyoke.yaml");
      const markerPath = path.join(root, "pending-step-ran");
      const flagPath = path.join(root, "flag.txt");
      const bundlePath = path.join(root, "run.ctrlyokerun");
      await fs.writeFile(
        workflowPath,
        [
          "name: import continuation fixture",
          "steps:",
          "  - type: script",
          `    script: ${JSON.stringify("node -e \"process.exit(require('fs').existsSync('flag.txt') ? 0 : 1)\"")}`,
          "  - type: script",
          `    script: ${JSON.stringify(`node -e "require('fs').writeFileSync('${markerPath.replace(/\\/gu, "/")}', 'ran'); process.exit(1)"`)}`,
          "",
        ].join("\n"),
        "utf8"
      );
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "CLI integration"], {
        cwd: root,
      });
      execFileSync("git", ["config", "user.email", "cli@example.test"], {
        cwd: root,
      });
      execFileSync("git", ["add", "workflow.ctrlyoke.yaml"], { cwd: root });
      execFileSync("git", ["commit", "-m", "add continuation fixture"], {
        cwd: root,
        stdio: "ignore",
      });

      const firstRun = await runCli(root, [
        "run",
        workflowPath,
        "--headless",
        "--cwd",
        root,
        "--json",
      ]);
      assert.strictEqual(firstRun.code, 1, firstRun.stderr);
      const runResult = JSON.parse(firstRun.stdout.trim()) as {
        workflowKey: string;
      };
      assert.ok(runResult.workflowKey);

      const exported = await runCli(root, [
        "export",
        "--workflow",
        runResult.workflowKey,
        "--out",
        bundlePath,
        "--cwd",
        root,
        "--json",
      ]);
      assert.strictEqual(exported.code, 0, exported.stderr);
      assert.strictEqual(
        (JSON.parse(exported.stdout.trim()) as { continuable: boolean })
          .continuable,
        true,
        `run: ${firstRun.stdout}\nexport: ${exported.stdout}\n${exported.stderr}`
      );

      await fs.writeFile(flagPath, "ready", "utf8");
      const imported = await runCli(root, [
        "import",
        bundlePath,
        "--continue",
        "--changes",
        "skip",
        "--cwd",
        root,
        ...(json ? ["--json"] : []),
      ]);
      assert.strictEqual(
        imported.code,
        1,
        `${imported.stderr}\n${imported.stdout}`
      );
      assert.ok(await fs.readFile(markerPath, "utf8"));
      if (json) {
        const lines = imported.stdout.trim().split(/\r?\n/u);
        assert.strictEqual(lines.length, 1, imported.stdout);
        const result = JSON.parse(lines[0]) as {
          success: boolean;
          continued: boolean;
        };
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.continued, true);
      } else {
        assert.match(imported.stdout, /^Imported /mu);
        assert.match(imported.stdout, /Continuing imported run\./u);
      }
    });
  }
});
