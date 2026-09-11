import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import {
  EndConditionEvaluator,
  EvaluationResult,
} from "../core/EndConditionEvaluator";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";

const childProcess = require("child_process") as typeof import("child_process");

class TestableEndConditionEvaluator extends EndConditionEvaluator {
  commandFor(
    scriptPath: string
  ): { executable: string; args: string[] } | null {
    return this.getScriptCommand(scriptPath);
  }
}

suite("EndConditionEvaluator Tests", () => {
  let evaluator: TestableEndConditionEvaluator;
  let workspaceRoot: string;
  const originalPlatform = process.platform;

  setup(() => {
    // Create a minimal mock PlatformAdapter for testing
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-evaluator-")
    );
    const mockPlatform: PlatformAdapter = {
      getWorkspaceRoot: () => workspaceRoot,
      getWorkspaceRoots: () => (workspaceRoot ? [workspaceRoot] : []),
      getNamedWorkspaceRoots: () => [],
      getExtensionPath: () => "",
    };

    evaluator = new TestableEndConditionEvaluator(mockPlatform);
  });

  teardown(() => {
    evaluator.dispose();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  suite("parseScriptCommand - Tokenization", () => {
    test("splits simple space-separated command", () => {
      const { scriptPath, args } = EndConditionEvaluator.parseScriptCommand(
        ".ctrlyoke/scripts/check.py 5"
      );
      assert.strictEqual(scriptPath, ".ctrlyoke/scripts/check.py");
      assert.deepStrictEqual(args, ["5"]);
    });

    test("strips surrounding double quotes from path and args", () => {
      const { scriptPath, args } = EndConditionEvaluator.parseScriptCommand(
        'node "C:\\dir\\check.js" "C:\\dir\\out.txt" 2'
      );
      assert.strictEqual(scriptPath, "node");
      assert.deepStrictEqual(args, [
        "C:\\dir\\check.js",
        "C:\\dir\\out.txt",
        "2",
      ]);
    });

    test("preserves spaces inside quoted spans", () => {
      const { scriptPath, args } = EndConditionEvaluator.parseScriptCommand(
        'node "C:\\my dir\\check.js" "arg with spaces"'
      );
      assert.strictEqual(scriptPath, "node");
      assert.deepStrictEqual(args, ["C:\\my dir\\check.js", "arg with spaces"]);
    });

    test("does not treat backslashes as escapes (Windows paths)", () => {
      const { scriptPath } = EndConditionEvaluator.parseScriptCommand(
        '"C:\\Users\\me\\scripts\\check.js"'
      );
      assert.strictEqual(scriptPath, "C:\\Users\\me\\scripts\\check.js");
    });

    test("supports single quotes", () => {
      const { scriptPath, args } = EndConditionEvaluator.parseScriptCommand(
        "node 'with space.js' plain"
      );
      assert.strictEqual(scriptPath, "node");
      assert.deepStrictEqual(args, ["with space.js", "plain"]);
    });

    test("concatenates adjacent quoted and bare runs in one token", () => {
      const { scriptPath, args } = EndConditionEvaluator.parseScriptCommand(
        'check.py --path="a b" --flag'
      );
      assert.strictEqual(scriptPath, "check.py");
      assert.deepStrictEqual(args, ["--path=a b", "--flag"]);
    });

    test("keeps an empty quoted argument", () => {
      const { scriptPath, args } =
        EndConditionEvaluator.parseScriptCommand('node check.js ""');
      assert.strictEqual(scriptPath, "node");
      assert.deepStrictEqual(args, ["check.js", ""]);
    });

    test("returns empty scriptPath for empty input", () => {
      const { scriptPath, args } =
        EndConditionEvaluator.parseScriptCommand("   ");
      assert.strictEqual(scriptPath, "");
      assert.deepStrictEqual(args, []);
    });
  });

  suite("getScriptCommand - File Dispatch", () => {
    const scriptPath = path.join("workspace", "check");
    const extensions = [
      ".py",
      ".js",
      ".mjs",
      ".cjs",
      ".ts",
      ".sh",
      ".bat",
      ".cmd",
      ".ps1",
    ] as const;

    // `process.platform` is process-wide state. Without restoring it, every
    // later test in this run sees the last value set here (linux), so Windows
    // hosts silently exercise POSIX branches — including direct execution of
    // files the platform cannot actually run.
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, "platform", {
        value: platform,
        configurable: true,
      });
    }

    teardown(() => {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    });

    test("caches Python resolution per platform", () => {
      const originalExecSyncDescriptor = Object.getOwnPropertyDescriptor(
        childProcess,
        "execSync"
      );
      const probes: string[] = [];
      Object.defineProperty(childProcess, "execSync", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (command: string) => {
          probes.push(command);
          return Buffer.from("");
        },
      });

      try {
        setPlatform("linux");
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.py`)?.executable,
          "python3"
        );
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.py`)?.executable,
          "python3"
        );

        setPlatform("win32");
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.py`)?.executable,
          "python"
        );
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.py`)?.executable,
          "python"
        );

        setPlatform("linux");
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.py`)?.executable,
          "python3"
        );
        assert.deepStrictEqual(probes, ["python3 --version"]);
      } finally {
        if (originalExecSyncDescriptor) {
          Object.defineProperty(
            childProcess,
            "execSync",
            originalExecSyncDescriptor
          );
        }
      }
    });

    test("caches PowerShell resolution per platform", () => {
      const originalExecSyncDescriptor = Object.getOwnPropertyDescriptor(
        childProcess,
        "execSync"
      );
      const probes: string[] = [];
      Object.defineProperty(childProcess, "execSync", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (command: string) => {
          probes.push(command);
          return Buffer.from("");
        },
      });

      try {
        setPlatform("win32");
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.ps1`)?.executable,
          "pwsh"
        );
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.ps1`)?.executable,
          "pwsh"
        );

        setPlatform("linux");
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.ps1`)?.executable,
          "pwsh"
        );

        setPlatform("win32");
        assert.strictEqual(
          evaluator.commandFor(`${scriptPath}.ps1`)?.executable,
          "pwsh"
        );
        assert.deepStrictEqual(probes, ["pwsh -Version"]);
      } finally {
        if (originalExecSyncDescriptor) {
          Object.defineProperty(
            childProcess,
            "execSync",
            originalExecSyncDescriptor
          );
        }
      }
    });

    for (const platform of ["win32", "linux"] as const) {
      test(`routes every supported extension on ${platform}`, () => {
        setPlatform(platform);

        for (const extension of extensions) {
          const command = evaluator.commandFor(`${scriptPath}${extension}`);

          if (extension === ".bat" || extension === ".cmd") {
            if (platform === "win32") {
              assert.ok(command);
              assert.strictEqual(command.executable, "cmd");
              assert.deepStrictEqual(command.args, [
                "/c",
                `${scriptPath}${extension}`,
              ]);
            } else {
              assert.strictEqual(command, null);
            }
            continue;
          }

          assert.ok(command, extension);
          switch (extension) {
            case ".py":
              assert.ok(
                platform === "win32"
                  ? command.executable === "python"
                  : command.executable === "python" ||
                      command.executable === "python3"
              );
              break;
            case ".js":
            case ".mjs":
            case ".cjs":
              assert.strictEqual(command.executable, "node");
              break;
            case ".ts":
              assert.strictEqual(command.executable, "node");
              assert.deepStrictEqual(command.args, [
                "--experimental-strip-types",
                `${scriptPath}${extension}`,
              ]);
              break;
            case ".sh":
              assert.strictEqual(
                command.executable,
                platform === "win32" ? "bash" : "sh"
              );
              break;
            case ".ps1":
              assert.ok(
                platform === "win32"
                  ? command.executable === "pwsh" ||
                      command.executable === "powershell.exe"
                  : command.executable === "pwsh"
              );
              assert.deepStrictEqual(command.args, [
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                `${scriptPath}${extension}`,
              ]);
              break;
          }
          assert.deepStrictEqual(command.args, [
            ...(extension === ".ps1"
              ? ["-ExecutionPolicy", "Bypass", "-File"]
              : extension === ".ts"
                ? ["--experimental-strip-types"]
                : []),
            `${scriptPath}${extension}`,
          ]);
        }
      });
    }

    test("executes an executable file directly", () => {
      setPlatform("win32");
      const executablePath = path.join(workspaceRoot, "tool.exe");
      fs.writeFileSync(executablePath, "not a real executable", "utf8");

      const command = evaluator.commandFor(executablePath);
      assert.deepStrictEqual(command, {
        executable: executablePath,
        args: [],
      });
    });

    test("rejects unsupported non-executable files on every platform", () => {
      const unsupportedPath = path.join(workspaceRoot, "data.txt");
      fs.writeFileSync(unsupportedPath, "not executable", "utf8");

      for (const platform of ["win32", "linux"] as const) {
        setPlatform(platform);
        assert.strictEqual(evaluator.commandFor(unsupportedPath), null);
      }
    });

    type ShebangCase = {
      name: string;
      line: string | null;
      expectedExecutable: string | null;
      /** Override for win32 when the resolved executable legitimately
       * differs by platform (e.g. POSIX shells fall back to "bash" on
       * Windows, since Windows has no standalone sh/dash/zsh). */
      win32Executable?: string;
      /** Use when either of several executables is an acceptable resolution
       * (e.g. the interpreter probes may resolve to either binary). */
      expectedExecutableChoices?: readonly string[];
    };

    const shebangCases: ShebangCase[] = [
      {
        name: "sh",
        line: "#!/bin/sh",
        expectedExecutable: "sh",
        win32Executable: "bash",
      },
      { name: "bash", line: "#!/bin/bash", expectedExecutable: "bash" },
      {
        name: "dash preserves interpreter identity",
        line: "#!/bin/dash",
        expectedExecutable: "dash",
        win32Executable: "bash",
      },
      {
        name: "python3 through env",
        line: "#!/usr/bin/env python3",
        expectedExecutable: null,
        expectedExecutableChoices: ["python", "python3"],
      },
      {
        name: "node through env",
        line: "#!/usr/bin/env node",
        expectedExecutable: "node",
      },
      {
        name: "extra arguments",
        line: "#!/usr/bin/env node --experimental-modules",
        expectedExecutable: "node",
      },
      {
        name: "pwsh through env routes through the PowerShell resolver",
        line: "#!/usr/bin/env pwsh",
        expectedExecutable: null,
        expectedExecutableChoices: ["pwsh", "powershell.exe"],
      },
      { name: "no shebang", line: "echo no shebang", expectedExecutable: null },
      { name: "unparseable shebang", line: "#!", expectedExecutable: null },
      {
        name: "env -S shebang",
        line: "#!/usr/bin/env -S node --flag",
        expectedExecutable: null,
      },
      {
        name: "unsupported interpreter",
        line: "#!/usr/bin/not-an-interpreter",
        expectedExecutable: null,
      },
      { name: "unreadable file", line: null, expectedExecutable: null },
    ];

    for (const platform of ["win32", "linux"] as const) {
      for (const shebangCase of shebangCases) {
        test(`resolves ${shebangCase.name} shebang on ${platform}`, () => {
          setPlatform(platform);
          const scriptPath = path.join(
            workspaceRoot,
            `${shebangCase.name.replace(/\s+/g, "-")}-${platform}`
          );
          if (shebangCase.line !== null) {
            fs.writeFileSync(
              scriptPath,
              `${shebangCase.line}\necho body`,
              "utf8"
            );
          }

          const command = evaluator.commandFor(scriptPath);
          const isNullCase =
            shebangCase.expectedExecutable === null &&
            !shebangCase.expectedExecutableChoices;
          if (isNullCase) {
            assert.strictEqual(command, null);
            return;
          }

          assert.ok(command);
          const choices =
            shebangCase.expectedExecutableChoices ??
            (platform === "win32" && shebangCase.win32Executable !== undefined
              ? [shebangCase.win32Executable]
              : [shebangCase.expectedExecutable as string]);
          assert.ok(
            choices.includes(command.executable),
            `expected one of [${choices.join(", ")}], got "${command.executable}"`
          );
          assert.deepStrictEqual(command.args, [scriptPath]);
        });
      }

      test(`does not read mapped extension files on ${platform}`, () => {
        setPlatform(platform);
        for (const extension of [".py", ".ps1", ".sh"] as const) {
          const command = evaluator.commandFor(
            path.join(workspaceRoot, `does-not-exist${extension}`)
          );
          assert.ok(command, extension);
        }
      });
    }
  });

  suite("evaluateCondition - Integration", () => {
    // These tests require actual script execution, so they're more integration-style
    // but test core behavior

    test("should handle nonexistent script as direct command", async () => {
      // When a script doesn't exist, it's treated as a direct command
      const condition = {
        script: "echo hello",
        returns: "hello",
        timeout: 5000,
      };

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        // Skip test if no workspace folder
        return;
      }

      const result = await evaluator.evaluateCondition(
        condition,
        workspaceFolder.uri.fsPath
      );

      // Should execute successfully (echo is a valid command)
      assert.ok(result.duration > 0);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.errored, false);
      assert.strictEqual(result.matchRule, "exact");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("uses an inline shell override for a direct command", async () => {
      const originalGetTerminalSettings =
        ConfigurationUtils.getTerminalSettings;
      ConfigurationUtils.getTerminalSettings = () => ({
        ...originalGetTerminalSettings(),
        shellExecutable:
          process.platform === "win32"
            ? "missing-shell-for-override-test.exe"
            : "/missing-shell-for-override-test",
      });

      try {
        const windows = process.platform === "win32";
        const result = await evaluator.evaluateCondition(
          {
            script: windows ? "echo shell-override" : "printf shell-override",
            returns: "shell-override",
            shell: windows ? "cmd.exe" : "/bin/sh",
          },
          workspaceRoot
        );

        assert.strictEqual(result.passed, true);
        assert.strictEqual(result.errored, false);
      } finally {
        ConfigurationUtils.getTerminalSettings = originalGetTerminalSettings;
      }
    });

    test("preserves direct-command behavior when shell is omitted", async () => {
      const originalGetTerminalSettings =
        ConfigurationUtils.getTerminalSettings;
      ConfigurationUtils.getTerminalSettings = () => ({
        ...originalGetTerminalSettings(),
        shellExecutable: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      });

      try {
        const result = await evaluator.evaluateCondition(
          {
            script:
              process.platform === "win32"
                ? "echo no-shell-override"
                : "printf no-shell-override",
            returns: "no-shell-override",
          },
          workspaceRoot
        );

        assert.strictEqual(result.passed, true);
        assert.strictEqual(result.errored, false);
      } finally {
        ConfigurationUtils.getTerminalSettings = originalGetTerminalSettings;
      }
    });

    // Asserted on the routing decision rather than by executing these shapes.
    // Running them would make the resolved shell invoke `package.json` /
    // `setup.sh` directly, and Windows answers that with the modal "How do you
    // want to open this file?" association dialog — which hangs the suite until
    // a human dismisses it and leaves the temp workspace locked (EPERM) on
    // teardown. Multi-line *execution* is covered separately with commands that
    // are safe to run.
    test("treats package.json and setup.sh newline shapes as inline scripts", () => {
      for (const script of [
        'package.json\nnode -e "process.exit(7)"',
        'scripts/setup.sh\nnode -e "process.exit(7)"',
        "package.json\r\nnpm test",
      ]) {
        assert.strictEqual(
          EndConditionEvaluator.isMultilineInlineScript(script),
          true,
          script
        );
      }
    });

    test("keeps a single line, or a first line padded with blanks, on the file route", () => {
      for (const script of [
        "args.js expected-argument",
        "package.json",
        "scripts/setup.sh\n",
        "scripts/setup.sh\n   \n\n",
      ]) {
        assert.strictEqual(
          EndConditionEvaluator.isMultilineInlineScript(script),
          false,
          script
        );
      }
    });

    test("keeps single-line file paths with arguments on the file route", async () => {
      fs.writeFileSync(
        path.join(workspaceRoot, "args.js"),
        "process.stdout.write(process.argv[2] ?? '')",
        "utf8"
      );

      const result = await evaluator.evaluateCondition(
        {
          script: "args.js expected-argument",
          compareSource: "stdout",
          returns: "expected-argument",
        },
        workspaceRoot
      );

      assert.strictEqual(result.errored, false);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.actual, "expected-argument");
    });

    test("runs a multiline inline script and compares its last command exit code", async () => {
      const result = await evaluator.evaluateCondition(
        {
          script: 'echo first\nnode -e "process.exit(7)"',
          compareSource: "exitCode",
          returns: "7",
          shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
        },
        workspaceRoot
      );

      assert.strictEqual(result.errored, false);
      assert.strictEqual(result.exitCode, 7);
      assert.strictEqual(result.passed, true);
    });

    test("rejects a multiline script under cmd before execution", async () => {
      const result = await evaluator.evaluateCondition(
        {
          script: "echo first\necho last",
          shell: "cmd",
        },
        workspaceRoot
      );

      assert.strictEqual(result.errored, true);
      assert.strictEqual(
        result.error,
        "Multi-line scripts cannot run under cmd. Set this script's `shell` field to a shell that supports multi-line scripts, for example `shell: pwsh`."
      );
    });

    test("should return timeout result when script takes too long", async function () {
      this.timeout(10000); // Extend mocha timeout

      // Use a command that sleeps
      const condition = {
        script:
          process.platform === "win32" ? "ping -n 10 localhost" : "sleep 5",
        returns: "true",
        timeout: 100, // Very short timeout
      };

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const result = await evaluator.evaluateCondition(
        condition,
        workspaceFolder.uri.fsPath
      );

      assert.strictEqual(result.timeout, true);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.errored, true);
    }).timeout(10000);

    test("should report correct duration", async () => {
      const condition = {
        script: process.platform === "win32" ? "echo test" : "echo test",
        returns: "test",
        timeout: 5000,
      };

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const startTime = Date.now();
      const result = await evaluator.evaluateCondition(
        condition,
        workspaceFolder.uri.fsPath
      );
      const actualDuration = Date.now() - startTime;

      // Duration should be reasonable (within 1 second of actual)
      assert.ok(result.duration >= 0);
      assert.ok(Math.abs(result.duration - actualDuration) < 1000);
    });

    test("uses the execution root for cwd and script security", async () => {
      const executionRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "ctrlyoke-execution-root-")
      );
      const executionScript = path.join(executionRoot, "condition.js");
      const stateScript = path.join(workspaceRoot, "state-condition.js");
      const executionWorkspace: ExecutionWorkspace = {
        stateRoot: workspaceRoot,
        executionRoot,
        workspaceRoots: [executionRoot],
        namedWorkspaceRoots: [],
        approvedExternalRoots: [],
      };
      const executionEvaluator = new EndConditionEvaluator(
        {
          getWorkspaceRoot: () => workspaceRoot,
          getWorkspaceRoots: () => [workspaceRoot],
          getNamedWorkspaceRoots: () => [],
          getExtensionPath: () => "",
        },
        executionWorkspace
      );

      fs.writeFileSync(
        executionScript,
        "console.log(process.cwd().toLowerCase())",
        "utf8"
      );
      fs.writeFileSync(stateScript, "console.log('state')", "utf8");

      try {
        const fromExecution = await executionEvaluator.evaluateCondition({
          script: "condition.js",
          returns: path.resolve(executionRoot).toLowerCase(),
          compareSource: "stdout",
        });
        assert.strictEqual(fromExecution.passed, true);

        const fromState = await executionEvaluator.evaluateCondition({
          script: stateScript,
        });
        assert.strictEqual(fromState.errored, true);
        assert.match(fromState.error ?? "", /Security:/);
      } finally {
        executionEvaluator.dispose();
        fs.rmSync(executionRoot, { recursive: true, force: true });
        fs.rmSync(stateScript, { force: true });
      }
    });
  });

  suite("Script Validation", () => {
    test("should validate existing script", async () => {
      // This test needs an actual script file
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      // Test with a nonexistent script
      const result = await evaluator.validateScript(
        "/nonexistent/path/script.py"
      );
      assert.strictEqual(result.valid, false);
    });

    test("should reject unsupported script types", async () => {
      const scriptPath = path.join(workspaceRoot, "unsupported.txt");
      fs.writeFileSync(scriptPath, "not executable", "utf8");

      const result = await evaluator.validateScript(scriptPath);
      assert.deepStrictEqual(result, {
        valid: false,
        error: "Unsupported script type",
      });
    });
  });

  suite("checkResult - Result Matching (tested via evaluateCondition)", () => {
    // Since checkResult is private, we test it indirectly through evaluateCondition
    // These tests verify the matching logic by checking the success field

    test("should match exact string output", async () => {
      const condition = {
        script: process.platform === "win32" ? "echo hello" : "echo hello",
        returns: "hello",
        timeout: 5000,
      };

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const result = await evaluator.evaluateCondition(
        condition,
        workspaceFolder.uri.fsPath
      );

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "exact");
      assert.strictEqual(result.actual, "hello");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("should match boolean interpretation (1 for true)", async () => {
      const condition = {
        script: process.platform === "win32" ? "echo 1" : "echo 1",
        returns: "true",
        timeout: 5000,
      };

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const result = await evaluator.evaluateCondition(
        condition,
        workspaceFolder.uri.fsPath
      );

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "boolean");
      assert.strictEqual(result.actual, "1");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("should match substring in output", async () => {
      const condition = {
        script:
          process.platform === "win32"
            ? 'echo "This contains expected text"'
            : 'echo "This contains expected text"',
        returns: "expected",
        timeout: 5000,
      };

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const result = await evaluator.evaluateCondition(
        condition,
        workspaceFolder.uri.fsPath
      );

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "substring");
      assert.strictEqual(result.actualSource, "stdout");
    });
  });

  suite("Structured comparison results", () => {
    async function evaluate(
      condition: Parameters<EndConditionEvaluator["evaluateCondition"]>[0]
    ): Promise<EvaluationResult> {
      return evaluator.evaluateCondition(condition, workspaceRoot);
    }

    test("reports exitCode matching and actual source", async () => {
      const result = await evaluate({
        script: 'node -e "process.exit(3)"',
        returns: "3",
        compareSource: "exitCode",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "exitCode");
      assert.strictEqual(result.actual, "3");
      assert.strictEqual(result.actualSource, "exitCode");
      assert.strictEqual(result.errored, false);
    });

    test("reports exact stdout matching", async () => {
      const result = await evaluate({
        script: "echo exact-output",
        returns: "exact-output",
        compareSource: "stdout",
      });

      assert.strictEqual(result.matchRule, "exact");
      assert.strictEqual(result.actual, "exact-output");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("reports boolean stdout matching", async () => {
      const result = await evaluate({
        script: "echo 1",
        returns: "true",
        compareSource: "stdout",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "boolean");
      assert.strictEqual(result.actual, "1");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("reports numericGte stdout matching", async () => {
      const result = await evaluate({
        script: "echo 92",
        returns: "80",
        compareSource: "stdout",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "numericGte");
      assert.strictEqual(result.actual, "92");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("reports substring stdout matching", async () => {
      const result = await evaluate({
        script: "echo all-ok-here",
        returns: "ok",
        compareSource: "stdout",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "substring");
      assert.strictEqual(result.actual, "all-ok-here");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("reports no match when no comparison rule matches", async () => {
      const result = await evaluate({
        script: "echo actual-value",
        returns: "expected-value",
        compareSource: "stdout",
      });

      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.matchRule, "none");
      assert.strictEqual(result.actual, "actual-value");
      assert.strictEqual(result.actualSource, "stdout");
      assert.strictEqual(result.errored, false);
    });

    test("reports stderr as the compared source", async () => {
      const result = await evaluate({
        script: "node -e \"console.error('stderr-value')\"",
        returns: "stderr-value",
        compareSource: "stderr",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "exact");
      assert.strictEqual(result.actual, "stderr-value");
      assert.strictEqual(result.actualSource, "stderr");
    });

    test("resolves auto boolean comparisons to exitCode", async () => {
      const result = await evaluate({
        script: 'node -e "process.exit(0)"',
        returns: "true",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "boolean");
      assert.strictEqual(result.actual, "0");
      assert.strictEqual(result.actualSource, "exitCode");
    });

    test("resolves auto non-boolean comparisons to stdout", async () => {
      const result = await evaluate({
        script: "echo auto-output",
        returns: "auto-output",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "exact");
      assert.strictEqual(result.actual, "auto-output");
      assert.strictEqual(result.actualSource, "stdout");
    });

    test("uses exitCode as the default rule when returns is absent", async () => {
      const result = await evaluate({ script: 'node -e "process.exit(0)"' });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.matchRule, "exitCode");
      assert.strictEqual(result.actual, "0");
      assert.strictEqual(result.actualSource, "exitCode");
    });

    test("does not mark a clean non-zero exit as errored", async () => {
      const result = await evaluate({
        script: 'node -e "process.exit(7)"',
      });

      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.errored, false);
      assert.strictEqual(result.matchRule, "exitCode");
      assert.strictEqual(result.actual, "7");
    });

    test("marks spawn failures as errored", async () => {
      const scriptPath = path.join(workspaceRoot, "spawn-failure-script");
      fs.writeFileSync(scriptPath, "not executable");
      try {
        const result = await evaluate({ script: scriptPath });
        assert.strictEqual(result.passed, false);
        assert.strictEqual(result.errored, true);
        assert.strictEqual(result.matchRule, "none");
      } finally {
        fs.rmSync(scriptPath, { force: true });
      }
    });

    test("marks unsupported script types as errored", async function () {
      const scriptPath = path.join(
        workspaceRoot,
        ".ctrlyoke",
        "unsupported-condition.txt"
      );
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, "unsupported");
      try {
        const result = await evaluate({ script: scriptPath });
        assert.strictEqual(result.passed, false);
        assert.strictEqual(result.errored, true);
        assert.strictEqual(result.matchRule, "none");
        assert.match(result.error ?? "", /Unsupported script type/);
      } finally {
        fs.rmSync(scriptPath, { force: true });
      }
    });

    test("marks security-rejected paths as errored", async () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ctrlyoke-outside-")
      );
      const scriptPath = path.join(outsideDir, "outside.js");
      fs.writeFileSync(scriptPath, "console.log('outside')");
      try {
        const result = await evaluate({ script: scriptPath });
        assert.strictEqual(result.passed, false);
        assert.strictEqual(result.errored, true);
        assert.strictEqual(result.matchRule, "none");
        assert.match(result.error ?? "", /Security:/);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  suite("Process Management", () => {
    test("should kill running processes on dispose", () => {
      // This is a simple test to ensure dispose doesn't throw
      evaluator.dispose();
      // Should not throw
    });

    test("should kill all processes on killAllProcesses()", () => {
      evaluator.killAllProcesses();
      // Should not throw
    });
  });

  suite("isWithinDirectory - Boundary Security", () => {
    test("should accept exact directory match", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(dir, dir),
        true
      );
    });

    test("should accept immediate child path", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      const child = path.join(dir, "scripts", "check.py");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(child, dir),
        true
      );
    });

    test("should accept deeply nested child path", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      const child = path.join(dir, "a", "b", "c", "d.js");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(child, dir),
        true
      );
    });

    test("should reject sibling path sharing same prefix (CVE bypass)", () => {
      // C:\dev\ctrlyoke-evil must NOT pass the check for C:\dev\ctrlyoke
      const workspace = path.join("C:", "dev", "ctrlyoke");
      const sibling = path.join("C:", "dev", "ctrlyoke-evil", "payload.ps1");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(sibling, workspace),
        false
      );
    });

    test("should reject parent directory", () => {
      const workspace = path.join("C:", "dev", "ctrlyoke");
      const parent = path.join("C:", "dev");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(parent, workspace),
        false
      );
    });

    test("should reject root directory", () => {
      const workspace = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(path.sep, workspace),
        false
      );
    });

    test("should reject completely unrelated path", () => {
      const workspace = path.join("C:", "dev", "ctrlyoke");
      const unrelated = path.join("C:", "tmp", "evil.sh");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(unrelated, workspace),
        false
      );
    });

    test("should work with Unix-style paths", () => {
      if (process.platform === "win32") return; // Skip on Windows
      const workspace = "/home/user/project";
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(
          "/home/user/project/scripts/check.py",
          workspace
        ),
        true
      );
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(
          "/home/user/project-evil/hack.sh",
          workspace
        ),
        false
      );
    });
  });

  suite("getUserHomeScriptsDir", () => {
    test("should return a path inside the home directory", () => {
      const dir = EndConditionEvaluator.getUserHomeScriptsDir();
      assert.ok(
        dir.startsWith(os.homedir()),
        `Expected dir to start with home dir "${os.homedir()}", got: "${dir}"`
      );
    });

    test("should end with .ctrlyoke/scripts", () => {
      const dir = EndConditionEvaluator.getUserHomeScriptsDir();
      const expectedSuffix = path.join(".ctrlyoke", "scripts");
      assert.ok(
        dir.endsWith(expectedSuffix),
        `Expected dir to end with "${expectedSuffix}", got: "${dir}"`
      );
    });
  });
});
