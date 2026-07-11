import * as assert from "assert";
import { suite, test } from "mocha";
import { createHostedHarnessStatusUpdate } from "../../server/HostedServerMessageFactory";
import { sanitizeBrowserClientId } from "../../server/CtrlYokeHostedServer";
import {
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";

suite("sanitizeBrowserClientId", () => {
  test("passes through a well-formed tabId", () => {
    assert.strictEqual(sanitizeBrowserClientId("k3j4h5abc9"), "k3j4h5abc9");
    assert.strictEqual(sanitizeBrowserClientId("a-b_c-1"), "a-b_c-1");
  });

  test("strips characters outside the allowed charset", () => {
    // Path/scheme/quote characters that could poison a map key or broadcast are removed.
    assert.strictEqual(sanitizeBrowserClientId("a.b/c;d<e>"), "abcde");
    assert.strictEqual(sanitizeBrowserClientId("../../etc"), "etc");
  });

  test("caps length at 64 characters", () => {
    const long = "a".repeat(200);
    assert.strictEqual(sanitizeBrowserClientId(long)?.length, 64);
  });

  test("returns null for absent or fully-stripped ids", () => {
    assert.strictEqual(sanitizeBrowserClientId(null), null);
    assert.strictEqual(sanitizeBrowserClientId(""), null);
    assert.strictEqual(sanitizeBrowserClientId("!@#$%^&*()"), null);
  });
});

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
