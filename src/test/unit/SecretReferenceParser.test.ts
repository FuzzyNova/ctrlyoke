import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { after, suite, test } from "mocha";
import { PromptFileParser } from "../../core/PromptFileParser";
import {
  getEffectiveSecretGrants,
  parseSecretReferences,
} from "../../utils/SecretReferenceParser";
import type { PromptStep, ScriptStep } from "../../types/CtrlYokeTypes";

suite("SecretReferenceParser", () => {
  const temporaryDirectories: string[] = [];

  after(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test("parses valid inline secret references with offsets", () => {
    const text = "Use !FIRST_KEY and (!SECOND_2) when syncing.";

    assert.deepStrictEqual(parseSecretReferences(text), [
      {
        name: "FIRST_KEY",
        startOffset: 4,
        endOffset: 14,
      },
      {
        name: "SECOND_2",
        startOffset: 20,
        endOffset: 29,
      },
    ]);
  });

  test("does not parse markdown images, prose, filenames, or lowercase text", () => {
    const text = "![alt](url) Done! data!file.csv !lowercase !VALID_NAME.";

    assert.deepStrictEqual(
      parseSecretReferences(text).map((reference) => reference.name),
      ["VALID_NAME"]
    );
  });

  test("does not parse secret references immediately after Unicode letters", () => {
    assert.deepStrictEqual(parseSecretReferences("café!API_TOKEN"), []);
    assert.deepStrictEqual(parseSecretReferences("東京!API_TOKEN"), []);
    assert.deepStrictEqual(
      parseSecretReferences("cafe !API_TOKEN").map(({ name }) => name),
      ["API_TOKEN"]
    );
  });

  test("does not parse !NAME inside triple-backtick fenced blocks", () => {
    const text = "Log excerpt:\n```log\n<!DOCTYPE>\n```\nUse !REAL_NAME too.";

    assert.deepStrictEqual(
      parseSecretReferences(text).map((reference) => reference.name),
      ["REAL_NAME"]
    );
  });

  test("unions inline references with resolved declarations and deduplicates", () => {
    const step: PromptStep = {
      prompt: "Use !INLINE and !SHARED.",
    };

    assert.deepStrictEqual(
      getEffectiveSecretGrants(step, ["DECLARED", "SHARED"]),
      ["INLINE", "SHARED", "DECLARED"]
    );
  });

  test("unions process-map references with resolved declarations", () => {
    const step: PromptStep = { prompt: "No inline reference" };

    assert.deepStrictEqual(
      getEffectiveSecretGrants(step, ["DECLARED"], ["MAP_SECRET", "DECLARED"]),
      ["DECLARED", "MAP_SECRET"]
    );
  });

  test("uses only explicit declarations for script steps", () => {
    const step: ScriptStep = {
      type: "script",
      script: "./report.sh",
    };

    assert.deepStrictEqual(getEffectiveSecretGrants(step, ["SCRIPT_SECRET"]), [
      "SCRIPT_SECRET",
    ]);
    assert.deepStrictEqual(getEffectiveSecretGrants(step, null), []);
  });

  test("preserves secret declarations through PromptFileParser", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-secrets-parser-")
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "workflow.ctrlyoke.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        secrets: ["WORKFLOW_SECRET"],
        steps: [
          { prompt: "Use !PROMPT_SECRET", secrets: ["PROMPT_SECRET"] },
          { type: "script", script: "./report.sh", secrets: ["SCRIPT_SECRET"] },
        ],
      }),
      "utf8"
    );

    const parsed = await new PromptFileParser().parsePromptFile(filePath);

    assert.ok(parsed);
    assert.deepStrictEqual(parsed.secrets, ["WORKFLOW_SECRET"]);
    assert.deepStrictEqual(parsed.steps?.[0].secrets, ["PROMPT_SECRET"]);
    assert.deepStrictEqual(parsed.steps?.[1].secrets, ["SCRIPT_SECRET"]);
  });
});
