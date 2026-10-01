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
      address: identity.address,
      events: [
        {
          target: identity.target,
          attemptIndex: identity.attemptIndex,
          runIndex: identity.runIndex,
          eventIndex: identity.eventIndex,
        },
      ],
    });
    const event = { type: "bashCommand", data: { output: "complete" } };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.TOOL_OUTPUT_CONTENT,
          requestId: sent[0].requestId,
          address: identity.address,
          events: [
            {
              target: identity.target,
              attemptIndex: identity.attemptIndex,
              runIndex: identity.runIndex,
              eventIndex: identity.eventIndex,
              event,
            },
          ],
        },
      })
    );
    await expect(first).resolves.toEqual(event);
    await expect(client.request(identity)).resolves.toEqual(event);
    expect(sent).toHaveLength(1);
  });

  it("sends several missing events in one request and caches every result", async () => {
    const sent: any[] = [];
    const client = new ToolOutputContentClient((message) => sent.push(message));
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const identities = [0, 1, 2].map((eventIndex) => ({
      address,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 3 } as const,
      attemptIndex: 2,
      runIndex: 5,
      eventIndex,
    }));
    const pending = client.requestMany(identities);
    expect(sent).toHaveLength(1);
    expect(sent[0].events).toHaveLength(3);
    const events = identities.map((identity, index) => ({
      target: identity.target,
      attemptIndex: identity.attemptIndex,
      runIndex: identity.runIndex,
      eventIndex: identity.eventIndex,
      event: { type: "text", data: { text: `full ${index}` } },
    }));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.TOOL_OUTPUT_CONTENT,
          requestId: sent[0].requestId,
          address,
          events,
        },
      })
    );
    await expect(pending).resolves.toEqual(
      events.map((result) => result.event)
    );
    await expect(client.requestMany(identities)).resolves.toEqual(
      events.map((result) => result.event)
    );
    expect(sent).toHaveLength(1);
  });
});
