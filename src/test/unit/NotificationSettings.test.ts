import * as assert from "assert";
import { suite, test } from "mocha";
import {
  BROWSER_NOTIFICATION_MODES,
  NOTIFICATION_EVENT_MODES,
} from "../../types/DashboardConstants";
import { FLIGHTPATH_SETTINGS_DEFAULTS } from "../../types/FlightPathSettings";

suite("Notification settings defaults", () => {
  test("include the notifications group with phase 1 defaults", () => {
    const notifications = FLIGHTPATH_SETTINGS_DEFAULTS.notifications;

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
    assert.strictEqual(notifications.includeWorkflowName, true);
    assert.strictEqual(notifications.includePromptName, true);
    assert.strictEqual(notifications.onlyWhenWindowUnfocused, true);
  });
});
