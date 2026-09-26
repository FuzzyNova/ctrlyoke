import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getCoordinationAttribution,
  resolveCoordinationParticipantKind,
} from "../../utils/CoordinationAttribution";

suite("CoordinationAttribution", () => {
  test("uses participant kind and attestation for shared descriptions", () => {
    assert.deepStrictEqual(
      getCoordinationAttribution("step", true, "ctrlyoke-step"),
      { label: "step", description: "attested ctrlyoke step" }
    );
    assert.deepStrictEqual(
      getCoordinationAttribution("skill", false, "ctrlyoke-step"),
      { label: "skill", description: "unattested ctrlyoke step (skill/CLI)" }
    );
    assert.deepStrictEqual(
      getCoordinationAttribution("external", false, "external"),
      { label: "external", description: "unattested external session" }
    );
  });

  test("infers a legacy participant kind from its address", () => {
    assert.strictEqual(
      resolveCoordinationParticipantKind(undefined, {
        workflowKey: "workflow" as never,
        runRef: "run" as never,
      }),
      "ctrlyoke-step"
    );
    assert.strictEqual(resolveCoordinationParticipantKind(undefined), "external");
    assert.strictEqual(
      resolveCoordinationParticipantKind("external", {
        workflowKey: "workflow" as never,
        runRef: "run" as never,
      }),
      "external"
    );
  });
});
