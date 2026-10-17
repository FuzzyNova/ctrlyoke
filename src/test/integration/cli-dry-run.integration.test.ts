import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";
import { DOCS_URLS } from "../../types/DashboardConstants";
import { projectKey } from "../../utils/ProjectStatePaths";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { WORKING_FILE_NAME } from "../../utils/WorkflowPaths";

const temporaryRoots: string[] = [];

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

  test("reports authored step limit violations in dry-run output and JSON", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-limit-preview-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "over-limit.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        maxSteps: 2,
        steps: [
          { type: "script", script: 'node -e "process.exit(0)"' },
          { type: "script", script: 'node -e "process.exit(0)"' },
          { type: "script", script: 'node -e "process.exit(0)"' },
        ],
      }),
      "utf8"
    );

    const text = await runCli(
      ["run", workflow, "--dry-run", "--cwd", root],
      root
    );
    assert.strictEqual(text.code, 0, text.stderr);
    assert.match(text.stdout, /Limit violations/u);
    assert.match(text.stdout, /Step count 3 exceeds limit 2/u);

    const json = await runCli(
      ["run", workflow, "--dry-run", "--json", "--cwd", root],
      root
    );
    assert.strictEqual(json.code, 0, json.stderr);
    const preview = JSON.parse(json.stdout) as {
      steps: Array<{
        resolvedProperties: { limits: { violations: string[] } };
      }>;
    };
    assert.deepStrictEqual(
      preview.steps[0].resolvedProperties.limits.violations,
      ["Step count 3 exceeds limit 2"]
    );
  });

  test("validate warns when authored steps exceed workflow maxSteps", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-limit-validate-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "over-limit.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        maxSteps: 2,
        steps: [
          { type: "script", script: "one" },
          { type: "script", script: "two" },
          { type: "script", script: "three" },
        ],
      }),
      "utf8"
    );

    const result = await runCli(["validate", workflow, "--json"], root);

    assert.strictEqual(result.code, 0, result.stderr);
    const validation = JSON.parse(result.stdout) as {
      success: boolean;
      warnings: Array<{
        code: string;
        message: string;
        propertyPointer: string;
      }>;
    };
    assert.strictEqual(validation.success, true);
    assert.ok(
      validation.warnings.some(
        (warning) =>
          warning.code === "step-limit-exceeded" &&
          warning.propertyPointer === "/maxSteps" &&
          warning.message.includes("3/2 steps")
      )
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

  test("reports explicit harness and model when a JSON run fails before loading", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-early-error-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "invalid.ctrlyoke.yaml");
    await fs.writeFile(workflow, "steps: [invalid", "utf8");

    const result = await runCli(
      [
        "run",
        workflow,
        "--harness",
        "claude-cli",
        "--model",
        "sonnet",
        "--headless",
        "--json",
        "--cwd",
        root,
      ],
      root
    );

    assert.strictEqual(result.code, 2, result.stderr);
    const report = JSON.parse(result.stdout) as {
      harness: string;
      model?: string;
      status: string;
    };
    assert.strictEqual(report.harness, "claude-cli");
    assert.strictEqual(report.model, "sonnet");
    assert.strictEqual(report.status, "error");
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
    assert.ok(
      result.stderr.includes(
        `Run \`ctrlyoke trust-secret-grants ${workflow}\` to review them.`
      ),
      result.stderr
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
    assert.ok(
      blocked.stderr.includes(
        `Run \`ctrlyoke trust-workflow-external-roots ${workflow}\` to review them.`
      ),
      blocked.stderr
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
        permissions: { trustedExternalRoots: [externalRoot] },
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

suite("CLI Commander exit codes", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("uses exit code 2 for unknown options and missing required options", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-parse-")
    );
    temporaryRoots.push(root);

    const unknownOption = await runCli(["run", "--not-a-real-option"], root);
    assert.strictEqual(unknownOption.code, 2, unknownOption.stderr);

    const missingRequiredOption = await runCli(["history", "runs"], root);
    assert.strictEqual(
      missingRequiredOption.code,
      2,
      missingRequiredOption.stderr
    );
  });

  test("keeps help at exit code 0", async function () {
    this.timeout(30000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-help-"));
    temporaryRoots.push(root);

    const result = await runCli(["--help"], root);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage: ctrlyoke/);
    assert.ok(
      result.stdout.includes(`Documentation: ${DOCS_URLS.CLI_REFERENCE}`)
    );

    const subcommand = await runCli(["run", "--help"], root);
    assert.strictEqual(subcommand.code, 0, subcommand.stderr);
    assert.ok(
      subcommand.stdout.includes(`Documentation: ${DOCS_URLS.CLI_REFERENCE}`)
    );
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
    assert.strictEqual(
      json.stdout.trim().split(/\r?\n/).length,
      1,
      "--json stdout stays a single document without terminal summary lines"
    );
    assert.doesNotMatch(
      json.stdout,
      /Run ID:|Tokens:|Workflow completed successfully/u
    );
    const result = JSON.parse(
      json.stdout.trim().split(/\r?\n/).pop() ?? ""
    ) as {
      harness: string;
      model: string;
    };
    assert.strictEqual(json.stdout, `${JSON.stringify(result)}\n`);
    assert.strictEqual(result.harness, "opencode-cli");
    assert.strictEqual(result.model, "opencode/big-pickle");
  });

  test("fails before running authored script steps that exceed maxSteps", async function () {
    this.timeout(60000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-limit-")
    );
    const stateHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-limit-state-")
    );
    temporaryRoots.push(root, stateHome);
    const workflow = path.join(root, "over-limit.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        maxSteps: 2,
        steps: [
          {
            type: "script",
            script:
              "node -e \"require('fs').writeFileSync('step-ran.txt', 'yes')\"",
          },
          { type: "script", script: 'node -e "process.exit(0)"' },
          { type: "script", script: 'node -e "process.exit(0)"' },
        ],
      }),
      "utf8"
    );

    const result = await runCli(
      ["run", workflow, "--headless", "--json", "--cwd", root],
      root,
      { CTRLYOKE_HOME: stateHome }
    );

    assert.strictEqual(result.code, 6, result.stderr);
    const jsonResult = JSON.parse(result.stdout) as {
      stopReason: {
        code: string;
        threshold: number;
        observed: number;
        unit: string;
        message: string;
      };
    };
    assert.deepStrictEqual(jsonResult.stopReason, {
      code: "queue-size-limit",
      threshold: 2,
      observed: 3,
      unit: "steps",
      message:
        "Step limit reached: this run has 3/2 steps (workflow maxSteps: 2).",
    });
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Step limit reached: this run has 3\/2 steps/u
    );
    assert.strictEqual(
      await pathExists(path.join(root, "step-ran.txt")),
      false
    );
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

  test("dry-run applies workflow-level harness and model flags", async function () {
    this.timeout(60000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-dry-run-harness-override-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "harness-model-override.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        harness: "claude-cli",
        model: "workflow-model",
        steps: [{ prompt: "Preview with CLI overrides" }],
      }),
      "utf8"
    );

    const result = await runCli(
      [
        "run",
        workflow,
        "--dry-run",
        "--json",
        "--harness",
        "codex-cli",
        "--model",
        "gpt-x",
        "--cwd",
        root,
      ],
      root
    );

    assert.strictEqual(result.code, 0, result.stderr);
    const preview = JSON.parse(result.stdout) as {
      workflow: { harnessIds: string[] };
      steps: Array<{
        resolvedProperties: { harnessId: string; model?: string };
        command: { displayCommand: string; args: string[] };
      }>;
    };
    assert.deepStrictEqual(preview.workflow.harnessIds, ["codex-cli"]);
    assert.strictEqual(
      preview.steps[0].resolvedProperties.harnessId,
      "codex-cli"
    );
    assert.strictEqual(preview.steps[0].resolvedProperties.model, "gpt-x");
    assert.match(preview.steps[0].command.displayCommand, /codex/u);
  });

  test("--model overrides the workflow model while step-level models still win", async function () {
    this.timeout(60000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-model-")
    );
    temporaryRoots.push(root);
    const workflow = path.join(root, "model-override.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        harness: "copilot-cli",
        model: "workflow-model",
        steps: [
          { prompt: "Use the workflow model" },
          { prompt: "Keep the explicit step model", model: "step-model" },
        ],
      }),
      "utf8"
    );

    const result = await runCli(
      [
        "run",
        workflow,
        "--dry-run",
        "--json",
        "--harness",
        "copilot-cli",
        "--model",
        "flag-model",
        "--cwd",
        root,
      ],
      root
    );

    assert.strictEqual(result.code, 0, result.stderr);
    const preview = JSON.parse(result.stdout) as {
      steps: Array<{ resolvedProperties: { model?: string } }>;
    };
    assert.strictEqual(preview.steps[0].resolvedProperties.model, "flag-model");
    assert.strictEqual(preview.steps[1].resolvedProperties.model, "step-model");
  });

  test("persists --var overrides and uses them when continuing a run", async function () {
    this.timeout(60000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-run-vars-"));
    const stateHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-run-vars-state-")
    );
    temporaryRoots.push(root, stateHome);
    const workflow = path.join(root, "vars.ctrlyoke.json");
    await fs.writeFile(
      workflow,
      JSON.stringify({
        vars: { who: "default" },
        steps: [
          {
            type: "script",
            script:
              "node -e \"process.exit(require('fs').existsSync('continue.flag') ? 0 : 1)\"",
            onFail: "stopWorkflow",
          },
          {
            type: "script",
            script:
              "node -e \"require('fs').writeFileSync('continued.txt', '{{who}}')\"",
          },
        ],
      }),
      "utf8"
    );

    const env = { CTRLYOKE_HOME: stateHome };
    const initialRun = await runCli(
      [
        "run",
        workflow,
        "--headless",
        "--json",
        "--cwd",
        root,
        "--var",
        "who=cli",
      ],
      root,
      env
    );

    assert.strictEqual(initialRun.code, 1, initialRun.stderr);
    const run = JSON.parse(initialRun.stdout) as {
      workflowKey: string;
      runRef: string;
    };
    const projectStateRoot = path.join(stateHome, "projects", projectKey(root));
    const workingFilePath = path.join(
      WorkflowPaths.runsRootForProjectState(projectStateRoot),
      run.workflowKey,
      run.runRef,
      WORKING_FILE_NAME
    );
    const workingFile = JSON.parse(
      await fs.readFile(workingFilePath, "utf8")
    ) as { vars?: Record<string, string> };
    assert.strictEqual(workingFile.vars?.who, "cli");

    await fs.writeFile(path.join(root, "continue.flag"), "", "utf8");
    const continuedRun = await runCli(
      [
        "continue",
        "--workflow",
        run.workflowKey,
        "--run",
        run.runRef,
        "--headless",
        "--json",
        "--cwd",
        root,
      ],
      root,
      env
    );

    assert.strictEqual(continuedRun.code, 0, continuedRun.stderr);
    assert.strictEqual(
      await fs.readFile(path.join(root, "continued.txt"), "utf8"),
      "cli"
    );
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
