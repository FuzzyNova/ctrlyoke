import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";

suite("Copilot CLI OTel context-window enrichment", () => {
  let otelFilePath: string;

  const writeOtelEntry = (entry: Record<string, unknown>): void => {
    fs.writeFileSync(otelFilePath, `${JSON.stringify(entry)}\n`);
  };

  setup(() => {
    otelFilePath = path.join(
      os.tmpdir(),
      `ctrlyoke-otel-test-${Date.now()}.jsonl`
    );
  });

  teardown(() => {
    fs.rmSync(otelFilePath, { force: true });
  });

  test("should patch inputTokens/contextWindowUsedTokens from an OTel chat span", async () => {
    writeOtelEntry({
      type: "span",
      name: "chat gpt-5-mini",
      attributes: {
        "gen_ai.request.model": "gpt-5-mini",
        "gen_ai.usage.input_tokens": 23180,
        "gen_ai.usage.output_tokens": 262,
      },
      events: [
        {
          name: "github.copilot.session.usage_info",
          attributes: {
            "github.copilot.current_tokens": 24731,
            "github.copilot.token_limit": 128000,
          },
        },
      ],
    });

    const provider = new CopilotCliProvider();
    provider.logParser.setOtelFilePath(otelFilePath);

    const output = await provider.augmentParsedOutput({
      events: [],
      metadata: { model: "gpt-5-mini", usage: { outputTokens: 262 } },
    } as any);

    assert.strictEqual(output.metadata.usage?.inputTokens, 23180);
    assert.strictEqual(output.metadata.usage?.contextWindowUsedTokens, 24731);
    assert.strictEqual(output.metadata.usage?.contextWindowSize, 128000);
    assert.strictEqual(output.metadata.usage?.outputTokens, 262);
  });

  test("should preserve OTel billing usage without inventing a context limit", async () => {
    writeOtelEntry({
      type: "span",
      name: "chat gpt-5-mini",
      attributes: {
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 10,
      },
    });

    const provider = new CopilotCliProvider();
    provider.logParser.setOtelFilePath(otelFilePath);

    const output = await provider.augmentParsedOutput({
      events: [],
      metadata: { model: "gpt-5-mini" },
    } as any);

    assert.strictEqual(output.metadata.usage?.inputTokens, 1000);
    assert.strictEqual(output.metadata.usage?.outputTokens, 10);
    assert.strictEqual(
      output.metadata.usage?.contextWindowUsedTokens,
      undefined
    );
    assert.strictEqual(output.metadata.usage?.contextWindowSize, undefined);
  });

  test("should pass through when no OTel file or session ID is available", async () => {
    const provider = new CopilotCliProvider();
    const output = await provider.augmentParsedOutput({
      events: [],
      metadata: { model: "gpt-5-mini", usage: { outputTokens: 5 } },
    } as any);

    assert.strictEqual(output.metadata.usage?.inputTokens, undefined);
  });
});
