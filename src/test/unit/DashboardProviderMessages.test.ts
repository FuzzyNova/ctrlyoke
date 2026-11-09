import * as assert from "assert";
import { suite, test } from "mocha";
import {
  cliPromptsExtendedMessage,
  cliWatchOutputMessage,
} from "../../ui/DashboardProviderMessages";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import type { CliOutput } from "../../types/WebviewMessageTypes";

suite("DashboardProviderMessages", () => {
  test("omits unset optional fields from CLI watch output", () => {
    const output = { response: "hi" } as unknown as CliOutput;
    assert.deepStrictEqual(cliWatchOutputMessage("wf", 2, output), {
      type: MESSAGE_TYPES.CLI_WATCH_OUTPUT,
      workflowId: "wf",
      stepIndex: 2,
      output,
    });
    assert.strictEqual(
      cliWatchOutputMessage("wf", 2, output, "prompt").prompt,
      "prompt"
    );
  });

  test("omits unset optional fields from a CLI queue extension", () => {
    assert.deepStrictEqual(cliPromptsExtendedMessage("wf", []), {
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      workflowId: "wf",
      steps: [],
    });
    const parallelGroups = [{ id: "g", name: "Group" }] as never;
    assert.deepStrictEqual(
      cliPromptsExtendedMessage("wf", [], 0, parallelGroups),
      {
        type: MESSAGE_TYPES.STEPS_EXTENDED,
        workflowId: "wf",
        steps: [],
        definitionRevision: 0,
        parallelGroups,
      }
    );
  });
});
