import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepsPanel } from "@components/layout/WorkflowStepsPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { MESSAGE_TYPES } from "@/types/messages";
import type { CollisionDetection } from "@dnd-kit/core";

type DragEventLike = { active: { id: string }; over: { id: string } | null };

const postMessage = vi.fn();

const dnd: {
  collisionDetection?: CollisionDetection;
  onDragStart?: () => void;
  onDragOver?: (event: DragEventLike) => void;
  onDragEnd?: (event: DragEventLike) => void;
} = {};

// Only `DndContext` is stubbed — the sortable children keep running against
// dnd-kit's real hooks, which fall back to their default (inactive) context.
// The stub is what lets a test drive the panel's own drag handlers, since a
// pointer drag needs layout that jsdom does not have.
vi.mock("@dnd-kit/core", async () => {
  const actual =
    await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: (props: {
      children?: ReactNode;
      collisionDetection?: CollisionDetection;
      onDragStart?: () => void;
      onDragOver?: (event: DragEventLike) => void;
      onDragEnd?: (event: DragEventLike) => void;
    }) => {
      dnd.collisionDetection = props.collisionDetection;
      dnd.onDragStart = props.onDragStart;
      dnd.onDragOver = props.onDragOver;
      dnd.onDragEnd = props.onDragEnd;
      return <>{props.children}</>;
    },
  };
});

/**
 * Feed the panel a drag position the way `DndContext` does — by running its
 * collision detection with a `collisionRect` at that offset. Everything else in
 * the args is inert: no droppable rects means the panel's own re-pointing rule
 * can't fire, so the caller's `over` id is what drives the drag.
 */
function measureDragAt(top: number): void {
  dnd.collisionDetection?.({
    active: {
      id: "step-pending-0",
      data: { current: undefined },
      rect: {
        current: { initial: null, translated: null },
      },
    },
    collisionRect: {
      top,
      bottom: top + 24,
      left: 0,
      right: 100,
      width: 100,
      height: 24,
    },
    droppableRects: new Map(),
    droppableContainers: [],
    pointerCoordinates: null,
  } as unknown as Parameters<CollisionDetection>[0]);
}

/** Visual order of the pending list, read as the absolute step index per row. */
function renderedOrder(): number[] {
  return Array.from(
    document.querySelectorAll("[data-workflow-step-index]")
  ).map((element) => Number(element.getAttribute("data-workflow-step-index")));
}

/** Reorder messages only — `postMessage` also carries WebviewLog traffic. */
function reorderMessages(): unknown[] {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string })
    .filter((message) => message.type === MESSAGE_TYPES.REORDER_PROMPTS);
}

function renderedPrompts(): string[] {
  return Array.from(
    document.querySelectorAll("[data-workflow-step-index]")
  ).map(
    (element) => element.textContent?.replace(/^\d+/, "").slice(0, 3) ?? ""
  );
}

describe("WorkflowStepsPanel drag lifecycle", () => {
  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useWorkflowStore.temporal.getState().clear();
    useEditorStore.getState().resetEditor();
    useSettingsStore.getState().resetSettings();
    useUiStore.getState().resetUi();
    useUiStore.setState({ stepsCollapsed: false });
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: {
        postMessage,
        getState: vi.fn(() => null),
        setState: vi.fn(),
      },
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "drag.prompt.md",
      steps: [
        { prompt: "aaa" },
        { prompt: "bbb" },
        { prompt: "ccc" },
        { prompt: "ddd" },
      ],
    });
  });

  afterEach(() => cleanup());

  // Re-ordering the list while the pointer is still down is what made the drop
  // look wrong: with no `DragOverlay` the dragged row is the real row, and
  // dnd-kit only keeps it under the cursor by re-measuring it after the
  // mutation — asynchronously — so the row (and its displaced neighbour) got
  // drawn a row-height out of place until the measurement landed.
  it("leaves the rendered order alone while a same-level drag is in flight", () => {
    render(<WorkflowStepsPanel />);
    expect(renderedOrder()).toEqual([0, 1, 2, 3]);

    act(() => {
      dnd.onDragOver?.({
        active: { id: "step-pending-0" },
        over: { id: "step-pending-1" },
      });
    });

    expect(renderedOrder()).toEqual([0, 1, 2, 3]);
    expect(reorderMessages()).toEqual([]);
  });

  it("applies the move on drop and keeps it across the confirm round trip", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragOver?.({
        active: { id: "step-pending-0" },
        over: { id: "step-pending-1" },
      });
      dnd.onDragEnd?.({
        active: { id: "step-pending-0" },
        over: { id: "step-pending-1" },
      });
    });

    expect(renderedPrompts()).toEqual(["bbb", "aaa", "ccc", "ddd"]);
    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [1, 0, 2, 3],
      }),
    ]);

    // REORDER_PROMPTS_CONFIRMED — the reordered steps coming back from the
    // extension must not move the list a second time.
    act(() => {
      useWorkflowStore
        .getState()
        .setPrompts([
          { prompt: "bbb" },
          { prompt: "aaa" },
          { prompt: "ccc" },
          { prompt: "ddd" },
        ]);
    });

    expect(renderedPrompts()).toEqual(["bbb", "aaa", "ccc", "ddd"]);
  });

  it("sends nothing when a step is dropped back where it started", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragEnd?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-2" },
      });
    });

    expect(renderedOrder()).toEqual([0, 1, 2, 3]);
    expect(reorderMessages()).toEqual([]);
  });
});

describe("WorkflowStepsPanel parallel group drag", () => {
  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useWorkflowStore.temporal.getState().clear();
    useEditorStore.getState().resetEditor();
    useSettingsStore.getState().resetSettings();
    useUiStore.getState().resetUi();
    useUiStore.setState({ stepsCollapsed: false });
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: {
        postMessage,
        getState: vi.fn(() => null),
        setState: vi.fn(),
      },
    });
    // A parallel group holding steps 0-1, then two ungrouped steps.
    useWorkflowStore.getState().loadWorkflow({
      fileName: "groups.prompt.md",
      steps: [
        { prompt: "aaa" },
        { prompt: "bbb" },
        { prompt: "ccc" },
        { prompt: "ddd" },
      ],
      parallelGroups: [
        { id: "g1", startIndex: 0, endIndex: 1, failFast: false },
      ],
    });
  });

  afterEach(() => cleanup());

  it("offers a drag handle on the group header", () => {
    render(<WorkflowStepsPanel />);
    expect(
      screen.getByLabelText("Drag to reorder parallel group")
    ).toBeTruthy();
  });

  it("moves the whole group when its header handle is dragged", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragEnd?.({
        active: { id: "group-g1" },
        over: { id: "step-pending-3" },
      });
    });

    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [2, 3, 0, 1],
        pendingGroups: [{ id: "g1", start: 2, end: 3, failFast: false }],
      }),
    ]);
  });

  it("drops a step above a leading group instead of into it", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "group-g1" },
      });
      dnd.onDragEnd?.({
        active: { id: "step-pending-2" },
        over: { id: "group-g1" },
      });
    });

    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [2, 0, 1, 3],
        pendingGroups: [{ id: "g1", start: 1, end: 2, failFast: false }],
      }),
    ]);
  });

  // A fold relocates the dragged row's DOM node, which reflows the list and
  // makes dnd-kit re-measure every droppable against a drag position that never
  // moved. The new rects can point `over` back at the side the row just left,
  // and `onDragOver` fires on every `over` change — an unbounded fold/re-measure
  // cycle that ends as React's "Maximum update depth exceeded" in the webview.
  it("folds a group crossing at most once per drag position", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragStart?.();
      measureDragAt(40);
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-1" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "bbb", "ddd"]);

    // Same drag position, `over` swinging back to a top-level slot: this is the
    // bounce, and it must not move the row again.
    act(() => {
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-3" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "bbb", "ddd"]);

    // A real pointer move re-arms folding.
    act(() => {
      measureDragAt(120);
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-3" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "bbb", "ccc", "ddd"]);
  });

  // The other half of the same oscillation: the fold that put the step into the
  // group pushes its row down past the group header, which on its own is enough
  // for the next collision to resolve to the group's own slot.
  it("does not fold a member back out over its own group's slot", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragStart?.();
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-1" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "bbb", "ddd"]);

    act(() => {
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "group-g1" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "bbb", "ddd"]);

    // Dropping there still means "leave the group and take its slot".
    act(() => {
      dnd.onDragEnd?.({
        active: { id: "step-pending-2" },
        over: { id: "group-g1" },
      });
    });
    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [2, 0, 1, 3],
        pendingGroups: [{ id: "g1", start: 1, end: 2, failFast: false }],
      }),
    ]);
  });

  it("still joins the group when the step is dropped on a member row", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-1" },
      });
    });
    // A group crossing is folded in while the pointer is down, so the step is
    // already rendered inside the group before the drop.
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "bbb", "ddd"]);

    act(() => {
      dnd.onDragEnd?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-1" },
      });
    });

    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [0, 2, 1, 3],
        pendingGroups: [{ id: "g1", start: 0, end: 2, failFast: false }],
      }),
    ]);
  });
});
