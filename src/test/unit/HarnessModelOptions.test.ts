import * as assert from "assert";
import { suite, test } from "mocha";
import { buildHarnessModelOptions } from "../../utils/HarnessModelOptions";
import { isCliModelSupported } from "../../utils/ModelRegistry";
import { COPILOT_AUTO_MODEL } from "../../utils/ModelConstants";
import { HARNESS_IDS, MODEL_NONE_OPTION } from "../../types/DashboardConstants";

suite("HarnessModelOptions", () => {
  test("Copilot lists auto directly below the none option", () => {
    const options = buildHarnessModelOptions()[HARNESS_IDS.COPILOT_CLI];
    assert.strictEqual(options[0].value, MODEL_NONE_OPTION.value);
    assert.deepStrictEqual(options[1], {
      value: COPILOT_AUTO_MODEL,
      label: "Auto",
    });
  });

  test("other harnesses do not get the Copilot auto option", () => {
    const options = buildHarnessModelOptions()[HARNESS_IDS.CLAUDE_CLI];
    assert.ok(!options.some((option) => option.value === COPILOT_AUTO_MODEL));
  });

  test("Copilot accepts auto as a --model value", () => {
    assert.strictEqual(isCliModelSupported(COPILOT_AUTO_MODEL), true);
  });
});
