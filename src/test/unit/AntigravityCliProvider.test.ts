import * as assert from "assert";
import { suite, test } from "mocha";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";

suite("AntigravityCliProvider", () => {
  test("retains hook artifacts while its process can receive injected turns", () => {
    const provider = new AntigravityCliProvider();

    assert.strictEqual(provider.shouldRetainWorkflowArtifactsForReuse(), true);
  });
});
