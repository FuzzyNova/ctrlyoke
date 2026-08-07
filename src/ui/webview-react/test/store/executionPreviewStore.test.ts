import { beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { ExecutionPreviewResultMessage } from "@root/types/WebviewMessageTypes";
import type { WorkflowKey } from "@root/types/CtrlYokeTypes";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage }));

const workflowKey = "workflow-a" as WorkflowKey;
const address = { workflowKey, kind: "draft" } as const;
const preview = {
  workflow: {
    name: "Workflow A",
    stepCount: 1,
    harnessIds: [],
    totalByteCount: 0,
    totalTokenEstimate: 0,
    workspaceMutationCount: 0,
  },
  steps: [],
  diagnostics: [],
};

function result(
  requestToken: number,
  revision = 1
): ExecutionPreviewResultMessage {
  return {
    type: MESSAGE_TYPES.EXECUTION_PREVIEW_RESULT,
    requestToken,
    scope: { kind: "workflow" },
    address,
    displayedDefinitionRevision: revision,
    preview,
  };
}

describe("executionPreviewStore", () => {
  beforeEach(() => {
    useExecutionPreviewStore.getState().reset();
    sendMessage.mockClear();
  });

  it("sends exactly one request for each open", () => {
    const token = useExecutionPreviewStore
      .getState()
      .open({ kind: "workflow" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      MESSAGE_TYPES.REQUEST_EXECUTION_PREVIEW,
      { scope: { kind: "workflow" }, requestToken: token }
    );
  });

  it("clears the snapshot on close", () => {
    const token = useExecutionPreviewStore
      .getState()
      .open({ kind: "workflow" });
    useExecutionPreviewStore.getState().resolve(result(token));

    useExecutionPreviewStore.getState().close();

    expect(useExecutionPreviewStore.getState()).toMatchObject({
      preview: null,
      scope: null,
      requestToken: null,
      status: "checking",
    });
  });

  it("drops a late response for a superseded token", () => {
    const firstToken = useExecutionPreviewStore
      .getState()
      .open({ kind: "workflow" });
    useExecutionPreviewStore.getState().close();
    const currentToken = useExecutionPreviewStore
      .getState()
      .open({ kind: "workflow" });

    useExecutionPreviewStore.getState().resolve(result(firstToken));

    expect(useExecutionPreviewStore.getState()).toMatchObject({
      requestToken: currentToken,
      preview: null,
      status: "checking",
    });
  });

  it("marks the snapshot stale when a pushed definition revision advances", () => {
    const token = useExecutionPreviewStore
      .getState()
      .open({ kind: "workflow" });
    useExecutionPreviewStore.getState().resolve(result(token));

    useExecutionPreviewStore.getState().observeDefinitionRevision(address, 2);

    expect(useExecutionPreviewStore.getState().isStale).toBe(true);
  });
});
