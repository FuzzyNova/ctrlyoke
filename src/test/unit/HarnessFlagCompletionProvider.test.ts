import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import {
  getHarnessFlagCompletions,
  type HarnessFlagCompletion,
} from "../../core/harness/shared/HarnessFlagCompletionProvider";
import { HARNESS_IDS, type HarnessId } from "../../types/DashboardConstants";

const FIXTURE_DIRECTORY = path.resolve(
  __dirname,
  "../../../src/test/fixtures/harness-help"
);

const FIXTURE_CASES: Array<{ harnessId: HarnessId; fileName: string }> = [
  {
    harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
    fileName: "antigravity-cli.txt",
  },
  { harnessId: HARNESS_IDS.CLAUDE_CLI, fileName: "claude-cli.txt" },
  { harnessId: HARNESS_IDS.CODEX_CLI, fileName: "codex-cli.txt" },
  { harnessId: HARNESS_IDS.COPILOT_CLI, fileName: "copilot-cli.txt" },
  { harnessId: HARNESS_IDS.OPENCODE_CLI, fileName: "opencode-cli.txt" },
  { harnessId: HARNESS_IDS.QWEN_CLI, fileName: "qwen-cli.txt" },
].filter(({ fileName }) =>
  fs.existsSync(path.join(FIXTURE_DIRECTORY, fileName))
);

function readFixture(fileName: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIRECTORY, fileName), "utf8");
}

function findCompletion(
  completions: HarnessFlagCompletion[],
  flag: string
): HarnessFlagCompletion {
  const completion = completions.find((item) => item.flag === flag);
  assert.ok(completion, `expected ${flag} to be parsed`);
  return completion;
}

suite("HarnessFlagCompletionProvider", () => {
  for (const { harnessId, fileName } of FIXTURE_CASES) {
    test(`parses captured ${harnessId} help output`, () => {
      const completions = getHarnessFlagCompletions(
        harnessId,
        readFixture(fileName)
      );

      assert.ok(completions.length >= 8);
      assert.ok(completions.every((item) => item.flag.startsWith("--")));
      assert.ok(
        completions.every(
          (item) => item.detail || (item.valueHints?.length ?? 0) > 0
        )
      );

      if (harnessId === HARNESS_IDS.CODEX_CLI) {
        assert.deepStrictEqual(
          findCompletion(completions, "--sandbox").valueHints,
          ["read-only", "workspace-write", "danger-full-access"]
        );
        assert.deepStrictEqual(
          findCompletion(completions, "--ask-for-approval").valueHints,
          ["on-request", "never"]
        );
      }
    });
  }

  test("parses aliases, wrapped descriptions, and enum choices", () => {
    const completions = getHarnessFlagCompletions(
      HARNESS_IDS.COPILOT_CLI,
      [
        "Options:",
        '  -r, --reasoning-effort <level>  Reasoning effort (choices: "low", "medium", "high")',
        "      --mode [safe|fast]          Execution mode",
        "  -c                             Alias for --continue",
        "  --continue                     Continue the session",
        "                                    across multiple turns",
      ].join("\n")
    );

    assert.deepStrictEqual(findCompletion(completions, "--reasoning-effort"), {
      flag: "--reasoning-effort",
      alias: "-r",
      valueHints: ["low", "medium", "high"],
      detail: 'Reasoning effort (choices: "low", "medium", "high")',
    });
    assert.deepStrictEqual(findCompletion(completions, "--mode"), {
      flag: "--mode",
      valueHints: ["safe", "fast"],
      detail: "Execution mode",
    });
    assert.strictEqual(findCompletion(completions, "--continue").alias, "-c");
    assert.strictEqual(
      findCompletion(completions, "--continue").detail,
      "Continue the session across multiple turns"
    );
  });

  test("parses a flag without a value placeholder", () => {
    const [completion] = getHarnessFlagCompletions(
      HARNESS_IDS.ANTIGRAVITY_CLI,
      "  --verbose                       Show verbose output"
    );

    assert.deepStrictEqual(completion, {
      flag: "--verbose",
      detail: "Show verbose output",
    });
  });

  test("returns an empty array for empty or malformed input", () => {
    assert.deepStrictEqual(
      getHarnessFlagCompletions(HARNESS_IDS.CLAUDE_CLI, ""),
      []
    );
    assert.deepStrictEqual(
      getHarnessFlagCompletions(
        HARNESS_IDS.CLAUDE_CLI,
        "not a flag\n  - not an option\n--also-not-an-option"
      ),
      []
    );
  });
});
