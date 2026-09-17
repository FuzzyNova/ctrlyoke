import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { livePreviewSortingStrategy } from "@utils/dndKit";
import { ParallelGroupPanel } from "@components/prompts/ParallelGroupPanel";
import { useSettingsStore } from "@store/settingsStore";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";

/**
 * The displacement dnd-kit would hand a row mid-drag. The sign and size are
 * the real ones from the bug report: a whole parallel group's height, which is
 * what `verticalListSortingStrategy` gives the step sitting just past a group
 * being dragged over it.
 */
const DISPLACEMENT = { x: 0, y: -312, scaleX: 1, scaleY: 1 };
const TRANSITION = "transform 200ms ease";

// Only `useSortable` is replaced — `SortableContext` stays real so the group
// panel's own nested context still mounts. Every row and the group section are
// reported as displaced *and* animating, which is exactly the state the panel
// must ignore: it renders its own live preview in dragged order, so anything
// that reads these values double-counts the move.
vi.mock("@dnd-kit/sortable", async () => {
  const actual =
    await vi.importActual<typeof import("@dnd-kit/sortable")>(
      "@dnd-kit/sortable"
    );
  return {
    ...actual,
    useSortable: ({ id }: { id: string }) => ({
      attributes: { role: "button" },
      listeners: {},
      setNodeRef: () => {},
      transform: DISPLACEMENT,
      transition: TRANSITION,
      isDragging: id === "step-pending-0",
    }),
  };
});

const group: ParallelGroupDefinition = {
  id: "group-1",
  startIndex: 0,
  endIndex: 1,
  failFast: true,
};
const steps: WorkflowStep[] = [{ prompt: "first" }, { prompt: "second" }];

function renderSortableGroup() {
  return render(
    <ParallelGroupPanel
      group={group}
      steps={steps}
      currentStep={0}
      executionState={EXECUTION_STATES.IDLE}
      statuses={[STEP_STATUS.PENDING, STEP_STATUS.PENDING]}
      retryStates={{}}
      liveContextWindow={{}}
      canSetStartPosition
      memberIds={["step-pending-0", "step-pending-1"]}
      getLatestOutput={() => null}
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
      onFailFastChange={vi.fn()}
    />
  );
}

/** Every step row's body element — the one `WorkflowStepRowFrame` styles. */
function rowBodies(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-workflow-step-index] > div:last-child"
    )
  );
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
});

describe("live-preview drag positioning", () => {
  it("never moves a row body by dnd-kit's transform, which would strand its rail and number", () => {
    renderSortableGroup();

    const bodies = rowBodies();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      // The frame transforms the body alone, so honouring a displacement here
      // tears the row's content away from the identity rail and slot number
      // that stay behind in the untransformed frame — the reported
      // "colour bar below it and the step above it".
      expect(body.style.transform).toBe("");
    }
    // Both rows still render their own text, in place, under their own number.
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("never animates a row body, so a drop cannot fly back before settling", () => {
    renderSortableGroup();

    for (const body of rowBodies()) {
      // dnd-kit clears its transform the instant the drag ends. With a
      // transition attached, that clearing is a visible 200ms flight from
      // wherever the discarded transform had put the row back to the slot the
      // live preview had already placed it in.
      expect(body.style.transition).toBe("");
    }
  });

  it("keeps a dragged group panel in its previewed slot, faded rather than displaced", () => {
    renderSortableGroup();

    const section = screen.getByLabelText("Parallel steps 1 to 2");
    expect(section.style.transform).toBe("");
    expect(section.style.transition).toBe("");
  });

  it("fades only the row dnd-kit reports as dragging", () => {
    renderSortableGroup();

    const bodies = rowBodies();
    expect(bodies[0].style.opacity).toBe("0.5");
    expect(bodies[1].style.opacity).toBe("1");
  });
});

describe("livePreviewSortingStrategy", () => {
  /** The screenshot's arrangement: a group at slot 1, a step at slot 2. */
  const args: Parameters<SortingStrategy>[0] = {
    activeIndex: 1,
    overIndex: 2,
    index: 2,
    rects: [
      { top: 0, left: 0, right: 100, bottom: 60, width: 100, height: 60 },
      { top: 60, left: 0, right: 100, bottom: 372, width: 100, height: 312 },
      { top: 372, left: 0, right: 100, bottom: 432, width: 100, height: 60 },
    ],
    activeNodeRect: {
      top: 60,
      left: 0,
      right: 100,
      bottom: 372,
      width: 100,
      height: 312,
    },
  };

  it("displaces nothing, where the built-in strategy moves a step by a whole group", () => {
    // What used to happen: the step past the dragged group was thrown upward
    // by the group's full height while its rail and number stayed put.
    const builtIn = verticalListSortingStrategy(args);
    expect(builtIn?.y).toBeLessThanOrEqual(-312);

    expect(livePreviewSortingStrategy(args)).toBeNull();
  });

  it("displaces nothing for the dragged item's own slot either", () => {
    expect(
      livePreviewSortingStrategy({ ...args, index: args.activeIndex })
    ).toBeNull();
  });
});
