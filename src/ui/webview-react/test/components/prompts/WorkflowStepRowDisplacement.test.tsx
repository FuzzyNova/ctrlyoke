import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SortableWorkflowStepWrapper } from "@components/prompts/WorkflowStepRow";
import { useSettingsStore } from "@store/settingsStore";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
import type { WorkflowStep } from "@store/workflowStore";

/**
 * A whole parallel group's height — the displacement from the bug report, and
 * what `verticalListSortingStrategy` hands the step sitting just past a group
 * being dragged over it.
 */
const TRANSFORM = { x: 0, y: -312, scaleX: 1, scaleY: 1 };
const TRANSFORM_CSS = "translate3d(0, -312px, 0)";
const TRANSITION = "transform 200ms ease";

/** What `useSortable` reports for the row under test, set per test. */
let sortableState: {
  transform: typeof TRANSFORM | null;
  transition: string | undefined;
  isSorting: boolean;
  isDragging: boolean;
};

vi.mock("@dnd-kit/sortable", async () => {
  const actual =
    await vi.importActual<typeof import("@dnd-kit/sortable")>(
      "@dnd-kit/sortable"
    );
  return {
    ...actual,
    useSortable: () => ({
      attributes: { role: "button" },
      listeners: {},
      setNodeRef: () => {},
      ...sortableState,
    }),
  };
});

const step: WorkflowStep = { prompt: "a step" };

function renderRow() {
  return render(
    <SortableWorkflowStepWrapper
      id="step-pending-1"
      disabled={false}
      slotNumber={6}
      step={step}
      index={1}
      currentStep={0}
      executionState={EXECUTION_STATES.IDLE}
      status={STEP_STATUS.PENDING}
      isCurrent={false}
      isSelected={false}
      canSetStartPosition
      startPositionDirection="forward"
      setPositionTarget={1}
      isExecutionTargetLocked={false}
      getStepHarnessModel={() => ({
        harnessId: undefined,
        harnessLabel: undefined,
        harnessIsDefault: true,
        modelLabel: undefined,
        modelIsDefault: true,
      })}
      getStepOverrides={() => []}
      onStepClick={vi.fn()}
      onSetStartPosition={vi.fn()}
      onOpenContextMenu={vi.fn()}
    />
  );
}

/** The frame wrapper, and the three columns it lays out side by side. */
function parts() {
  const frame = document.querySelector<HTMLElement>(
    "[data-workflow-step-index]"
  )!;
  const columns = Array.from(frame.children) as HTMLElement[];
  return {
    frame,
    rail: columns[0],
    number: columns[1],
    body: columns[columns.length - 1],
  };
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
  sortableState = {
    transform: TRANSFORM,
    transition: TRANSITION,
    isSorting: true,
    isDragging: false,
  };
});

describe("step row drag displacement", () => {
  it("carries the rail and number along with the body", () => {
    renderRow();
    const { rail, number, body } = parts();

    // Displacing the body alone strands the identity rail and the slot number
    // at the untransformed position — the reported "colour bar below it and
    // the step above it" when a parallel group is dragged past a step.
    expect(body.style.transform).toBe(TRANSFORM_CSS);
    expect(rail.style.transform).toBe(TRANSFORM_CSS);
    expect(number.style.transform).toBe(TRANSFORM_CSS);
    expect(screen.getByText("6")).toBeInTheDocument();
  });

  it("keeps the rail's identity colour while displacing it", () => {
    renderRow();
    // The rail's own `backgroundColor` and the displacement share one style
    // object, so neither may clobber the other.
    const { rail } = parts();
    expect(rail.style.transform).toBe(TRANSFORM_CSS);
    expect(rail.className).toContain("w-[2px]");
  });

  it("never transforms the frame itself, which would shift every measured rect", () => {
    renderRow();
    // dnd-kit measures droppables with `getTransformAgnosticClientRect`, which
    // inverts an element's *own* transform and nothing else. The body is the
    // droppable, so a transform hoisted onto its parent frame stays baked into
    // `getBoundingClientRect()` and silently moves the geometry the panel's
    // collision rules are tuned against.
    expect(parts().frame.style.transform).toBe("");
  });

  it("animates while the drag is in flight", () => {
    renderRow();
    const { rail, number, body } = parts();

    expect(body.style.transition).toBe(TRANSITION);
    expect(rail.style.transition).toBe(TRANSITION);
    expect(number.style.transition).toBe(TRANSITION);
  });

  it("drops the transition once the drag ends, so the row lands instead of flying back", () => {
    // Exactly what dnd-kit reports on release: the transform is cleared, and
    // the 200ms transform transition comes back in the same render because
    // `shouldAnimateLayoutChanges` outlives the drag. Honouring it animates the
    // row from its discarded displacement back to the slot the live preview had
    // already placed it in.
    sortableState = {
      transform: null,
      transition: TRANSITION,
      isSorting: false,
      isDragging: false,
    };
    renderRow();
    const { rail, number, body } = parts();

    expect(body.style.transition).toBe("");
    expect(rail.style.transition).toBe("");
    expect(number.style.transition).toBe("");
  });

  it("still fades the dragged row", () => {
    sortableState = { ...sortableState, isDragging: true };
    renderRow();
    expect(parts().body.style.opacity).toBe("0.5");
  });
});
