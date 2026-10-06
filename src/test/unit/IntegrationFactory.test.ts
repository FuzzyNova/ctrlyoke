import { INTERACTIVE_TERMINAL_MODES } from "../../types/DashboardConstants";
import * as assert from "assert";
import { suite, test } from "mocha";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { HarnessId } from "../../types/DashboardConstants";

const platform: PlatformAdapter = {
  interactiveTerminal: INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY,
    getWorkspaceRoot: () => "",
  getWorkspaceRoots: () => [],
  getNamedWorkspaceRoots: () => [],
  getExtensionPath: () => "",
};

suite("IntegrationFactory", () => {
  test("throws for unknown harness IDs", () => {
    const unknownHarness = "not-a-harness" as HarnessId;
    const factory = new IntegrationFactory(platform);

    assert.throws(
      () => factory.createForHarness(unknownHarness),
      /Unknown harness: not-a-harness/u
    );
    assert.throws(
      () => IntegrationFactory.createCapabilityProvider(unknownHarness),
      /Unknown harness: not-a-harness/u
    );
  });
});
