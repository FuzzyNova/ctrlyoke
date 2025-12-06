import * as assert from "assert";
import { CopilotCommandLineIntegration } from "../../flightpath/cli/CopilotCommandLineIntegration";
import { ClaudeCommandLineIntegration } from "../../flightpath/cli/ClaudeCommandLineIntegration";
import * as vscode from "vscode";

suite("Token Parsing Integration Tests", () => {
  let copilotIntegration: CopilotCommandLineIntegration;
  let claudeIntegration: ClaudeCommandLineIntegration;

  setup(() => {
    const context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    copilotIntegration = new CopilotCommandLineIntegration(context);
    claudeIntegration = new ClaudeCommandLineIntegration(context);
  });

  suite("Copilot CLI Token Parsing", () => {
    test("should parse format with k suffix on input", () => {
      const statistics =
        "capi-noe-ptuc-h200-ib-gpt-5-mini-2025-08-07 25.7k input, 223 output, 6.1k cache read (Est. 1 Premium request)";
      const result = copilotIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result?.prompt, 25700);
      assert.strictEqual(result?.completion, 223);
    });

    test("should parse format with decimal and k suffix on both", () => {
      const statistics = "1.5k input, 2.3k output";
      const result = copilotIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result?.prompt, 1500);
      assert.strictEqual(result?.completion, 2300);
    });

    test("should parse format without k suffix", () => {
      const statistics = "1234 input, 5678 output";
      const result = copilotIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result?.prompt, 1234);
      assert.strictEqual(result?.completion, 5678);
    });

    test("should parse full Copilot CLI output", () => {
      const statistics = `Total usage est:       1 Premium request
Total duration (API):  5s
Total duration (wall): 7s
Total code changes:    0 lines added, 0 lines removed
Usage by model:
    capi-noe-ptuc-h200-ib-gpt-5-mini-2025-08-07 25.7k input, 148 output, 25.6k cache read (Est. 1 Premium request)`;
      const result = copilotIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result?.prompt, 25700);
      assert.strictEqual(result?.completion, 148);
    });

    test("should return undefined for invalid format", () => {
      const statistics = "No token information here";
      const result = copilotIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result, undefined);
    });
  });

  suite("Claude CLI Token Parsing", () => {
    test("should parse format with input and output", () => {
      const statistics = "Usage: 1234 input + 5678 output = 6912 tokens";
      const result = claudeIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result?.prompt, 1234);
      assert.strictEqual(result?.completion, 5678);
    });

    test("should parse minimal format", () => {
      const statistics = "2500 input + 1200 output";
      const result = claudeIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result?.prompt, 2500);
      assert.strictEqual(result?.completion, 1200);
    });

    test("should return undefined for invalid format", () => {
      const statistics = "No token information here";
      const result = claudeIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result, undefined);
    });
  });
});
