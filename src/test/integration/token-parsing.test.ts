import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CliIntegration } from "../../core/harness/CliIntegration";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import * as vscode from "vscode";

suite("Token Parsing Integration Tests", () => {
  let copilotIntegration: CliIntegration;
  let claudeIntegration: CliIntegration;
  let openCodeIntegration: CliIntegration;

  setup(() => {
    const context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const platform = new VsCodeAdapter(context);
    copilotIntegration = new CliIntegration(new CopilotCliProvider(), platform);
    claudeIntegration = new CliIntegration(new ClaudeCliProvider(), platform);
    openCodeIntegration = new CliIntegration(
      new OpenCodeCliProvider(),
      platform
    );
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

  suite("Copilot CLI OTel Context Window (headless augmentParsedOutput)", () => {
    let otelFilePath: string;

    setup(() => {
      otelFilePath = path.join(
        os.tmpdir(),
        `ctrlyoke-otel-test-${Date.now()}.jsonl`
      );
    });

    teardown(() => {
      fs.rmSync(otelFilePath, { force: true });
    });

    test("should patch inputTokens/contextWindowUsedTokens from an OTel chat span, even without a sessionId", async () => {
      // Real span shape captured from `copilot --model gpt-5-mini` with
      // COPILOT_OTEL_ENABLED=true / COPILOT_OTEL_FILE_EXPORTER_PATH set explicitly.
      fs.writeFileSync(
        otelFilePath,
        `${JSON.stringify({
          type: "span",
          name: "chat gpt-5-mini",
          attributes: {
            "gen_ai.request.model": "gpt-5-mini",
            "gen_ai.usage.input_tokens": 23180,
            "gen_ai.usage.output_tokens": 262,
          },
        })}\n`
      );

      const provider = new CopilotCliProvider();
      provider.logParser.setOtelFilePath(otelFilePath);

      const output = await provider.augmentParsedOutput({
        events: [],
        metadata: { model: "gpt-5-mini", usage: { outputTokens: 262 } },
      } as any);

      assert.strictEqual(output.metadata.usage?.inputTokens, 23180);
      assert.strictEqual(output.metadata.usage?.contextWindowUsedTokens, 23180);
      assert.ok((output.metadata.usage?.contextWindowSize ?? 0) > 0);
      // Existing output token count (from parsed stdout) is preserved, not overwritten by OTel.
      assert.strictEqual(output.metadata.usage?.outputTokens, 262);
    });

    test("should fall through to session-log fallback when no OTel file is set", async () => {
      const provider = new CopilotCliProvider();
      // No setOtelFilePath call — mirrors a run where OTel was never enabled.

      const output = await provider.augmentParsedOutput({
        events: [],
        metadata: { model: "gpt-5-mini", usage: { outputTokens: 5 } },
      } as any);

      // No sessionId either, so it can't fall through further — output passes through unchanged.
      assert.strictEqual(output.metadata.usage?.inputTokens, undefined);
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

  suite("OpenCode CLI Token Parsing", () => {
    test("should parse aggregated step_finish JSONL token counts", () => {
      const statistics = [
        JSON.stringify({
          type: "step_finish",
          part: { tokens: { input: 1234, output: 56 } },
        }),
        JSON.stringify({
          type: "step_finish",
          part: { tokens: { input: 10, output: 20 } },
        }),
      ].join("\n");
      const result = openCodeIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result?.prompt, 1244);
      assert.strictEqual(result?.completion, 76);
    });

    test("should return undefined when no token-bearing events exist", () => {
      const statistics = JSON.stringify({
        type: "text",
        part: { text: "No usage data here" },
      });
      const result = openCodeIntegration.parseTokenCounts(statistics);

      assert.strictEqual(result, undefined);
    });
  });
});
