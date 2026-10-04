import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

const temporaryRoots: string[] = [];

suite("CLI workflow property overrides", () => {
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

  test("real runs, headers, and dry runs agree on the effective harness", async function () {
    // Six real CLI subprocesses (preview + run per case) need more than the
    // 30-second extension-host default when other test shards are active.
    this.timeout(120000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-property-overrides-")
    );
    temporaryRoots.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    const logPath = path.join(root, "spawned-harness.txt");
    const env = {
      CTRLYOKE_HOME: path.join(root, "state"),
      CTRLYOKE_FAKE_HARNESS_LOG: logPath,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    for (const executable of ["copilot", "opencode"]) {
      if (process.platform === "win32") {
        await fs.writeFile(
          path.join(bin, `${executable}.cmd`),
          `@echo off\r\necho ${executable}>>"%CTRLYOKE_FAKE_HARNESS_LOG%"\r\nif /i "%~1"=="--version" (echo fake version&exit /b 0)\r\necho {"type":"result","sessionId":"fake-session","content":"ok"}\r\nexit /b 0\r\n`,
          "utf8"
        );
      } else {
        const script = path.join(bin, executable);
        await fs.writeFile(
          script,
          `#!/bin/sh\nprintf '%s\\n' '${executable}' >> "$CTRLYOKE_FAKE_HARNESS_LOG"\ncase "$1" in --version) echo 'fake version';; *) echo '{"type":"result","sessionId":"fake-session","content":"ok"}';; esac\nexit 0\n`,
          "utf8"
        );
        await fs.chmod(script, 0o755);
      }
    }

    const cases = [
      {
        name: "workflow harness is replaced",
        definition: { harness: "opencode-cli", steps: [{ prompt: "run" }] },
        expected: "copilot",
      },
      {
        name: "step harness remains more specific",
        definition: { steps: [{ harness: "opencode-cli", prompt: "run" }] },
        expected: "opencode",
      },
      {
        name: "workflow without a harness receives the flag",
        definition: { steps: [{ prompt: "run" }] },
        expected: "copilot",
      },
    ];

    for (const [index, scenario] of cases.entries()) {
      const workflowPath = path.join(root, `workflow-${index}.ctrlyoke.json`);
      await fs.writeFile(workflowPath, JSON.stringify(scenario.definition), "utf8");
      const args = [
        "run",
        workflowPath,
        "--harness",
        "copilot-cli",
        "--headless",
        "--verbose",
        "--cwd",
        root,
      ];

      const preview = await runCli(
        [...args.slice(0, 2), "--dry-run", "--json", ...args.slice(2)],
        root,
        env
      );
      assert.strictEqual(preview.code, 0, `${scenario.name}: ${preview.stderr}`);
      const previewJson = JSON.parse(preview.stdout) as {
        steps: Array<{ resolvedProperties: { harnessId: string } }>;
      };
      assert.strictEqual(
        previewJson.steps[0].resolvedProperties.harnessId,
        `${scenario.expected}-cli`,
        scenario.name
      );

      await fs.rm(logPath, { force: true });
      const result = await runCli(args, root, env);
      assert.strictEqual(result.code, 0, `${scenario.name}: ${result.stderr}`);
      assert.match(
        result.stdout,
        /\[verbose\] Harness: copilot-cli/u,
        `${scenario.name}: workflow-level run header`
      );
      assert.match(
        result.stdout,
        new RegExp(`│ Harness: ${scenario.expected}-cli`),
        scenario.name
      );
      assert.strictEqual(
        (await fs.readFile(logPath, "utf8")).trim(),
        scenario.expected,
        scenario.name
      );
    }
  });

  test("rejects --session-id with --no-resume-session as a usage error", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-session-flag-conflict-")
    );
    temporaryRoots.push(root);
    const result = await runCli(
      [
        "run",
        "--prompt",
        "do the thing",
        "--session-id",
        "literal-session-id",
        "--no-resume-session",
      ],
      root,
      { CTRLYOKE_HOME: path.join(root, "state") }
    );
    assert.strictEqual(result.code, 2);
    assert.match(result.stderr, /--session-id cannot be used with --no-resume-session/u);
  });

  test("--force harness overrides a step-level harness in the real CLI preview", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-force-harness-")
    );
    temporaryRoots.push(root);
    const workflowPath = path.join(root, "workflow.ctrlyoke.json");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        steps: [{ prompt: "run", harness: "opencode-cli" }],
      }),
      "utf8"
    );
    const result = await runCli(
      [
        "run",
        workflowPath,
        "--harness",
        "copilot-cli",
        "--force",
        "harness",
        "--dry-run",
        "--json",
        "--cwd",
        root,
      ],
      root,
      { CTRLYOKE_HOME: path.join(root, "state") }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    const preview = JSON.parse(result.stdout) as {
      steps: Array<{ resolvedProperties: { harnessId: string } }>;
    };
    assert.strictEqual(
      preview.steps[0].resolvedProperties.harnessId,
      "copilot-cli"
    );
  });

  test("a no-TTY interactive request is clamped and reported", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-no-tty-interactive-")
    );
    temporaryRoots.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    if (process.platform === "win32") {
      await fs.writeFile(
        path.join(bin, "copilot.cmd"),
        '@echo off\r\nif /i "%~1"=="--version" (echo fake version&exit /b 0)\r\necho {"type":"result","sessionId":"fake-session","content":"ok"}\r\nexit /b 0\r\n',
        "utf8"
      );
    } else {
      const executable = path.join(bin, "copilot");
      await fs.writeFile(
        executable,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'fake version'; else echo '{\"type\":\"result\",\"sessionId\":\"fake-session\",\"content\":\"ok\"}'; fi\n",
        "utf8"
      );
      await fs.chmod(executable, 0o755);
    }
    const workflowPath = path.join(root, "workflow.ctrlyoke.json");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({ steps: [{ prompt: "run", executionMode: "interactive" }] }),
      "utf8"
    );

    const result = await runCli(
      [
        "run",
        workflowPath,
        "--harness",
        "copilot-cli",
        "--interactive",
        "--verbose",
        "--cwd",
        root,
      ],
      root,
      {
        CTRLYOKE_HOME: path.join(root, "state"),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    const logDir = path.join(root, ".ctrlyoke", "logs");
    const logNames = await fs.readdir(logDir);
    const log = await fs.readFile(
      path.join(logDir, logNames.find((name) => name.startsWith("ctrlyoke-cli-"))!),
      "utf8"
    );
    assert.match(
      log,
      /CLI cannot provide an interactive PTY; downgraded step\(s\) to headless: step 1/u
    );
    assert.match(result.stdout, /Step 1/u);
  });
});
