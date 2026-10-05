import * as assert from "assert";
import { suite, test, setup } from "mocha";
import { HarnessAvailabilityRegistry } from "../../utils/HarnessAvailability";
import {
  HARNESS_DISPLAY_ORDER,
  HARNESS_IDS,
  type HarnessId,
} from "../../types/DashboardConstants";

suite("HarnessAvailabilityRegistry", () => {
  let registry: HarnessAvailabilityRegistry;

  setup(() => {
    registry = new HarnessAvailabilityRegistry();
  });

  test("has no first available harness before any detection", () => {
    assert.strictEqual(registry.getFirstAvailable(), undefined);
  });

  test("picks the first installed harness in display order, not record order", () => {
    registry.record(HARNESS_IDS.QWEN_CLI, true);
    registry.record(HARNESS_IDS.COPILOT_CLI, true);
    registry.record(HARNESS_IDS.CLAUDE_CLI, true);
    registry.record(HARNESS_IDS.ANTIGRAVITY_CLI, false);

    assert.strictEqual(registry.getFirstAvailable(), HARNESS_IDS.CLAUDE_CLI);
  });

  test("notifies only when the first available harness changes", () => {
    let notifications = 0;
    const unsubscribe = registry.onFirstAvailableChange(() => {
      notifications += 1;
    });

    registry.record(HARNESS_IDS.QWEN_CLI, true);
    registry.record(HARNESS_IDS.OPENCODE_CLI, false);
    registry.record(HARNESS_IDS.CODEX_CLI, true);
    registry.record(HARNESS_IDS.CODEX_CLI, true);
    unsubscribe();
    registry.record(HARNESS_IDS.CLAUDE_CLI, true);

    assert.strictEqual(notifications, 2);
  });

  test("probes in display order and stops at the first installed harness", async () => {
    const probed: HarnessId[] = [];
    const detected = await registry.detectFirstAvailable(async (harnessId) => {
      probed.push(harnessId);
      return harnessId === HARNESS_IDS.CODEX_CLI;
    });

    assert.strictEqual(detected, HARNESS_IDS.CODEX_CLI);
    assert.deepStrictEqual(probed, HARNESS_DISPLAY_ORDER.slice(0, 3));
    assert.strictEqual(registry.getFirstAvailable(), HARNESS_IDS.CODEX_CLI);
  });

  test("reuses recorded results and treats a failed probe as unavailable", async () => {
    registry.record(HARNESS_IDS.ANTIGRAVITY_CLI, false);
    const probed: HarnessId[] = [];
    const detected = await registry.detectFirstAvailable(async (harnessId) => {
      probed.push(harnessId);
      if (harnessId === HARNESS_IDS.CLAUDE_CLI) {
        throw new Error("spawn failed");
      }
      return harnessId === HARNESS_IDS.COPILOT_CLI;
    });

    assert.strictEqual(detected, HARNESS_IDS.COPILOT_CLI);
    assert.deepStrictEqual(probed, [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.COPILOT_CLI,
    ]);
  });

  test("returns undefined when no harness is installed", async () => {
    const detected = await registry.detectFirstAvailable(async () => false);
    assert.strictEqual(detected, undefined);
  });
});
