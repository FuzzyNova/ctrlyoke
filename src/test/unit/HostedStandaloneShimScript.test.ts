import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HOSTED_CONNECTION_LIVENESS,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import {
  buildHostedStandaloneShimScript,
  renderHostedStandaloneShimScript,
} from "../../server/HostedStandaloneShimScript";

suite("HostedStandaloneShimScript", () => {
  test("renders shared liveness configuration into the template", () => {
    const rendered = renderHostedStandaloneShimScript(
      'const config = "__CTRLYOKE_HOSTED_CONNECTION_CONFIG__";'
    );

    assert.ok(
      rendered.includes(
        JSON.stringify(MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT)
      )
    );
    assert.ok(
      rendered.includes(
        JSON.stringify(MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK)
      )
    );
    assert.ok(
      rendered.includes(
        `"CLIENT_STALE_TIMEOUT_MS":${HOSTED_CONNECTION_LIVENESS.CLIENT_STALE_TIMEOUT_MS}`
      )
    );
  });

  test("loads the standalone shim without placeholder tokens", () => {
    const rendered = buildHostedStandaloneShimScript();

    assert.match(rendered, /function checkInboundLiveness\(\)/);
    assert.ok(!rendered.includes("__CTRLYOKE_HOSTED_CONNECTION_CONFIG__"));
  });
});
