import * as assert from "assert";
import { suite, test } from "mocha";
import {
  AWAITING_INPUT_SOURCES,
  resolveHookNotificationPlan,
  serializeAwaitingInputRule,
} from "../../core/harness/shared/HookNotificationPlan";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import {
  HARNESS_IDS,
  HOOK_EVENT_ORDER,
  type HarnessId,
} from "../../types/DashboardConstants";

const notificationSettings = CTRLYOKE_SETTINGS_DEFAULTS.notifications;

suite("HookNotificationPlan", () => {
  test("selects the documented native source for every harness", () => {
    const expected: Record<HarnessId, string | null> = {
      [HARNESS_IDS.COPILOT_CLI]: "notification",
      [HARNESS_IDS.CLAUDE_CLI]: "notification",
      [HARNESS_IDS.CODEX_CLI]: "permissionRequest",
      [HARNESS_IDS.OPENCODE_CLI]: "permissionRequest",
      [HARNESS_IDS.QWEN_CLI]: "notification",
      [HARNESS_IDS.ANTIGRAVITY_CLI]: null,
    };

    for (const harnessId of Object.values(HARNESS_IDS)) {
      const plan = resolveHookNotificationPlan(harnessId, notificationSettings);
      assert.strictEqual(
        plan.awaitingInput?.event ?? null,
        expected[harnessId],
        harnessId
      );
      assert.deepStrictEqual(
        plan.installEvents,
        expected[harnessId] ? [expected[harnessId]] : [],
        harnessId
      );
      assert.deepStrictEqual(plan.emitRawEvents, [], harnessId);
    }
  });

  test("omits the native source when awaitingInput is disabled", () => {
    for (const harnessId of Object.values(HARNESS_IDS)) {
      const plan = resolveHookNotificationPlan(harnessId, {
        ...notificationSettings,
        events: { ...notificationSettings.events, awaitingInput: false },
      });

      assert.deepStrictEqual(plan.installEvents, [], harnessId);
      assert.deepStrictEqual(plan.emitRawEvents, [], harnessId);
      assert.strictEqual(plan.awaitingInput, undefined, harnessId);
    }
  });

  test("installs Codex PermissionRequest without emitting it as a raw event", () => {
    const plan = resolveHookNotificationPlan(HARNESS_IDS.CODEX_CLI, {
      ...notificationSettings,
      events: {
        ...notificationSettings.events,
        awaitingInput: true,
        hookEvents: {
          ...notificationSettings.events.hookEvents,
          permissionRequest: false,
        },
      },
    });

    assert.deepStrictEqual(plan.installEvents, ["permissionRequest"]);
    assert.deepStrictEqual(plan.emitRawEvents, []);
    assert.deepStrictEqual(plan.awaitingInput, { event: "permissionRequest" });
  });

  test("emits raw Codex PermissionRequest when enabled", () => {
    const plan = resolveHookNotificationPlan(HARNESS_IDS.CODEX_CLI, {
      ...notificationSettings,
      events: {
        ...notificationSettings.events,
        hookEvents: {
          ...notificationSettings.events.hookEvents,
          permissionRequest: true,
        },
      },
    });

    assert.deepStrictEqual(plan.installEvents, ["permissionRequest"]);
    assert.deepStrictEqual(plan.emitRawEvents, ["permissionRequest"]);
  });

  test("does not install events or return an awaiting-input source when hooks are disabled", () => {
    const plan = resolveHookNotificationPlan(
      HARNESS_IDS.CLAUDE_CLI,
      notificationSettings,
      { hooksDisabled: true }
    );

    assert.deepStrictEqual(plan.installEvents, []);
    assert.deepStrictEqual(plan.emitRawEvents, []);
    assert.strictEqual(plan.awaitingInput, undefined);
  });

  test("keeps install events in canonical hook order", () => {
    const plan = resolveHookNotificationPlan(HARNESS_IDS.CLAUDE_CLI, {
      ...notificationSettings,
      events: {
        ...notificationSettings.events,
        hookEvents: {
          ...notificationSettings.events.hookEvents,
          permissionRequest: true,
          stop: true,
        },
      },
    });

    assert.deepStrictEqual(
      plan.installEvents,
      HOOK_EVENT_ORDER.filter((event) =>
        ["stop", "permissionRequest", "notification"].includes(event)
      )
    );
  });

  test("serializes notification filters and unfiltered sources", () => {
    assert.strictEqual(
      serializeAwaitingInputRule(
        AWAITING_INPUT_SOURCES[HARNESS_IDS.COPILOT_CLI]!
      ),
      "notification:permission_prompt,elicitation_dialog"
    );
    assert.strictEqual(
      serializeAwaitingInputRule(
        AWAITING_INPUT_SOURCES[HARNESS_IDS.CODEX_CLI]!
      ),
      "permissionRequest"
    );
  });
});
