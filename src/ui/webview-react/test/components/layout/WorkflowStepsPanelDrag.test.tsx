import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepsPanel } from "@components/layout/WorkflowStepsPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { MESSAGE_TYPES } from "@/types/messages";
import { PENDING_TAIL_DRAG_ID } from "@utils/dndKit";
import type { CollisionDetection } from "@dnd-kit/core";

type DragEventLike = {
  active: {
    id: string;
    rect?: {
      current: {
        initial: { top: number; left: number; width: number } | null;
        translated: unknown;
      };
    };
  };
  over: { id: string } | null;
};

/**
 * The dragged row's measured rect at drag start — `WorkflowStepsPanel` reads
 * `active.rect.current.initial` in `onDragStart` to position its hand-rolled
 * overlay clone (see the comment above `dragOverlayRect` there for why it
 * doesn't use dnd-kit's own `<DragOverlay>`). `null` is a legitimate value
 * (unmeasured), matching what real dnd-kit reports in an environment without
 * layout, same as jsdom here.
 */
function mockActive(id: string): DragEventLike["active"] {
  return { id, rect: { current: { initial: null, translated: null } } };
}

const postMessage = vi.fn();

const dnd: {
  collisionDetection?: CollisionDetection;
  onDragStart?: (event: DragEventLike) => void;
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
      onDragStart?: (event: DragEventLike) => void;
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

  // Every drag — not just one crossing a group boundary — recomputes a full
  // live preview on every `dragOver`, via a `DragOverlay` that decouples the
  // cursor-follow motion from the real list's re-layout. This is what lets a
  // row's displayed number/color always match its current slot instead of the
  // identity it started the drag with (see `WorkflowStepsPanel identity
  // rails` in WorkflowStepsPanel.test.tsx), while still sending nothing until
  // the drop.
  it("live-renumbers a same-level drag as soon as it starts", () => {
    render(<WorkflowStepsPanel />);
    expect(renderedOrder()).toEqual([0, 1, 2, 3]);

    act(() => {
      dnd.onDragStart?.({ active: mockActive("step-pending-0"), over: null });
      dnd.onDragOver?.({
        active: { id: "step-pending-0" },
        over: { id: "step-pending-1" },
      });
    });

    expect(renderedOrder()).toEqual([1, 0, 2, 3]);
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

  // Recomputing the live preview reflows the list (a row's DOM node can move
  // between nested `SortableContext`s), which makes dnd-kit re-measure every
  // droppable against a drag position that never moved. The new rects can
  // point `over` back at the side the row just left, and `onDragOver` fires on
  // every `over` change — an unbounded recompute/re-measure cycle that ends as
  // React's "Maximum update depth exceeded" in the webview unless capped.
  it("updates the preview at most once per drag position", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragStart?.({ active: mockActive("step-pending-2"), over: null });
      measureDragAt(40);
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-1" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "bbb", "ddd"]);

    // Same drag position, `over` swinging back to a different slot: this is
    // the bounce, and it must not update the preview again.
    act(() => {
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-3" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "bbb", "ddd"]);

    // A real pointer move re-arms the update. Dropping "ccc" onto "ddd"'s slot
    // takes that slot, pushing "ddd" up to where "ccc" started — the live
    // preview always reflects what dropping right now would apply, computed
    // fresh from the committed order rather than layered on the bounce above.
    act(() => {
      measureDragAt(120);
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-3" },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "bbb", "ddd", "ccc"]);
  });

  // Dropping directly on a leading group's own slot means "take the group's
  // slot", pushing the group down — same as a plain step dropped there (see
  // "moves a step above a leading group..." in WorkflowStepsPanel.test.tsx),
  // and the live preview reflects that immediately, not just on drop.
  it("moves a member above its own group when hovering the group's own slot", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragStart?.({ active: mockActive("step-pending-2"), over: null });
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
    expect(renderedPrompts()).toEqual(["ccc", "aaa", "bbb", "ddd"]);

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
      dnd.onDragStart?.({ active: mockActive("step-pending-2"), over: null });
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

  // The reported bug: a step dragged to the *first* slot of a parallel group
  // snapped back instead of landing. Once the live preview folds the row in,
  // the row is rendered at that slot — so the pointer is now over the dragged
  // row's own droppable and dnd-kit reports `over` as the active id. Read as a
  // drop target that resolves to the untouched committed baseline, i.e. the
  // row jumping back out of the group to where the drag began. It bites the
  // first slot hardest on an upward drag, where the previewed row lands
  // squarely under the pointer and every frame cancelled the one before it.
  it("keeps the preview folded in when the dragged row is reported as its own target", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragStart?.({ active: mockActive("step-pending-2"), over: null });
      measureDragAt(40);
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-0" },
      });
    });
    expect(renderedPrompts()).toEqual(["ccc", "aaa", "bbb", "ddd"]);

    // A real pointer move (so the repeated-position guard is not what rejects
    // this) that resolves back to the dragged row itself.
    act(() => {
      measureDragAt(48);
      dnd.onDragOver?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-2" },
      });
    });
    expect(renderedPrompts()).toEqual(["ccc", "aaa", "bbb", "ddd"]);

    act(() => {
      dnd.onDragEnd?.({
        active: { id: "step-pending-2" },
        over: { id: "step-pending-2" },
      });
    });

    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [2, 0, 1, 3],
        pendingGroups: [{ id: "g1", start: 0, end: 2, failFast: false }],
      }),
    ]);
  });

  it("renders no tail slot when the group does not end the list", () => {
    render(<WorkflowStepsPanel />);
    expect(screen.queryByTestId("pending-tail-drop-slot")).toBeNull();
  });
});

describe("WorkflowStepsPanel trailing parallel group drag", () => {
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
    // Two ungrouped steps, then a parallel group that ends the list.
    useWorkflowStore.getState().loadWorkflow({
      fileName: "trailing-group.prompt.md",
      steps: [
        { prompt: "aaa" },
        { prompt: "bbb" },
        { prompt: "ccc" },
        { prompt: "ddd" },
      ],
      parallelGroups: [
        { id: "g1", startIndex: 2, endIndex: 3, failFast: false },
      ],
    });
  });

  afterEach(() => cleanup());

  it("renders a tail slot below the group", () => {
    render(<WorkflowStepsPanel />);
    expect(screen.getByTestId("pending-tail-drop-slot")).toBeTruthy();
  });

  // The reported bug: dragging a step down past a trailing group absorbed it
  // into the group, and the only slot it could then be released to was the
  // group's own — which is the position *above* the group, because the group
  // keeps that position when a step leaves it.
  it("drops a step below a trailing group instead of back above it", () => {
    render(<WorkflowStepsPanel />);
    expect(renderedPrompts()).toEqual(["aaa", "bbb", "ccc", "ddd"]);

    act(() => {
      dnd.onDragStart?.({ active: mockActive("step-pending-0"), over: null });
      measureDragAt(40);
      dnd.onDragOver?.({
        active: { id: "step-pending-0" },
        over: { id: "step-pending-3" },
      });
    });
    // On the way down the step is absorbed into the group it passes over.
    expect(renderedPrompts()).toEqual(["bbb", "ccc", "aaa", "ddd"]);

    act(() => {
      measureDragAt(160);
      dnd.onDragOver?.({
        active: { id: "step-pending-0" },
        over: { id: PENDING_TAIL_DRAG_ID },
      });
    });
    // Clearing the last member releases it again, below the group — folding
    // the crossing in is also what keeps the row animated, since `over` is an
    // outer id while the row still lives in the group's nested context.
    expect(renderedPrompts()).toEqual(["bbb", "ccc", "ddd", "aaa"]);

    act(() => {
      dnd.onDragEnd?.({
        active: { id: "step-pending-0" },
        over: { id: PENDING_TAIL_DRAG_ID },
      });
    });

    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [1, 2, 3, 0],
        pendingGroups: [{ id: "g1", start: 1, end: 2, failFast: false }],
      }),
    ]);
  });

  // An ungrouped step heading straight for the tail never enters the group —
  // it lands after it — and the live preview shows exactly that immediately,
  // not just on drop.
  it("sends a tail drop that never entered the group", () => {
    render(<WorkflowStepsPanel />);

    act(() => {
      dnd.onDragStart?.({ active: mockActive("step-pending-1"), over: null });
      measureDragAt(40);
      dnd.onDragOver?.({
        active: { id: "step-pending-1" },
        over: { id: PENDING_TAIL_DRAG_ID },
      });
    });
    expect(renderedPrompts()).toEqual(["aaa", "ccc", "ddd", "bbb"]);

    act(() => {
      dnd.onDragEnd?.({
        active: { id: "step-pending-1" },
        over: { id: PENDING_TAIL_DRAG_ID },
      });
    });

    expect(reorderMessages()).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [0, 2, 3, 1],
        pendingGroups: [{ id: "g1", start: 1, end: 2, failFast: false }],
      }),
    ]);
  });
});
