import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { CopilotNotificationMonitor } from "../../core/harness/copilot/CopilotNotificationMonitor";

suite("CopilotNotificationMonitor", () => {
  test("extracts hook error text from the captured Copilot payload", () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../src/test/fixtures/harness-errors/copilot/erroroccurred-hook-input.json"), "utf8"));
    assert.match(new CopilotNotificationMonitor().describeHookError(fixture) ?? "", /Failed native model HTTP request/);
  });
  test("registers lowercase notification and preserves a separate user command", () => {
    const config = new CopilotNotificationMonitor().buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [{ event: "notification", command: "node user.js" }],
      ["notification"]
    );
    const hooks = (config as { config: { hooks: Record<string, unknown[]> } })
      .config.hooks;

    assert.strictEqual(hooks.notification.length, 2);
    assert.ok(
      (hooks.notification[0] as { bash: string }).bash.includes(
        '"notification"'
      )
    );
    assert.strictEqual(
      (hooks.notification[1] as { bash: string }).bash,
      "node user.js"
    );
    // Only user commands are pinned to the workspace; ctrlyoke's own hook
    // command uses absolute paths and runs wherever Copilot starts it.
    assert.strictEqual(
      (hooks.notification[1] as { cwd?: string }).cwd,
      "workspace"
    );
    assert.strictEqual(
      (hooks.notification[0] as { cwd?: string }).cwd,
      undefined
    );
  });

  test("uses the lowercase native key in a user-only config", () => {
    const config = CopilotNotificationMonitor.buildUserOnlyConfig(
      [{ event: "notification", command: "node user.js" }],
      "workspace"
    );
    const hooks = config.hooks as Record<string, unknown[]>;

    assert.strictEqual(hooks.notification.length, 1);
    assert.strictEqual(
      (hooks.notification[0] as { bash: string }).bash,
      "node user.js"
    );
    assert.strictEqual(
      (hooks.notification[0] as { cwd?: string }).cwd,
      "workspace"
    );
  });

  test("passes the base64 permission-request user hook to ctrlyoke's hook", () => {
    const config = new CopilotNotificationMonitor().buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [{ event: "permissionRequest", command: "node decide.js" }],
      ["permissionRequest"]
    );
    const hooks = (
      config as {
        config: { hooks: Record<string, Array<{ bash: string }>> };
      }
    ).config.hooks;
    const encoded = Buffer.from("node decide.js", "utf8").toString("base64");

    // The decision hook rides on ctrlyoke's own entry; it is not appended as
    // a separate user entry.
    assert.strictEqual(hooks.permissionRequest.length, 1);
    assert.strictEqual(
      hooks.permissionRequest[0].bash,
      `node "script.js" "notify-dir" "permissionRequest" "${encoded}"`
    );
  });

  test("preserves per-hook timeoutSec in seconds", () => {
    const config = CopilotNotificationMonitor.buildUserOnlyConfig(
      [{ event: "stop", command: "node slow.js", timeoutSec: 13 }],
      "workspace"
    );
    const hooks = config.hooks as Record<string, Array<{ timeoutSec: number }>>;
    assert.strictEqual(hooks.agentStop[0].timeoutSec, 13);
  });
});
