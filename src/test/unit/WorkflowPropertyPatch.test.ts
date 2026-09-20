import * as assert from "assert";
import { restoreClearedWorkflowProperties } from "../../utils/WorkflowPropertyPatch";

suite("WorkflowPropertyPatch", () => {
  test("re-materializes the deletes JSON stripped off the patch", () => {
    // What the sender built and what actually crossed the wire.
    const sent = { worktree: false, trustedExternalRoots: undefined };
    const received = JSON.parse(JSON.stringify(sent));
    assert.ok(!("trustedExternalRoots" in received));

    const patch = restoreClearedWorkflowProperties(received, [
      "trustedExternalRoots",
    ]);

    assert.ok("trustedExternalRoots" in patch);
    assert.strictEqual(patch.trustedExternalRoots, undefined);
    assert.strictEqual(patch.worktree, false);
  });

  test("turns a patch that only clears into a non-empty write", () => {
    // handleUpdateWorkflowProperties returns early on an empty patch, so a
    // clear-only gesture (e.g. Trusted External Roots back to Inherit) has to
    // arrive with its key present or it persists nothing at all.
    const patch = restoreClearedWorkflowProperties({}, [
      "trustedExternalRoots",
    ]);

    assert.deepStrictEqual(Object.keys(patch), ["trustedExternalRoots"]);
  });

  test("leaves a patch alone when nothing is cleared", () => {
    const patch = restoreClearedWorkflowProperties({ model: "sonnet" }, []);

    assert.deepStrictEqual(patch, { model: "sonnet" });
  });

  test("treats a missing patch and a missing cleared list as empty", () => {
    assert.deepStrictEqual(
      restoreClearedWorkflowProperties(undefined, undefined),
      {}
    );
  });

  test("does not mutate the caller's patch", () => {
    const received = { model: "sonnet" };

    restoreClearedWorkflowProperties(received, ["agent"]);

    assert.deepStrictEqual(received, { model: "sonnet" });
  });
});
