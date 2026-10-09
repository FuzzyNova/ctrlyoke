import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentPreviewModal } from "@components/shared/ContentPreviewModal";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

describe("ContentPreviewModal", () => {
  afterEach(() => {
    act(() => {
      useUiStore.getState().setContentPreviewModal(null);
      useWorkspaceViewerStore.setState({ isOpen: false });
    });
  });

  const openPreview = () =>
    act(() => {
      useUiStore.getState().setContentPreviewModal({
        title: "$previous — Prior Context",
        content: "<priorContext />",
        language: "xml",
        ref: "previous",
      });
    });

  it("uses the normal modal layer when the workspace viewer is closed", () => {
    render(<ContentPreviewModal />);
    openPreview();
    expect(document.querySelector(".z-modal")).not.toBeNull();
    expect(document.querySelector(".z-viewer-modal")).toBeNull();
  });

  it("renders above the workspace viewer when a chip in it opened the preview", () => {
    useWorkspaceViewerStore.setState({ isOpen: true });
    render(<ContentPreviewModal />);
    openPreview();
    expect(document.querySelector(".z-viewer-modal")).not.toBeNull();
  });
});
