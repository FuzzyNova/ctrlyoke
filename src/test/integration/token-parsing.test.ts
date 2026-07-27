import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";

suite("Copilot CLI OTel context-window enrichment", () => {
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

  test("should patch inputTokens/contextWindowUsedTokens from an OTel chat span", async () => {
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
    assert.strictEqual(output.metadata.usage?.outputTokens, 262);
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
