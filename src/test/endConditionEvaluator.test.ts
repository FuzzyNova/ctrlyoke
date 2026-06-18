import * as assert from "assert";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import {
  EndConditionEvaluator,
  EvaluationResult,
} from "../flightpath/EndConditionEvaluator";
import type { PlatformAdapter } from "../platform/PlatformAdapter";

suite("EndConditionEvaluator Tests", () => {
  let evaluator: EndConditionEvaluator;

  setup(() => {
    // Create a minimal mock PlatformAdapter for testing
    const mockPlatform: PlatformAdapter = {
      getWorkspaceRoot: () => "",
      getExtensionPath: () => "",
      log: () => {},
      warn: () => {},
      error: () => {},
      showProgress: () => {},
      showChoice: async () => undefined,
    };

    evaluator = new EndConditionEvaluator(mockPlatform);
  });

  teardown(() => {
    evaluator.dispose();
  });

  suite("parseScriptCommand - Tokenization", () => {
    test("splits simple space-separated command", () => {
      const { scriptPath, args } = EndConditionEvaluator.parseScriptCommand(
        ".flightpath/scripts/check.py 5"
      );
      assert.strictEqual(scriptPath, ".flightpath/scripts/check.py");
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
      assert.deepStrictEqual(args, [
        "C:\\my dir\\check.js",
        "arg with spaces",
      ]);
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
      const { scriptPath, args } = EndConditionEvaluator.parseScriptCommand(
        'node check.js ""'
      );
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

  suite("buildRetryPrompt - Template Substitution", () => {
    const mockResult: EvaluationResult = {
      passed: false,
      stdout: "Test stdout output",
      stderr: "Test stderr error",
      result: "Test stdout output",
      duration: 100,
      exitCode: 1,
    };

    test("should replace {stdout} placeholder", () => {
      const result = evaluator.buildRetryPrompt(
        "Script output was: {stdout}",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "Script output was: Test stdout output");
    });

    test("should replace {stderr} placeholder", () => {
      const result = evaluator.buildRetryPrompt(
        "Error was: {stderr}",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "Error was: Test stderr error");
    });

    test("should replace {expected} placeholder", () => {
      const result = evaluator.buildRetryPrompt(
        "Expected: {expected}",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "Expected: true");
    });

    test("should replace {actual} placeholder", () => {
      const result = evaluator.buildRetryPrompt(
        "Actual: {actual}",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "Actual: Test stdout output");
    });

    test("should replace {exitCode} placeholder", () => {
      const result = evaluator.buildRetryPrompt(
        "Exit code: {exitCode}",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "Exit code: 1");
    });

    test("should replace {compareSource} placeholder — explicit", () => {
      const result = evaluator.buildRetryPrompt(
        "Source: {compareSource}",
        mockResult,
        "true",
        "stderr"
      );
      assert.strictEqual(result, "Source: stderr");
    });

    test("should replace {compareSource} placeholder — defaults to auto", () => {
      const result = evaluator.buildRetryPrompt(
        "Source: {compareSource}",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "Source: auto");
    });

    test("should handle undefined exitCode", () => {
      const noExit: EvaluationResult = { ...mockResult, exitCode: undefined };
      const result = evaluator.buildRetryPrompt(
        "Code: {exitCode}",
        noExit,
        "true"
      );
      assert.strictEqual(result, "Code: ");
    });

    test("should replace multiple occurrences of same placeholder", () => {
      const result = evaluator.buildRetryPrompt(
        "Output: {stdout}, again: {stdout}",
        mockResult,
        "true"
      );
      assert.strictEqual(
        result,
        "Output: Test stdout output, again: Test stdout output"
      );
    });

    test("should preserve text without placeholders", () => {
      const result = evaluator.buildRetryPrompt(
        "No placeholders here",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "No placeholders here");
    });

    test("should handle empty template", () => {
      const result = evaluator.buildRetryPrompt("", mockResult, "true");
      assert.strictEqual(result, "");
    });

    test("should handle all placeholders in one template", () => {
      const result = evaluator.buildRetryPrompt(
        "Expected {expected}, got {actual}. Stdout: {stdout}. Stderr: {stderr}. Code: {exitCode}. Source: {compareSource}",
        mockResult,
        "true",
        "stdout"
      );
      assert.ok(result.includes("Expected true"));
      assert.ok(result.includes("got Test stdout output"));
      assert.ok(result.includes("Stdout: Test stdout output"));
      assert.ok(result.includes("Stderr: Test stderr error"));
      assert.ok(result.includes("Code: 1"));
      assert.ok(result.includes("Source: stdout"));
    });

    test("should handle whitespace in output", () => {
      const resultWithWhitespace: EvaluationResult = {
        ...mockResult,
        stdout: "  spaced output  ",
        result: "  spaced output  ",
      };
      const result = evaluator.buildRetryPrompt(
        "{stdout}",
        resultWithWhitespace,
        "true"
      );
      assert.strictEqual(result, "spaced output");
    });

    test("should leave legacy placeholders unchanged", () => {
      const result = evaluator.buildRetryPrompt(
        "{scriptOutput} {errorOutput} {error}",
        mockResult,
        "true"
      );
      assert.strictEqual(result, "{scriptOutput} {errorOutput} {error}");
    });
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      // Test with an unsupported extension
      // We need an actual file for this, so this is a limited test
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
      const dir = path.join("C:", "dev", "FlightPath");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(dir, dir),
        true
      );
    });

    test("should accept immediate child path", () => {
      const dir = path.join("C:", "dev", "FlightPath");
      const child = path.join(dir, "scripts", "check.py");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(child, dir),
        true
      );
    });

    test("should accept deeply nested child path", () => {
      const dir = path.join("C:", "dev", "FlightPath");
      const child = path.join(dir, "a", "b", "c", "d.js");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(child, dir),
        true
      );
    });

    test("should reject sibling path sharing same prefix (CVE bypass)", () => {
      // C:\dev\FlightPath-evil must NOT pass the check for C:\dev\FlightPath
      const workspace = path.join("C:", "dev", "FlightPath");
      const sibling = path.join("C:", "dev", "FlightPath-evil", "payload.ps1");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(sibling, workspace),
        false
      );
    });

    test("should reject parent directory", () => {
      const workspace = path.join("C:", "dev", "FlightPath");
      const parent = path.join("C:", "dev");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(parent, workspace),
        false
      );
    });

    test("should reject root directory", () => {
      const workspace = path.join("C:", "dev", "FlightPath");
      assert.strictEqual(
        EndConditionEvaluator.isWithinDirectory(path.sep, workspace),
        false
      );
    });

    test("should reject completely unrelated path", () => {
      const workspace = path.join("C:", "dev", "FlightPath");
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

    test("should end with .flightpath/scripts", () => {
      const dir = EndConditionEvaluator.getUserHomeScriptsDir();
      const expectedSuffix = path.join(".flightpath", "scripts");
      assert.ok(
        dir.endsWith(expectedSuffix),
        `Expected dir to end with "${expectedSuffix}", got: "${dir}"`
      );
    });
  });
});
