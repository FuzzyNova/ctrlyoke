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
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
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
    assert.match(
      result.stderr,
      /Failed to load workflow file|Validation failed/
    );
  });

  test("fails closed with exit code 2 when workflow secret grants are pending", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-dry-run-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "pending-grants.ctrlyoke.json");
    const grantName = `PENDING_CLI_GATE_${path
      .basename(root)
      .replace(/[^A-Za-z0-9_]/g, "_")
      .toUpperCase()}`;
    await fs.writeFile(
      workflow,
      JSON.stringify({
        steps: [
          {
            name: "deploy",
            secrets: [grantName],
            prompt: "This must not execute",
          },
        ],
      }),
      "utf8"
    );

    const result = await runCli(
      ["run", workflow, "--dry-run", "--json", "--cwd", root],
      root
    );

    assert.strictEqual(result.code, 2, result.stderr);
    assert.match(result.stderr, new RegExp(grantName));
    assert.match(
      result.stderr,
      /Run `ctrlyoke trust-secret-grants <file>` to review and approve them\./
    );
  });

  test("fails closed on pending workflow roots, then allows a trusted workflow to run", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-roots-")
    );
    const externalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-external-")
    );
    temporaryRoots.push(root, externalRoot);
    const workflow = path.join(root, "workflow.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        trustedExternalRoots: [externalRoot],
        steps: [{ prompt: "This must not execute" }],
      }),
      "utf8"
    );

    const blocked = await runCli(
      ["run", workflow, "--dry-run", "--json", "--cwd", root],
      root
    );
    assert.strictEqual(blocked.code, 2, blocked.stderr);
    assert.match(
      blocked.stderr,
      new RegExp(externalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.match(
      blocked.stderr,
      /Run `ctrlyoke trust-workflow-external-roots <file>` to review and approve them\./
    );

    const trusted = await runCli(
      ["trust-workflow-external-roots", workflow, "--cwd", root, "--yes"],
      root
    );
    assert.strictEqual(trusted.code, 0, trusted.stderr);
    assert.doesNotMatch(trusted.stdout, /\[y\/N\]/u);

    const allowed = await runCli(
      ["run", workflow, "--dry-run", "--json", "--cwd", root],
      root
    );
    assert.strictEqual(allowed.code, 0, allowed.stderr);
  });

  test("does not gate workflows with null or omitted trustedExternalRoots", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workflow-roots-")
    );
    const externalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workspace-external-")
    );
    temporaryRoots.push(root, externalRoot);
    await fs.mkdir(path.join(root, ".ctrlyoke"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ctrlyoke", "settings.json"),
      JSON.stringify({
        permissions: { allowedExternalFileRoots: [externalRoot] },
      }),
      "utf8"
    );

    const workspaceTrust = await runCli(
      ["trust-external-roots", "--cwd", root, "--yes"],
      root
    );
    assert.strictEqual(workspaceTrust.code, 0, workspaceTrust.stderr);

    const nullWorkflow = path.join(root, "null.ctrlyoke.json");
    await fs.writeFile(
      nullWorkflow,
      JSON.stringify({
        trustedExternalRoots: null,
        steps: [{ prompt: "Null disables external roots" }],
      }),
      "utf8"
    );
    const nullResult = await runCli(
      ["run", nullWorkflow, "--dry-run", "--json", "--cwd", root],
      root
    );
    assert.strictEqual(nullResult.code, 0, nullResult.stderr);

    const inheritedWorkflow = path.join(root, "inherited.ctrlyoke.json");
    await fs.writeFile(
      inheritedWorkflow,
      JSON.stringify({ steps: [{ prompt: "Omitted inherits defaults" }] }),
      "utf8"
    );
    const inheritedResult = await runCli(
      ["run", inheritedWorkflow, "--dry-run", "--json", "--cwd", root],
      root
    );
    assert.strictEqual(inheritedResult.code, 0, inheritedResult.stderr);
  });
});

suite("CLI run process harness reporting", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /** A script-only workflow runs through the real CLI without any AI harness. */
  async function writeScriptOnlyWorkflow(root: string): Promise<string> {
    const workflow = path.join(root, "harness-report.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        harness: "opencode-cli",
        model: "opencode/big-pickle",
        steps: [
          {
            type: "script",
            name: "noop",
            script: 'node -e "process.exit(0)"',
          },
        ],
      }),
      "utf8"
    );
    return workflow;
  }

  test("header and --json report the workflow's harness, not a copilot-cli default", async function () {
    this.timeout(60000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-run-hdr-"));
    temporaryRoots.push(root);
    const workflow = await writeScriptOnlyWorkflow(root);

    const text = await runCli(
      ["run", workflow, "--headless", "--cwd", root],
      root
    );
    assert.strictEqual(text.code, 0, text.stderr);
    assert.match(text.stdout, /Harness: opencode-cli \(opencode\/big-pickle\)/);
    assert.doesNotMatch(text.stdout, /copilot-cli/);

    const json = await runCli(
      ["run", workflow, "--headless", "--json", "--cwd", root],
      root
    );
    assert.strictEqual(json.code, 0, json.stderr);
    const result = JSON.parse(
      json.stdout.trim().split(/\r?\n/).pop() ?? ""
    ) as {
      harness: string;
      model: string;
    };
    assert.strictEqual(result.harness, "opencode-cli");
    assert.strictEqual(result.model, "opencode/big-pickle");
  });

  test("an explicit --harness still overrides the workflow's harness", async function () {
    this.timeout(60000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-run-hdr-"));
    temporaryRoots.push(root);
    const workflow = await writeScriptOnlyWorkflow(root);

    const result = await runCli(
      ["run", workflow, "--headless", "--harness", "claude-cli", "--cwd", root],
      root
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /Harness: claude-cli/);
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
