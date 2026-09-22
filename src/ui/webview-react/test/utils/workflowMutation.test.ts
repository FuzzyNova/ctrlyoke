import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "@store/uiStore";
import {
  postRunLifecycleMutation,
  postSetStartPositionMutation,
} from "@utils/workflowMutation";
import { MESSAGE_TYPES } from "@/types/messages";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

const WORKFLOW_KEY = "wf-1" as never;

describe("postSetStartPositionMutation", () => {
  const postMessage = vi.fn();
  const target = { postMessage };

  beforeEach(() => {
    postMessage.mockClear();
    window.vscodeApi = window.acquireVsCodeApi?.();
    vi.mocked(window.vscodeApi?.postMessage ?? vi.fn()).mockClear();
    useUiStore.getState().resetUi();
  });

  it("posts SET_START_POSITION for a draft-kind displayed address", () => {
    const address = {
      workflowKey: WORKFLOW_KEY,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    };
    useUiStore.setState({
      displayedViewAddress: address,
      displayedDefinitionRevision: 1,
      displayedDescriptorRevision: 2,
    });

    const posted = postSetStartPositionMutation(target, {
      type: MESSAGE_TYPES.SET_START_POSITION,
      toIndex: 2,
    });

    expect(posted).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SET_START_POSITION,
      toIndex: 2,
      address,
      expectedDefinitionRevision: 1,
      expectedDescriptorRevision: 2,
    });
    expect(window.vscodeApi?.postMessage).not.toHaveBeenCalled();
  });

  it("still posts for a run-kind displayed address", () => {
    const address = {
      workflowKey: WORKFLOW_KEY,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-1" as never,
    };
    useUiStore.setState({
      displayedViewAddress: address,
      displayedDefinitionRevision: 3,
      displayedDescriptorRevision: 4,
    });

    const posted = postSetStartPositionMutation(target, {
      type: MESSAGE_TYPES.SET_START_POSITION,
      toIndex: 0,
    });

    expect(posted).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ address, toIndex: 0 })
    );
  });

  it("warns and does not post when nothing is displayed", () => {
    useUiStore.setState({
      displayedViewAddress: null,
      displayedDefinitionRevision: null,
      displayedDescriptorRevision: null,
    });

    const posted = postSetStartPositionMutation(target, {
      type: MESSAGE_TYPES.SET_START_POSITION,
      toIndex: 1,
    });

    expect(posted).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
        severity: "warning",
      })
    );
  });
});

describe("postRunLifecycleMutation", () => {
  const postMessage = vi.fn();
  const target = { postMessage };

  beforeEach(() => {
    postMessage.mockClear();
    useUiStore.getState().resetUi();
  });

  it("still rejects a draft-kind displayed address for run-only actions", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: WORKFLOW_KEY,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      displayedDefinitionRevision: 1,
      displayedDescriptorRevision: 1,
    });

    const posted = postRunLifecycleMutation(target, {
      type: MESSAGE_TYPES.DISCARD_CONTINUATION,
    });

    expect(posted).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
