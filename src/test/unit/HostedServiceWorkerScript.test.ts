import * as assert from "assert";
import { suite, test } from "mocha";
import { SERVICE_WORKER_BADGE_MESSAGE_TYPES } from "../../types/DashboardConstants";
import {
  buildHostedServiceWorkerScript,
  renderHostedServiceWorkerScript,
} from "../../server/HostedServiceWorkerScript";

suite("HostedServiceWorkerScript", () => {
  test("renders shared badge message types into the template", () => {
    const rendered = renderHostedServiceWorkerScript(
      `
if (data.type === "__CTRLYOKE_CLEAR_BADGE_MESSAGE_TYPE__") {
  return "__CTRLYOKE_INCREMENT_BADGE_MESSAGE_TYPE__";
}
const icon = "__CTRLYOKE_NOTIFICATION_ICON_PATH__";
const badge = "__CTRLYOKE_NOTIFICATION_BADGE_PATH__";
`.trim()
    );

    assert.ok(
      rendered.includes(
        JSON.stringify(
          SERVICE_WORKER_BADGE_MESSAGE_TYPES.CLEAR_NOTIFICATION_BADGE
        )
      )
    );
    assert.ok(
      rendered.includes(
        JSON.stringify(
          SERVICE_WORKER_BADGE_MESSAGE_TYPES.INCREMENT_NOTIFICATION_BADGE
        )
      )
    );
  });

  test("loads the standalone service worker template without placeholder tokens", () => {
    const rendered = buildHostedServiceWorkerScript();

    assert.match(rendered, /self\.addEventListener\("push"/);
    assert.ok(!rendered.includes("__CTRLYOKE_CLEAR_BADGE_MESSAGE_TYPE__"));
    assert.ok(!rendered.includes("__CTRLYOKE_INCREMENT_BADGE_MESSAGE_TYPE__"));
  });
});
