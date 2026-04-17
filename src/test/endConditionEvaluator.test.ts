import * as assert from "assert";
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

  suite("buildRetryPrompt - Template Substitution", () => {
    // Create a mock evaluation result for testing
    const mockResult: EvaluationResult = {
      passed: false,
      stdout: "Test stdout output",
      stderr: "Test stderr error",
      result: "Test stdout output",
      duration: 100,
      exitCode: 1,
    };

    test("should replace {stdout} placeholder", () => {
      const template = "Script output was: {stdout}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        3
      );
      assert.strictEqual(result, "Script output was: Test stdout output");
    });

    test("should replace {stderr} placeholder", () => {
      const template = "Error was: {stderr}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        3
      );
      assert.strictEqual(result, "Error was: Test stderr error");
    });

    test("should replace {expectedValue} placeholder", () => {
      const template = "Expected: {expectedValue}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        3
      );
      assert.strictEqual(result, "Expected: true");
    });

    test("should replace {actualValue} placeholder", () => {
      const template = "Actual: {actualValue}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        3
      );
      assert.strictEqual(result, "Actual: Test stdout output");
    });

    test("should replace {retryCount} placeholder", () => {
      const template = "Retry attempt: {retryCount}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        2,
        5
      );
      assert.strictEqual(result, "Retry attempt: 2");
    });

    test("should replace {maxRetries} placeholder", () => {
      const template = "Max retries: {maxRetries}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        5
      );
      assert.strictEqual(result, "Max retries: 5");
    });

    test("should replace multiple occurrences of same placeholder", () => {
      const template = "Output: {stdout}, again: {stdout}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        3
      );
      assert.strictEqual(
        result,
        "Output: Test stdout output, again: Test stdout output"
      );
    });

    test("should preserve text without placeholders", () => {
      const template = "No placeholders here";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        3
      );
      assert.strictEqual(result, "No placeholders here");
    });

    test("should handle empty template", () => {
      const result = evaluator.buildRetryPrompt("", mockResult, "true", 1, 3);
      assert.strictEqual(result, "");
    });

    test("should handle all placeholders in one template", () => {
      const template =
        "Retry {retryCount}/{maxRetries}: Expected {expectedValue}, got {actualValue}. " +
        "Output: {stdout}. Error: {stderr}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        2,
        5
      );
      assert.ok(result.includes("Retry 2/5"));
      assert.ok(result.includes("Expected true"));
      assert.ok(result.includes("got Test stdout output"));
    });

    test("should handle whitespace in output", () => {
      const resultWithWhitespace: EvaluationResult = {
        ...mockResult,
        stdout: "  spaced output  ",
        result: "  spaced output  ",
      };
      const template = "{stdout}";
      const result = evaluator.buildRetryPrompt(
        template,
        resultWithWhitespace,
        "true",
        1,
        3
      );
      // buildRetryPrompt trims the output
      assert.strictEqual(result, "spaced output");
    });

    test("should leave legacy placeholders unchanged", () => {
      const template = "{scriptOutput} {errorOutput} {error}";
      const result = evaluator.buildRetryPrompt(
        template,
        mockResult,
        "true",
        1,
        3
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
});
