import { describe, expect, it } from "vitest";
import { MESSAGE_TYPES, FINAL_STEP_PHASES } from "@/types/messages";
import type { WorkflowKey, RunRef } from "@root/types/CtrlYokeTypes";
import { ToolOutputContentClient } from "@hooks/useToolOutputContent";

describe("ToolOutputContentClient", () => {
  it("matches replies and caches by run, attempt, and aggregate event index", async () => {
    const sent: any[] = [];
    const client = new ToolOutputContentClient(
      (message) => sent.push(message),
      () => `request-${sent.length + 1}`
    );
    const identity = {
      address: {
        workflowKey: "workflow-a" as WorkflowKey,
        runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
      },
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 3 } as const,
      attemptIndex: 2,
      runIndex: 5,
      eventIndex: 8,
    };
    const first = client.request(identity);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT,
      ...identity,
    });
    const event = { type: "bashCommand", data: { output: "complete" } };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.TOOL_OUTPUT_CONTENT,
          requestId: sent[0].requestId,
          ...identity,
          event,
        },
      })
    );
    await expect(first).resolves.toEqual(event);
    await expect(client.request(identity)).resolves.toEqual(event);
    expect(sent).toHaveLength(1);
  });
});
