import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  EndConditionEvaluator,
  EvaluationResult,
} from "../core/EndConditionEvaluator";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { makeTempDir, removeTempDir } from "./helpers/tempWorkspace";

const childProcess = require("child_process") as typeof import("child_process");

class TestableEndConditionEvaluator extends EndConditionEvaluator {
  commandFor(
    scriptPath: string
  ): { executable: string; args: string[] } | null {
    return this.getScriptCommand(scriptPath);
  }

  resolvePathForTest(
    scriptPath: string,
    workingDirectory?: string
  ): Promise<string | null> {
    return this.resolveScriptPath(scriptPath, workingDirectory);
  }
}

suite("EndConditionEvaluator Tests", () => {
  let evaluator: TestableEndConditionEvaluator;
  let workspaceRoot: string;
  const originalPlatform = process.platform;

  setup(() => {
    // Create a minimal mock PlatformAdapter for testing
    workspaceRoot = makeTempDir("ctrlyoke-evaluator-");
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
    removeTempDir(workspaceRoot);
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
    test("ignores directory candidates at every script lookup location", async () => {
      const workingDirectory = path.join(workspaceRoot, "working-directory");
      fs.mkdirSync(workingDirectory);

      const absoluteDirectory = path.join(workspaceRoot, "absolute-candidate");
      fs.mkdirSync(absoluteDirectory);
      assert.strictEqual(
        await evaluator.resolvePathForTest(absoluteDirectory),
        null
      );

      fs.mkdirSync(path.join(workingDirectory, "shared-candidate"));
      const workspaceFile = path.join(workspaceRoot, "shared-candidate");
      fs.writeFileSync(workspaceFile, "script", "utf8");
      assert.strictEqual(
        await evaluator.resolvePathForTest(
          "shared-candidate",
          workingDirectory
        ),
        await fs.promises.realpath(workspaceFile)
      );

      const ctrlyokeDirectory = path.join(workspaceRoot, ".ctrlyoke");
      fs.mkdirSync(ctrlyokeDirectory);
      fs.mkdirSync(path.join(workspaceRoot, "workspace-candidate"));
      const ctrlyokeFile = path.join(ctrlyokeDirectory, "workspace-candidate");
      fs.writeFileSync(ctrlyokeFile, "script", "utf8");
      assert.strictEqual(
        await evaluator.resolvePathForTest("workspace-candidate"),
        await fs.promises.realpath(ctrlyokeFile)
      );

      fs.mkdirSync(path.join(ctrlyokeDirectory, "ctrlyoke-candidate"));
      assert.strictEqual(
        await evaluator.resolvePathForTest("ctrlyoke-candidate"),
        null
      );

      const temporaryHome = fs.mkdtempSync(
        path.join(os.tmpdir(), "ctrlyoke-evaluator-home-")
      );
      const priorHome = process.env.HOME;
      const priorUserProfile = process.env.USERPROFILE;
      try {
        process.env.HOME = temporaryHome;
        process.env.USERPROFILE = temporaryHome;
        const homeScripts = EndConditionEvaluator.getUserHomeScriptsDir();
        fs.mkdirSync(homeScripts, { recursive: true });
        fs.mkdirSync(path.join(homeScripts, "home-candidate"));
        assert.strictEqual(
          await evaluator.resolvePathForTest("home-candidate"),
          null
        );
      } finally {
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
        if (priorUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = priorUserProfile;
        fs.rmSync(temporaryHome, { recursive: true, force: true });
      }
    });

    // These tests require actual script execution, so they're more integration-style
    // but test core behavior

    test("should handle nonexistent script as direct command", async () => {
      // When a script doesn't exist, it's treated as a direct command
      const condition = {
        script: "echo hello",
        compareSource: "stdout" as const,
        expected: "hello",
        timeoutSec: 5,
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
            compareSource: "stdout",
            expected: "shell-override",
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
            compareSource: "stdout",
            expected: "no-shell-override",
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
          expected: "expected-argument",
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
          expected: "7",
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
      // Use a command that sleeps
      const condition = {
        script:
          process.platform === "win32" ? "ping -n 10 localhost" : "sleep 5",
        timeoutSec: 0.1, // Very short timeout
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
        compareSource: "stdout" as const,
        expected: "test",
        timeoutSec: 5,
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
      const executionRoot = makeTempDir("ctrlyoke-execution-root-");
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
          expected: path.resolve(executionRoot).toLowerCase(),
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
        removeTempDir(executionRoot);
        fs.rmSync(stateScript, { force: true });
      }
    });
  });

  suite("checkResult - Result Matching (tested via evaluateCondition)", () => {
    // Since checkResult is private, we test it indirectly through evaluateCondition
    // These tests verify the matching logic by checking the success field

    test("should match exact string output", async () => {
      const condition = {
        script: process.platform === "win32" ? "echo hello" : "echo hello",
        compareSource: "stdout" as const,
        expected: "hello",
        timeoutSec: 5,
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
      assert.strictEqual(result.actual, "hello");
    });

    test("should match an explicit exit code", async () => {
      const condition = {
        script: 'node -e "process.exit(1)"',
        compareSource: "exitCode" as const,
        expected: 1,
        timeoutSec: 5,
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
      assert.strictEqual(result.actual, "1");
    });

    test("should match substring in output", async () => {
      const condition = {
        script:
          process.platform === "win32"
            ? 'echo "This contains expected text"'
            : 'echo "This contains expected text"',
        compareSource: "stdout" as const,
        operator: "contains" as const,
        expected: "expected",
        timeoutSec: 5,
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
    });
  });

  suite("Structured comparison results", () => {
    async function evaluate(
      condition: Parameters<EndConditionEvaluator["evaluateCondition"]>[0]
    ): Promise<EvaluationResult> {
      return evaluator.evaluateCondition(condition, workspaceRoot);
    }

    test("workspace script shell operators run as shell syntax", async () => {
      const isWindows = process.platform === "win32";
      const scriptName = isWindows ? "check.cmd" : "check.sh";
      const scriptPath = path.join(workspaceRoot, scriptName);
      fs.writeFileSync(
        scriptPath,
        isWindows
          ? "@echo off\r\necho CHECK\r\n"
          : "#!/bin/sh\nprintf 'CHECK\\n'\n",
        "utf8"
      );
      if (!isWindows) fs.chmodSync(scriptPath, 0o755);
      const invocation = isWindows
        ? `.${path.sep}${scriptName}`
        : `./${scriptName}`;
      const shell = isWindows ? "cmd" : "sh";
      const command = (tail: string) => `${invocation} ${tail}`;

      const passed = await evaluate({
        script: command(isWindows ? "&& echo SECOND" : "&& printf SECOND"),
        shell,
        compareSource: "stdout",
        expected: isWindows ? "CHECK\r\nSECOND" : "CHECK\nSECOND",
      });
      assert.strictEqual(passed.passed, true, passed.stderr || passed.stdout);

      const failed = await evaluate({
        script: command('&& node -e "process.exit(3)"'),
        shell,
        compareSource: "exitCode",
      });
      assert.strictEqual(failed.passed, false, failed.stderr || failed.stdout);
      assert.strictEqual(failed.exitCode, 3);

      const piped = await evaluate({
        script: command(isWindows ? "| findstr CHECK" : "| grep CHECK"),
        shell,
        compareSource: "stdout",
        expected: "CHECK",
      });
      assert.strictEqual(piped.passed, true, piped.stderr || piped.stdout);
    });

    test("plain workspace script arguments stay on direct argv dispatch", async () => {
      const scriptPath = path.join(workspaceRoot, "argv-check.js");
      fs.writeFileSync(
        scriptPath,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        "utf8"
      );

      const result = await evaluate({
        script: 'argv-check.js arg1 "a b"',
        compareSource: "stdout",
        expected: '["arg1","a b"]',
      });

      assert.strictEqual(result.passed, true, result.stderr || result.stdout);
    });

    test("compares the exit code with eq", async () => {
      const result = await evaluate({
        script: 'node -e "process.exit(3)"',
        compareSource: "exitCode",
        operator: "eq",
        expected: "3",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.actual, "3");
      assert.strictEqual(result.errored, false);
    });

    test("accepts a numeric expected without quoting", async () => {
      const result = await evaluate({
        script: 'node -e "process.exit(3)"',
        compareSource: "exitCode",
        expected: 3,
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.actual, "3");
    });

    test("eq requires the whole trimmed value, not a substring", async () => {
      const matching = await evaluate({
        script: "echo exact-output",
        compareSource: "stdout",
        expected: "exact-output",
      });
      assert.strictEqual(matching.passed, true);
      assert.strictEqual(matching.actual, "exact-output");

      const partial = await evaluate({
        script: "echo all-ok-here",
        compareSource: "stdout",
        operator: "eq",
        expected: "ok",
      });
      assert.strictEqual(partial.passed, false);
    });

    test("contains matches a substring", async () => {
      const result = await evaluate({
        script: "echo all-ok-here",
        compareSource: "stdout",
        operator: "contains",
        expected: "ok",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.actual, "all-ok-here");
    });

    test("ne and notContains invert their comparisons", async () => {
      const ne = await evaluate({
        script: 'node -e "process.exit(1)"',
        compareSource: "exitCode",
        operator: "ne",
        expected: 0,
      });
      assert.strictEqual(ne.passed, true);

      const notContains = await evaluate({
        script: "echo all-ok-here",
        compareSource: "stdout",
        operator: "notContains",
        expected: "failure",
      });
      assert.strictEqual(notContains.passed, true);
    });

    test("gte compares numerically", async () => {
      const above = await evaluate({
        script: "echo 92",
        compareSource: "stdout",
        operator: "gte",
        expected: "80",
      });
      assert.strictEqual(above.passed, true);
      assert.strictEqual(above.actual, "92");

      const below = await evaluate({
        script: "echo 71",
        compareSource: "stdout",
        operator: "gte",
        expected: "80",
      });
      assert.strictEqual(below.passed, false);
    });

    test("a numeric operator fails rather than degrading when the value is not numeric", async () => {
      const result = await evaluate({
        script: "echo none",
        compareSource: "stdout",
        operator: "gte",
        expected: "80",
      });

      assert.strictEqual(result.passed, false);
      assert.strictEqual(
        result.errored,
        false,
        "a wrong-typed operand is a failed comparison, not an internal error"
      );
    });

    test("matches treats expected as an unanchored regex", async () => {
      const unanchored = await evaluate({
        script: `node -e "process.stdout.write('12 passing, 0 failing')"`,
        compareSource: "stdout",
        operator: "matches",
        expected: "\\d+ passing",
      });
      assert.strictEqual(unanchored.passed, true);

      const anchored = await evaluate({
        script: `node -e "process.stdout.write('12 passing, 3 failing')"`,
        compareSource: "stdout",
        operator: "matches",
        expected: "^\\d+ passing, 0 failing$",
      });
      assert.strictEqual(anchored.passed, false);
    });

    test("an invalid regex fails instead of throwing", async () => {
      const result = await evaluate({
        script: "echo anything",
        compareSource: "stdout",
        operator: "matches",
        expected: "([unclosed",
      });

      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.errored, false);
    });

    test("isEmpty and isNotEmpty need no expected value", async () => {
      const empty = await evaluate({
        script: 'node -e "process.exit(0)"',
        compareSource: "stdout",
        operator: "isEmpty",
      });
      assert.strictEqual(empty.passed, true);

      const notEmpty = await evaluate({
        script: "echo something",
        compareSource: "stdout",
        operator: "isNotEmpty",
      });
      assert.strictEqual(notEmpty.passed, true);
    });

    test("string comparisons are case-sensitive unless ignoreCase is set", async () => {
      const sensitive = await evaluate({
        script: "echo PASS",
        compareSource: "stdout",
        expected: "pass",
      });
      assert.strictEqual(sensitive.passed, false);

      const insensitive = await evaluate({
        script: "echo PASS",
        compareSource: "stdout",
        expected: "pass",
        ignoreCase: true,
      });
      assert.strictEqual(insensitive.passed, true);
    });

    test("compares stderr without consulting the exit code", async () => {
      const result = await evaluate({
        script: `node -e "console.error('stderr-value'); process.exit(1)"`,
        compareSource: "stderr",
        expected: "stderr-value",
      });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.actual, "stderr-value");
    });

    test("a stdout comparison no longer requires a clean exit", async () => {
      const result = await evaluate({
        script: `node -e "console.log('done'); process.exit(1)"`,
        compareSource: "stdout",
        expected: "done",
      });

      assert.strictEqual(
        result.passed,
        true,
        "the author asked about stdout, so the exit code is not a hidden second condition"
      );
    });

    test("no expected value means the script must exit 0", async () => {
      const clean = await evaluate({ script: 'node -e "process.exit(0)"' });
      assert.strictEqual(clean.passed, true);
      assert.strictEqual(clean.actual, "0");

      const dirty = await evaluate({ script: 'node -e "process.exit(7)"' });
      assert.strictEqual(dirty.passed, false);
      assert.strictEqual(dirty.errored, false);
      assert.strictEqual(dirty.actual, "7");
    });

    test("'true' is not a magic exit-code value any more", async () => {
      const result = await evaluate({
        script: 'node -e "process.exit(0)"',
        compareSource: "exitCode",
        expected: "true",
      });

      assert.strictEqual(
        result.passed,
        false,
        "exit code 0 does not equal the string 'true' — the boolean translation is gone"
      );
    });

    suite("regressions from the inferred-rule waterfall", () => {
      test("expecting 0 no longer passes on '10 errors' via a numeric >=", async () => {
        const result = await evaluate({
          script: `node -e "process.stdout.write('10 errors')"`,
          compareSource: "stdout",
          expected: 0,
        });

        assert.strictEqual(result.passed, false);
      });

      test("expecting PASS no longer passes on '3 PASSED, 2 FAILED' via a substring", async () => {
        const result = await evaluate({
          script: `node -e "process.stdout.write('3 PASSED, 2 FAILED')"`,
          compareSource: "stdout",
          expected: "PASS",
        });

        assert.strictEqual(result.passed, false);

        const explicit = await evaluate({
          script: `node -e "process.stdout.write('3 PASSED, 2 FAILED')"`,
          compareSource: "stdout",
          operator: "contains",
          expected: "PASS",
        });
        assert.strictEqual(
          explicit.passed,
          true,
          "a substring match is still available — it just has to be asked for"
        );
      });
    });

    test("marks spawn failures as errored", async () => {
      const scriptPath = path.join(workspaceRoot, "spawn-failure-script");
      fs.writeFileSync(scriptPath, "not executable");
      try {
        const result = await evaluate({ script: scriptPath });
        assert.strictEqual(result.passed, false);
        assert.strictEqual(result.errored, true);
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
        assert.match(result.error ?? "", /Unsupported script type/);
      } finally {
        fs.rmSync(scriptPath, { force: true });
      }
    });

    test("marks security-rejected paths as errored", async () => {
      const outsideDir = makeTempDir("ctrlyoke-outside-");
      const scriptPath = path.join(outsideDir, "outside.js");
      fs.writeFileSync(scriptPath, "console.log('outside')");
      try {
        const result = await evaluate({ script: scriptPath });
        assert.strictEqual(result.passed, false);
        assert.strictEqual(result.errored, true);
        assert.match(result.error ?? "", /Security:/);
      } finally {
        removeTempDir(outsideDir);
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
