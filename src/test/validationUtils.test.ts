import * as assert from "assert";
import { ValidationUtils } from "../utils/ValidationUtils";

suite("ValidationUtils Extended Tests", () => {
  suite("validateScriptPath - Security", () => {
    test("should reject directory traversal patterns (..)", () => {
      const result = ValidationUtils.validateScriptPath(
        "../../../dangerous.py"
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.some((e) => e.includes("dangerous")));
    });

    test("should reject shell redirection (<, >, |)", () => {
      const redirectResult = ValidationUtils.validateScriptPath(
        "script.py > output.txt"
      );
      assert.strictEqual(redirectResult.valid, false);

      const pipeResult = ValidationUtils.validateScriptPath(
        "script.py | evil.sh"
      );
      assert.strictEqual(pipeResult.valid, false);

      const inputResult = ValidationUtils.validateScriptPath(
        "script.py < input.txt"
      );
      assert.strictEqual(inputResult.valid, false);
    });

    test("should reject command injection (;, &, `, $)", () => {
      const semicolonResult = ValidationUtils.validateScriptPath(
        "script.py; rm -rf /"
      );
      assert.strictEqual(semicolonResult.valid, false);

      const ampersandResult = ValidationUtils.validateScriptPath(
        "script.py && evil.sh"
      );
      assert.strictEqual(ampersandResult.valid, false);

      const backtickResult =
        ValidationUtils.validateScriptPath("`evil command`.py");
      assert.strictEqual(backtickResult.valid, false);

      const dollarResult = ValidationUtils.validateScriptPath("$(evil).py");
      assert.strictEqual(dollarResult.valid, false);
    });

    test("should accept valid Python script paths", () => {
      const result = ValidationUtils.validateScriptPath("check_condition.py");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test("should accept valid JavaScript script paths", () => {
      const result = ValidationUtils.validateScriptPath(
        "validate_email_tests.js"
      );
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test("should accept valid PowerShell script paths", () => {
      const result = ValidationUtils.validateScriptPath("check_condition.ps1");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test("should accept valid shell script paths", () => {
      const shResult = ValidationUtils.validateScriptPath("check_condition.sh");
      assert.strictEqual(shResult.valid, true);

      const batResult = ValidationUtils.validateScriptPath(
        "check_condition.bat"
      );
      assert.strictEqual(batResult.valid, true);

      const cmdResult = ValidationUtils.validateScriptPath(
        "check_condition.cmd"
      );
      assert.strictEqual(cmdResult.valid, true);
    });

    test("should accept valid TypeScript script paths", () => {
      const result = ValidationUtils.validateScriptPath("check_condition.ts");
      assert.strictEqual(result.valid, true);
    });

    test("should reject unknown extensions", () => {
      const result = ValidationUtils.validateScriptPath("script.xyz");
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("extension")));
    });

    test("should reject empty path", () => {
      const result = ValidationUtils.validateScriptPath("");
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("non-empty")));
    });

    test("should reject null/undefined path", () => {
      const nullResult = ValidationUtils.validateScriptPath(null as any);
      assert.strictEqual(nullResult.valid, false);

      const undefinedResult = ValidationUtils.validateScriptPath(
        undefined as any
      );
      assert.strictEqual(undefinedResult.valid, false);
    });
  });

  suite("validateEndCondition", () => {
    test("should accept valid end condition with script and returns", () => {
      const condition = {
        script: "test.py",
        returns: "true",
      };
      const result = ValidationUtils.validateEndCondition(condition);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test("should accept end condition with optional timeout", () => {
      const condition = {
        script: "test.py",
        returns: "true",
        timeout: 5000,
      };
      const result = ValidationUtils.validateEndCondition(condition);
      assert.strictEqual(result.valid, true);
    });

    test("should accept null/undefined (optional)", () => {
      const nullResult = ValidationUtils.validateEndCondition(null);
      assert.strictEqual(nullResult.valid, true);

      const undefinedResult = ValidationUtils.validateEndCondition(undefined);
      assert.strictEqual(undefinedResult.valid, true);
    });

    test("should reject missing script property", () => {
      const condition = {
        returns: "true",
      };
      const result = ValidationUtils.validateEndCondition(condition);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("script")));
    });

    test("should reject missing returns property", () => {
      const condition = {
        script: "test.py",
      };
      const result = ValidationUtils.validateEndCondition(condition);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("returns")));
    });

    test("should reject non-positive timeout", () => {
      const condition = {
        script: "test.py",
        returns: "true",
        timeout: 0,
      };
      const result = ValidationUtils.validateEndCondition(condition);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("timeout")));
    });

    test("should reject negative timeout", () => {
      const condition = {
        script: "test.py",
        returns: "true",
        timeout: -1000,
      };
      const result = ValidationUtils.validateEndCondition(condition);
      assert.strictEqual(result.valid, false);
    });

    test("should accept maxRetries in valid range (0-100)", () => {
      const zeroResult = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        maxRetries: 0,
      });
      assert.strictEqual(zeroResult.valid, true);

      const normalResult = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        maxRetries: 50,
      });
      assert.strictEqual(normalResult.valid, true);

      const maxResult = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        maxRetries: 100,
      });
      assert.strictEqual(maxResult.valid, true);
    });

    test("should accept maxRetries = -1 (unlimited)", () => {
      const result = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        maxRetries: -1,
      });
      assert.strictEqual(result.valid, true);
    });

    test("should reject maxRetries > 100 (unless -1)", () => {
      const result = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        maxRetries: 101,
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("maxRetries")));
    });

    test("should reject maxRetries < -1", () => {
      const result = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        maxRetries: -2,
      });
      assert.strictEqual(result.valid, false);
    });

    test("should accept retryPrompt as string", () => {
      const result = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        retryPrompt: "Try again: {stdout}",
      });
      assert.strictEqual(result.valid, true);
    });

    test("should accept retry as an end-condition onPass action", () => {
      const result = ValidationUtils.validatePromptStep({
        prompt: "Test prompt",
        endCondition: {
          script: "test.py",
          returns: "true",
          onPass: "retry",
        },
      });

      assert.strictEqual(result.valid, true);
    });

    test("should reject retryPrompt as non-string", () => {
      const result = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        retryPrompt: 123,
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("retryPrompt")));
    });

    test("should accept passRetryPrompt as string", () => {
      const result = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        passRetryPrompt: "Keep working: {actual} vs {expected}",
      });
      assert.strictEqual(result.valid, true);
    });

    test("should reject passRetryPrompt as non-string", () => {
      const result = ValidationUtils.validateEndCondition({
        script: "test.py",
        returns: "true",
        passRetryPrompt: 123,
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("passRetryPrompt")));
    });

    test("should reject non-object end condition", () => {
      const stringResult = ValidationUtils.validateEndCondition("invalid");
      assert.strictEqual(stringResult.valid, false);
      assert.ok(stringResult.errors.some((e) => e.includes("object")));

      const arrayResult = ValidationUtils.validateEndCondition([]);
      assert.strictEqual(arrayResult.valid, false);
    });
  });

  suite("validatePromptFile", () => {
    test("should accept single prompt format with prompt string", () => {
      const file = {
        prompt: "Test prompt text",
      };
      const result = ValidationUtils.validatePromptFile(file);
      assert.strictEqual(result.valid, true);
    });

    test("should accept multiple prompts format with prompts array", () => {
      const file = {
        steps: [{ prompt: "First prompt" }, { prompt: "Second prompt" }],
      };
      const result = ValidationUtils.validatePromptFile(file);
      assert.strictEqual(result.valid, true);
    });

    test("should reject having both prompt and prompts", () => {
      const file = {
        prompt: "Single prompt",
        steps: [{ prompt: "Array prompt" }],
      };
      const result = ValidationUtils.validatePromptFile(file);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("both")));
    });

    test("should reject missing both prompt and prompts", () => {
      const file = {
        model: "claude-sonnet-4.5",
      };
      const result = ValidationUtils.validatePromptFile(file);
      assert.strictEqual(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("prompt") || e.includes("prompts"))
      );
    });

    test("should reject non-object input", () => {
      const nullResult = ValidationUtils.validatePromptFile(null);
      assert.strictEqual(nullResult.valid, false);
      assert.ok(nullResult.errors.some((e) => e.includes("object")));

      const stringResult = ValidationUtils.validatePromptFile("invalid");
      assert.strictEqual(stringResult.valid, false);

      const arrayResult = ValidationUtils.validatePromptFile([]);
      assert.strictEqual(arrayResult.valid, false);
    });

    test("should validate nested prompt items in prompts array", () => {
      const file = {
        steps: [
          { prompt: "Valid prompt" },
          { notPrompt: "Invalid item" }, // Missing required 'prompt' field
        ],
      };
      const result = ValidationUtils.validatePromptFile(file);
      assert.strictEqual(result.valid, false);
    });
  });

  suite("sanitizePromptText", () => {
    test("should remove control characters", () => {
      const input = "Hello\x00World\x1F";
      const result = ValidationUtils.sanitizePromptText(input);
      assert.strictEqual(result, "HelloWorld");
    });

    test("should preserve template variables", () => {
      const input = "Check ${variable} here";
      const result = ValidationUtils.sanitizePromptText(input);
      assert.ok(result.includes("${variable}"));
    });

    test("should trim whitespace", () => {
      const input = "   Hello World   ";
      const result = ValidationUtils.sanitizePromptText(input);
      assert.strictEqual(result, "Hello World");
    });

    test("should handle non-string input gracefully", () => {
      const nullResult = ValidationUtils.sanitizePromptText(null as any);
      assert.strictEqual(nullResult, "");

      const undefinedResult = ValidationUtils.sanitizePromptText(
        undefined as any
      );
      assert.strictEqual(undefinedResult, "");

      const numberResult = ValidationUtils.sanitizePromptText(123 as any);
      assert.strictEqual(numberResult, "");
    });

    test("should preserve valid unicode", () => {
      const input = "こんにちは 🎉 emoji";
      const result = ValidationUtils.sanitizePromptText(input);
      assert.strictEqual(result, input);
    });

    test("should preserve newlines (non-control)", () => {
      const input = "Line1\nLine2";
      const result = ValidationUtils.sanitizePromptText(input);
      assert.ok(result.includes("\n"));
    });
  });

  suite("validateTimeout", () => {
    test("should accept undefined timeout (optional)", () => {
      const result = ValidationUtils.validateTimeout(undefined);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test("should accept null timeout (optional)", () => {
      const result = ValidationUtils.validateTimeout(null);
      assert.strictEqual(result.valid, true);
    });

    test("should accept valid positive timeout", () => {
      const result = ValidationUtils.validateTimeout(5000);
      assert.strictEqual(result.valid, true);
    });

    test("should reject zero timeout", () => {
      const result = ValidationUtils.validateTimeout(0);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("positive")));
    });

    test("should reject negative timeout", () => {
      const result = ValidationUtils.validateTimeout(-1000);
      assert.strictEqual(result.valid, false);
    });

    test("should reject timeout > 300000ms (5 minutes)", () => {
      const result = ValidationUtils.validateTimeout(400000);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("5 minute")));
    });

    test("should reject non-number timeout", () => {
      const stringResult = ValidationUtils.validateTimeout("5000" as any);
      assert.strictEqual(stringResult.valid, false);
      assert.ok(stringResult.errors.some((e) => e.includes("number")));
    });

    test("should accept boundary value 300000ms", () => {
      const result = ValidationUtils.validateTimeout(300000);
      assert.strictEqual(result.valid, true);
    });
  });

  suite("createValidationSummary", () => {
    test("should aggregate multiple validation results", () => {
      const results = [
        { valid: true, errors: [] },
        { valid: false, errors: ["Error 1"] },
        { valid: false, errors: ["Error 2", "Error 3"] },
      ];
      const summary = ValidationUtils.createValidationSummary(results);
      assert.strictEqual(summary.errorCount, 3);
      assert.deepStrictEqual(summary.errors, ["Error 1", "Error 2", "Error 3"]);
    });

    test("should report valid when all results are valid", () => {
      const results = [
        { valid: true, errors: [] },
        { valid: true, errors: [] },
      ];
      const summary = ValidationUtils.createValidationSummary(results);
      assert.strictEqual(summary.valid, true);
      assert.strictEqual(summary.errorCount, 0);
    });

    test("should report invalid when any result is invalid", () => {
      const results = [
        { valid: true, errors: [] },
        { valid: false, errors: ["One error"] },
        { valid: true, errors: [] },
      ];
      const summary = ValidationUtils.createValidationSummary(results);
      assert.strictEqual(summary.valid, false);
    });

    test("should count total errors correctly", () => {
      const results = [
        { valid: false, errors: ["A", "B"] },
        { valid: false, errors: ["C"] },
      ];
      const summary = ValidationUtils.createValidationSummary(results);
      assert.strictEqual(summary.errorCount, 3);
    });

    test("should collect all error messages", () => {
      const results = [
        { valid: false, errors: ["First error"] },
        { valid: false, errors: ["Second error"] },
      ];
      const summary = ValidationUtils.createValidationSummary(results);
      assert.ok(summary.errors.includes("First error"));
      assert.ok(summary.errors.includes("Second error"));
    });

    test("should handle empty results array", () => {
      const summary = ValidationUtils.createValidationSummary([]);
      assert.strictEqual(summary.valid, true);
      assert.strictEqual(summary.errorCount, 0);
      assert.deepStrictEqual(summary.errors, []);
    });
  });
});
