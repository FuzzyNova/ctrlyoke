import * as assert from "assert";
import { suite, test } from "mocha";
import {
  isCtrlYokeQwenHookGroup,
  QwenNotificationMonitor,
} from "../../core/harness/qwen/QwenNotificationMonitor";
import type { UserHookConfig } from "../../types/CtrlYokeTypes";

suite("QwenNotificationMonitor", () => {
  test("identifies only command groups running the Qwen hook script basename", () => {
    assert.strictEqual(
      isCtrlYokeQwenHookGroup({
        hooks: [
          {
            type: "command",
            command:
              'node "C:/old/extension/out/scripts/ctrlyoke-qwen-hook.js" notify',
          },
          {
            type: "command",
            command: "node /another/version/ctrlyoke-qwen-hook.js notify",
          },
        ],
      }),
      true
    );
    assert.strictEqual(
      isCtrlYokeQwenHookGroup({
        hooks: [
          { type: "command", command: "node ctrlyoke-qwen-hook.js" },
          { type: "command", command: "node user-hook.js" },
        ],
      }),
      false
    );
    assert.strictEqual(
      isCtrlYokeQwenHookGroup({
        hooks: [{ type: "prompt", command: "ctrlyoke-qwen-hook.js" }],
      }),
      false
    );
  });

  test("retains a live owner and discards a dead owner", () => {
    const groupFor = (pid: number) => ({
      hooks: [
        {
          type: "command",
          command: `node /extension/out/scripts/ctrlyoke-qwen-hook.js /workspace/.ctrlyoke/temp/qwen-notifications "" --ctrlyoke-owner-pid=${pid}`,
        },
      ],
    });

    assert.strictEqual(isCtrlYokeQwenHookGroup(groupFor(process.pid)), false);
    assert.strictEqual(isCtrlYokeQwenHookGroup(groupFor(2147483647)), true);
  });

  test("registers Notification for a selected event", () => {
    const config = new QwenNotificationMonitor().buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [{ event: "notification", command: "node user.js" }],
      ["notification"]
    );
    const hooks = (config as { config: { hooks: Record<string, unknown[]> } })
      .config.hooks;

    assert.ok(hooks.Notification);
    assert.strictEqual(hooks.Notification.length, 1);
    const command = JSON.stringify(hooks.Notification);
    assert.ok(command.includes("script.js"));
    assert.ok(command.includes(`--ctrlyoke-owner-pid=${process.pid}`));
  });

  test("passes the decision hook only to PermissionRequest and never an empty argument", () => {
    const commandFor = (
      hooks: Record<string, unknown[]>,
      event: string
    ): string =>
      (hooks[event][0] as { hooks: Array<{ command: string }> }).hooks[0]
        .command;
    const buildHooks = (userHooks: UserHookConfig[]) =>
      (
        new QwenNotificationMonitor().buildHookConfig(
          "script.js",
          "notify-dir",
          "workspace",
          userHooks,
          ["stop", "permissionRequest"]
        ) as { config: { hooks: Record<string, unknown[]> } }
      ).config.hooks;

    const withoutDecision = buildHooks([]);
    for (const event of ["Stop", "PermissionRequest"]) {
      const command = commandFor(withoutDecision, event);
      assert.strictEqual(
        command,
        `node script.js notify-dir --ctrlyoke-owner-pid=${process.pid}`
      );
    }

    const withDecision = buildHooks([
      { event: "permissionRequest", command: "node decide.js" },
    ]);
    assert.strictEqual(
      commandFor(withDecision, "Stop"),
      `node script.js notify-dir --ctrlyoke-owner-pid=${process.pid}`
    );
    const permissionCommand = commandFor(withDecision, "PermissionRequest");
    assert.match(
      permissionCommand,
      new RegExp(`--ctrlyoke-owner-pid=${process.pid} \\S+$`)
    );
  });
});
