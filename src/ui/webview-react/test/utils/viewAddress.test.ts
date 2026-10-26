import { describe, expect, it } from "vitest";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";
import { workflowRunAddress, workflowViewAddressKey } from "@utils/viewAddress";

describe("workflowRunAddress", () => {
  it("builds the run address of a summary with a run identity", () => {
    expect(
      workflowRunAddress({
        workflowKey: "workflow-1" as never,
        runRef: "run-1" as never,
      })
    ).toEqual({
      workflowKey: "workflow-1",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-1",
    });
  });

  it("returns null until the summary has both workflow key and run", () => {
    expect(workflowRunAddress({ workflowKey: "workflow-1" as never })).toBe(
      null
    );
    expect(workflowRunAddress({ runRef: "run-1" as never })).toBe(null);
  });
});

describe("workflowViewAddressKey", () => {
  it("uses the workflow and run reference for run addresses", () => {
    expect(
      workflowViewAddressKey({
        workflowKey: "workflow-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-1" as never,
      })
    ).toBe("workflow-1:run:run-1");
  });

  it("uses the workflow key for draft addresses", () => {
    expect(
      workflowViewAddressKey({
        workflowKey: "workflow-1" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      })
    ).toBe("workflow-1:draft");
  });
});
