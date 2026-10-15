import { act, fireEvent, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUndoRedoKeyHandler } from "@hooks/useUndoRedoKeyHandler";
import { useWorkflowStore } from "@store/workflowStore";

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
});

describe("useUndoRedoKeyHandler", () => {
  it("redoes on Ctrl+Shift+Z when the browser reports uppercase Z", () => {
    const redo = vi
      .spyOn(useWorkflowStore.temporal.getState(), "redo")
      .mockImplementation(() => undefined);
    renderHook(() => useUndoRedoKeyHandler());

    act(() => {
      fireEvent.keyDown(document.body, {
        key: "Z",
        ctrlKey: true,
        shiftKey: true,
      });
    });

    expect(redo).toHaveBeenCalledOnce();
  });

  it("undoes on Ctrl+Z when the browser reports uppercase Z without Shift", () => {
    const undo = vi
      .spyOn(useWorkflowStore.temporal.getState(), "undo")
      .mockImplementation(() => undefined);
    renderHook(() => useUndoRedoKeyHandler());

    act(() => {
      fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true });
    });

    expect(undo).toHaveBeenCalledOnce();
  });
});
