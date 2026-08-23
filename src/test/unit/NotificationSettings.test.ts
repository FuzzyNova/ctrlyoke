import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import Ajv from "ajv";
import { suite, test } from "mocha";
import {
  BROWSER_NOTIFICATION_MODES,
  HOOK_EVENT_METADATA,
  HOOK_EVENT_ORDER,
  NOTIFICATION_EVENT_MODES,
} from "../../types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";

suite("Notification settings defaults", () => {
  test("include the notifications group with phase 1 defaults", () => {
    const notifications = CTRLYOKE_SETTINGS_DEFAULTS.notifications;

    assert.strictEqual(notifications.vscode.enabled, true);
    assert.strictEqual(
      notifications.browser.mode,
      BROWSER_NOTIFICATION_MODES.NEVER
    );
    assert.strictEqual(
      notifications.events.workflowComplete,
      NOTIFICATION_EVENT_MODES.ALL
    );
    assert.strictEqual(
      notifications.events.promptComplete,
      NOTIFICATION_EVENT_MODES.NEVER
    );
    assert.strictEqual(notifications.events.hookEvents.notification, false);
    assert.strictEqual(notifications.includeWorkflowName, true);
    assert.strictEqual(notifications.includePromptName, true);
    assert.strictEqual(notifications.onlyWhenWindowUnfocused, true);
  });

  test("keeps hook event order and metadata aligned", () => {
    assert.deepStrictEqual(
      HOOK_EVENT_METADATA.map(({ event }) => event),
      HOOK_EVENT_ORDER
    );
    assert.deepStrictEqual(
      HOOK_EVENT_METADATA.find(({ event }) => event === "notification"),
      {
        event: "notification",
        label: "Notification",
        description:
          "Fires when the harness displays a notification, including prompts that may require user input.",
      }
    );
  });

  test("accepts the notification settings leaf without a schema default", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../schemas/settings-schema.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    const validate = new Ajv({ allErrors: true }).compile(schema);

    assert.strictEqual(
      validate({ notifications: { events: { hookEvents: { notification: true } } } }),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(
      validate({ notifications: { events: { hookEvents: { unknown: true } } } }),
      false
    );
    const notificationSchema = (
      (
        (
          (schema.properties as Record<string, any>).notifications.properties
            .events.properties.hookEvents.properties
        ) as Record<string, any>
      ).notification
    );
    assert.strictEqual(notificationSchema.type, "boolean");
    assert.strictEqual("default" in notificationSchema, false);
  });
});
