import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

const temporaryRoots: string[] = [];

// Each case spawns two or three compiled-CLI runs that each start child
// instances, which is more than the 30-second default allows under `npm test`.
const CLI_RUN_TIMEOUT_MS = 90_000;

suite("CLI sub-workflow runs", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  test("keeps the root run's progress output unprefixed", async function () {
    this.timeout(CLI_RUN_TIMEOUT_MS);
    const root = await makeRoot("ctrlyoke-cli-root-output-");
    const env = await fakeCopilotEnv(root);
    const workflow = await writeWorkflow(root, "root.ctrlyoke.json", {
      name: "Root",
      harness: "copilot-cli",
      model: "gpt-5",
      steps: [
        { name: "ask", prompt: "hello" },
        { type: "script", name: "first", script: markerScript("first") },
      ],
      finalStep: { type: "script", name: "wrap", script: markerScript("wrap") },
    });

    const run = await runCli(
      ["run", workflow, "--headless", "--cwd", root],
      root,
      env
    );

    assert.strictEqual(run.code, 0, run.stderr);
    assert.strictEqual(normalizeOutput(run.stdout, root), ROOT_GOLDEN_OUTPUT);
  });

  test("a child that fails under onFail continue runs, fails and leaves the parent at exit 0", async function () {
    this.timeout(CLI_RUN_TIMEOUT_MS);
    const root = await makeRoot("ctrlyoke-cli-subfail-");
    const env = { CTRLYOKE_HOME: path.join(root, "state") };
    const childRanMarker = path.join(root, "child-ran.txt");
    await writeWorkflow(root, "child.ctrlyoke.json", {
      name: "Child",
      steps: [
        {
          type: "script",
          script: `node -e "require('fs').writeFileSync(process.argv[1], 'ran'); process.exit(1)" ${JSON.stringify(childRanMarker)}`,
        },
      ],
    });
    const continuing = await writeWorkflow(root, "continue.ctrlyoke.json", {
      steps: [
        {
          type: "workflow",
          workflow: "child.ctrlyoke.json",
          onFail: "continue",
        },
      ],
    });
    const stopping = await writeWorkflow(root, "stop.ctrlyoke.json", {
      steps: [{ type: "workflow", workflow: "child.ctrlyoke.json" }],
    });

    const continuedRun = await runCli(
      ["run", continuing, "--headless", "--json", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(continuedRun.code, 0, continuedRun.stderr);
    assert.strictEqual(await fs.readFile(childRanMarker, "utf8"), "ran");
    const continued = JSON.parse(continuedRun.stdout) as CliJsonWithChildren;
    assert.deepStrictEqual(
      continued.subWorkflowRuns.map((child) => child.status),
      ["failed"]
    );

    await fs.rm(childRanMarker);
    const failedRun = await runCli(
      ["run", stopping, "--headless", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(failedRun.code, 1, failedRun.stderr);
    assert.strictEqual(await fs.readFile(childRanMarker, "utf8"), "ran");
  });

  test("labels nested progress with the nearest child's name and prints one summary", async function () {
    this.timeout(CLI_RUN_TIMEOUT_MS);
    const root = await makeRoot("ctrlyoke-cli-nested-");
    // The grandchild has no `name`: it is labelled from its file name.
    await writeWorkflow(root, "grandchild.ctrlyoke.json", {
      steps: [
        { type: "script", name: "leaf-script", script: markerScript("leaf") },
      ],
    });
    await writeWorkflow(root, "child.ctrlyoke.json", {
      name: "Child",
      steps: [
        { type: "script", name: "child-script", script: markerScript("child") },
        { type: "workflow", workflow: "grandchild.ctrlyoke.json" },
        { type: "script", name: "after-script", script: markerScript("after") },
      ],
    });
    const parent = await writeWorkflow(root, "parent.ctrlyoke.json", {
      name: "Parent",
      steps: [
        {
          type: "script",
          name: "parent-script",
          script: markerScript("parent"),
        },
        { type: "workflow", workflow: "child.ctrlyoke.json" },
      ],
    });
    const env = { CTRLYOKE_HOME: path.join(root, "state") };

    const text = await runCli(
      ["run", parent, "--headless", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(text.code, 0, text.stderr);
    assert.doesNotMatch(text.stdout, /child workflow/);
    assert.strictEqual(
      scriptHeaderBeforeMarker(text.stdout, "parent"),
      "│ [Script step] parent-script"
    );
    assert.strictEqual(
      scriptHeaderBeforeMarker(text.stdout, "child"),
      "│ [Script step] [Child] child-script"
    );
    assert.strictEqual(
      scriptHeaderBeforeMarker(text.stdout, "leaf"),
      "│ [Script step] [grandchild] leaf-script"
    );
    assert.strictEqual(
      scriptHeaderBeforeMarker(text.stdout, "after"),
      "│ [Script step] [Child] after-script"
    );
    assert.strictEqual(countMatches(text.stdout, /Workflow completed/g), 1);
    assert.strictEqual(countMatches(text.stdout, /^Run ID: /gm), 1);

    const json = await runCli(
      ["run", parent, "--headless", "--json", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(json.code, 0, json.stderr);
    const result = JSON.parse(json.stdout) as CliJsonWithChildren;
    assert.strictEqual(result.subWorkflowRuns.length, 1);
    assert.strictEqual(result.subWorkflowRuns[0]?.status, "completed");
    assert.ok(result.subWorkflowRuns[0]?.workflowKey);
    assert.ok(result.subWorkflowRuns[0]?.runRef);
    assert.ok(result.subWorkflowRuns[0]?.stepId);
  });

  test("--var overrides a file child's own vars, nested children too, and inline children inherit it (D11)", async function () {
    this.timeout(CLI_RUN_TIMEOUT_MS);
    const root = await makeRoot("ctrlyoke-cli-vars-");
    const env = { CTRLYOKE_HOME: path.join(root, "state") };
    // The grandchild does not declare `extra`, which only the command line sets.
    await writeWorkflow(root, "grandchild.ctrlyoke.json", {
      vars: { name: "grandchild-default" },
      steps: [{ type: "script", script: varScript("grandchild") }],
    });
    await writeWorkflow(root, "child.ctrlyoke.json", {
      vars: { name: "child-default" },
      steps: [
        { type: "script", script: varScript("child") },
        { type: "workflow", workflow: "grandchild.ctrlyoke.json" },
        {
          type: "workflow",
          workflow: { type: "script", script: varScript("inline") },
        },
      ],
    });
    const parent = await writeWorkflow(root, "parent.ctrlyoke.json", {
      vars: { name: "parent-default" },
      steps: [
        { type: "script", script: varScript("parent") },
        { type: "workflow", workflow: "child.ctrlyoke.json" },
      ],
    });

    const defaults = await runCli(
      ["run", parent, "--headless", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(defaults.code, 0, defaults.stderr);
    assert.deepStrictEqual(varLines(defaults.stdout), [
      "parent=parent-default",
      "child=child-default",
      "grandchild=grandchild-default",
      "inline=child-default",
    ]);

    const overridden = await runCli(
      ["run", parent, "--headless", "--cwd", root, "--var", "name=x"],
      root,
      env
    );
    assert.strictEqual(overridden.code, 0, overridden.stderr);
    assert.deepStrictEqual(varLines(overridden.stdout), [
      "parent=x",
      "child=x",
      "grandchild=x",
      "inline=x",
    ]);

    // A name no child declares is accepted, as it is for the root: no error,
    // and no per-child "unused" warning (the root warns once for the run).
    const undeclared = await runCli(
      ["run", parent, "--headless", "--cwd", root, "--var", "extra=y"],
      root,
      env
    );
    assert.strictEqual(undeclared.code, 0, undeclared.stderr);
    assert.strictEqual(
      countMatches(undeclared.stderr, /--var extra=\.\.\. is unused/g),
      1
    );
  });

  test("does not warn about a --var only a file child references, however it is reached", async function () {
    this.timeout(CLI_RUN_TIMEOUT_MS);
    const root = await makeRoot("ctrlyoke-cli-var-warning-");
    const env = {
      CTRLYOKE_HOME: path.join(root, "state"),
      FORCE_COLOR: "0",
    };
    const placeholder = (name: string) =>
      `node -e "console.log('USES:{{${name}}}')"`;
    const unused = (stderr: string, name: string) =>
      countMatches(
        stderr,
        new RegExp(`--var ${name}=\\.\\.\\. is unused`, "g")
      );
    // `deep` is referenced only by a grandchild; the grandchild also names
    // its own parent, so the walk must not loop.
    await writeWorkflow(root, "grandchild.ctrlyoke.json", {
      steps: [
        { type: "script", script: placeholder("deep") },
        { type: "workflow", workflow: "child.ctrlyoke.json" },
      ],
    });
    await writeWorkflow(root, "child.ctrlyoke.json", {
      steps: [
        { type: "script", script: placeholder("child") },
        { type: "workflow", workflow: "grandchild.ctrlyoke.json" },
      ],
    });
    await writeWorkflow(root, "member.ctrlyoke.json", {
      steps: [{ type: "script", script: placeholder("member") }],
    });
    await writeWorkflow(root, "last.ctrlyoke.json", {
      steps: [{ type: "script", script: placeholder("last") }],
    });
    // An unparseable child is skipped silently by the warning.
    await fs.writeFile(
      path.join(root, "broken.ctrlyoke.json"),
      "{ nope",
      "utf8"
    );
    const parent = await writeWorkflow(root, "parent.ctrlyoke.json", {
      steps: [
        {
          type: "workflow",
          workflow: "child.ctrlyoke.json",
          onFail: "continue",
        },
        {
          parallel: [
            { type: "workflow", workflow: "member.ctrlyoke.json" },
            {
              type: "workflow",
              workflow: { type: "script", script: placeholder("inline") },
            },
          ],
        },
        {
          type: "workflow",
          workflow: "broken.ctrlyoke.json",
          onFail: "continue",
        },
      ],
      finalStep: { type: "workflow", workflow: "last.ctrlyoke.json" },
    });

    const run = await runCli(
      [
        "run",
        parent,
        "--headless",
        "--cwd",
        root,
        "--var",
        "child=1",
        "--var",
        "deep=2",
        "--var",
        "member=3",
        "--var",
        "inline=4",
        "--var",
        "last=5",
        "--var",
        "nobody=6",
      ],
      root,
      env
    );

    for (const name of ["child", "deep", "member", "inline", "last"]) {
      assert.strictEqual(unused(run.stderr, name), 0, run.stderr);
    }
    assert.strictEqual(unused(run.stderr, "nobody"), 1, run.stderr);
  });

  test("a parallel group of two inline lanes builds and completes both child runs", async function () {
    this.timeout(CLI_RUN_TIMEOUT_MS);
    const root = await makeRoot("ctrlyoke-cli-lanes-");
    const env = { CTRLYOKE_HOME: path.join(root, "state") };
    const laneMarker = (lane: string) => path.join(root, `lane-${lane}.txt`);
    const lane = (name: string, marker: string) => ({
      type: "workflow",
      name,
      workflow: { type: "script", script: writeMarkerScript(marker) },
    });
    const parent = await writeWorkflow(root, "lanes.ctrlyoke.json", {
      name: "Lanes",
      steps: [
        {
          parallel: [
            lane("Lane A", laneMarker("a")),
            lane("Lane B", laneMarker("b")),
          ],
        },
      ],
    });

    const run = await runCli(
      ["run", parent, "--headless", "--json", "--cwd", root],
      root,
      env
    );

    assert.strictEqual(run.code, 0, run.stderr);
    // Each lane ran its own script, in its own child.
    assert.strictEqual(await fs.readFile(laneMarker("a"), "utf8"), "ran");
    assert.strictEqual(await fs.readFile(laneMarker("b"), "utf8"), "ran");
    const result = JSON.parse(run.stdout) as CliJsonWithChildren;
    assert.deepStrictEqual(
      result.subWorkflowRuns.map((child) => child.status),
      ["completed", "completed"]
    );
    assert.strictEqual(
      new Set(result.subWorkflowRuns.map((child) => child.runRef)).size,
      2,
      "each lane has its own child run"
    );
    for (const child of result.subWorkflowRuns) {
      assert.ok(child.workflowKey);
      assert.ok(child.stepId);
    }
  });

  test("reports a child's prompt headers and final-step pass label under its prefix", async function () {
    this.timeout(CLI_RUN_TIMEOUT_MS);
    const root = await makeRoot("ctrlyoke-cli-child-final-");
    const env = await fakeCopilotEnv(root);
    // D11: harness is not inherited, so the child names the fake harness.
    await writeWorkflow(root, "kid.ctrlyoke.json", {
      name: "Kid",
      harness: "copilot-cli",
      model: "gpt-5",
      steps: [{ name: "kid-prompt", prompt: "say hi" }],
      finalStep: {
        type: "script",
        name: "kid-final",
        script: markerScript("kid-final"),
      },
    });
    const parent = await writeWorkflow(root, "parent.ctrlyoke.json", {
      steps: [{ type: "workflow", workflow: "kid.ctrlyoke.json" }],
    });

    const run = await runCli(
      ["run", parent, "--headless", "--cwd", root],
      root,
      env
    );

    assert.strictEqual(run.code, 0, run.stderr);
    const lines = run.stdout.split(/\r?\n/);
    const header = lines.indexOf("│ Step 1/1 — [Kid] kid-prompt");
    assert.ok(header >= 0, run.stdout);
    assert.deepStrictEqual(lines.slice(header + 1, header + 3), [
      "│ Harness: copilot-cli",
      "│ Model: gpt-5",
    ]);
    assert.ok(lines.includes("│ [Kid] Final Step Pass 1"), run.stdout);
    assert.strictEqual(
      scriptHeaderBeforeMarker(run.stdout, "kid-final"),
      "│ [Script step] [Kid] kid-final"
    );
    assert.strictEqual(countMatches(run.stdout, /Final Step Pass/g), 1);
  });
});

interface CliJsonWithChildren {
  subWorkflowRuns: Array<{
    stepId?: string;
    workflowKey: string;
    runRef: string;
    status: string | null;
  }>;
}

/** The root's output before child reporting was single-sourced. */
const ROOT_GOLDEN_OUTPUT = [
  "ctrlyoke CLI v<version>",
  "━".repeat(52),
  "",
  "Running: root.ctrlyoke.json",
  "Harness: copilot-cli (gpt-5)",
  "─".repeat(52),
  "",
  "─".repeat(52),
  "│ Step 1/2 — ask",
  "│ Harness: copilot-cli",
  "│ Model: gpt-5",
  "│ hello",
  "",
  "│ <cwd>> <command>",
  "",
  "",
  "Session (copilot-cli): fake-session | <t>s",
  "│ [Script step] first",
  "│ <cwd>> <command>",
  "",
  "│ Script step output:",
  "first-marker",
  "",
  "<t>s",
  ...passedVerdict(),
  "",
  "",
  "│ Final Step Pass 1",
  "│ [Script step] wrap",
  "│ <cwd>> <command>",
  "",
  "│ Script step output:",
  "wrap-marker",
  "",
  "<t>s",
  ...passedVerdict(),
  "",
  "",
  "━".repeat(52),
  "✓ Workflow completed successfully",
  "Run ID: <run>",
  "",
].join("\n");

function passedVerdict(): string[] {
  return [
    "│ ✔ Passed — Script step passed (exit code == 0) → continue",
    "│   Compare: exit code == 0",
    "│   Expected: 0",
    "│   Actual: 0",
    "│   Result: Passed",
    "│   Action: continue",
    "│   Exit code: 0",
    "│   Duration: <t>s",
    "│   Timed out: no",
  ];
}

/** Masks what varies between runs and hosts: timings, ids, paths, commands. */
function normalizeOutput(stdout: string, root: string): string {
  return stdout
    .replace(/\r\n/g, "\n")
    .replace(/^ctrlyoke CLI v\S+$/m, "ctrlyoke CLI v<version>")
    .replace(/^Run ID: \S+$/gm, "Run ID: <run>")
    .split("\n")
    .map((line) =>
      line.startsWith("│ ") && line.includes(path.basename(root) + ">")
        ? "│ <cwd>> <command>"
        : line
    )
    .join("\n")
    .replace(/\b\d+(?:\.\d+)?s\b/g, "<t>s");
}

/** The nearest script-step header above a marker's output line. */
function scriptHeaderBeforeMarker(stdout: string, marker: string): string {
  const lines = stdout.split(/\r?\n/);
  const markerLine = lines.indexOf(`${marker}-marker`);
  assert.ok(markerLine >= 0, `missing ${marker}-marker in:\n${stdout}`);
  for (let index = markerLine; index >= 0; index -= 1) {
    if (lines[index].startsWith("│ [Script step] ")) return lines[index];
  }
  assert.fail(`no script header above ${marker}-marker`);
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Prints `<label>=<value of {{name}}>`, substituted by the run. */
function varScript(label: string): string {
  return `node -e "console.log('VAR:${label}={{name}}')"`;
}

function varLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("VAR:"))
    .map((line) => line.slice("VAR:".length));
}

/** Writes `ran` to `marker`, so a test can prove the script executed. */
function writeMarkerScript(marker: string): string {
  return `node -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}`;
}

function markerScript(marker: string): string {
  return `node -e "console.log('${marker}-marker')"`;
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** A `copilot` on PATH that answers one turn without a real harness. */
async function fakeCopilotEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const result = '{"type":"result","sessionId":"fake-session","content":"ok"}';
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(bin, "copilot.cmd"),
      `@echo off\r\nif /i "%~1"=="--version" (echo fake version&exit /b 0)\r\necho ${result}\r\nexit /b 0\r\n`,
      "utf8"
    );
  } else {
    const script = path.join(bin, "copilot");
    await fs.writeFile(
      script,
      `#!/bin/sh\ncase "$1" in --version) echo 'fake version';; *) echo '${result}';; esac\nexit 0\n`,
      "utf8"
    );
    await fs.chmod(script, 0o755);
  }
  return {
    CTRLYOKE_HOME: path.join(root, "state"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

async function writeWorkflow(
  root: string,
  filename: string,
  workflow: Record<string, unknown>
): Promise<string> {
  const file = path.join(root, filename);
  await fs.writeFile(file, JSON.stringify(workflow), "utf8");
  return file;
}
