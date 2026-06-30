import * as assert from "assert";
import { suite, test } from "mocha";
import { createHostedHarnessStatusUpdate } from "../../server/HostedServerMessageFactory";
import {
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";

suite("HostedServerMessageFactory", () => {
  test("creates harness updates in the webview message shape", () => {
    assert.deepStrictEqual(
      createHostedHarnessStatusUpdate(HARNESS_IDS.CODEX_CLI, true),
      {
        type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
        data: {
          harnessStatus: {
            [HARNESS_IDS.CODEX_CLI]: {
              available: true,
              status: HARNESS_STATUS_STRINGS.AVAILABLE,
            },
          },
        },
      }
    );
  });
});
