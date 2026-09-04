import React from "react";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import { STEP_STATUS } from "@root/types/DashboardConstants";

interface ParallelOutputGroupHeaderProps {
  group: ParallelGroupDefinition;
  steps: readonly WorkflowStep[];
  activeStepIndices: readonly number[];
  hiddenTargetKeys: ReadonlySet<string>;
  onShowAll: () => void;
  onSoloTarget: (targetKey: string, allTargetKeys: readonly string[]) => void;
  onUndo?: () => void;
}

export const ParallelOutputGroupHeader: React.FC<
  ParallelOutputGroupHeaderProps
> = ({
  group,
  steps,
  activeStepIndices,
  hiddenTargetKeys,
  onShowAll,
  onSoloTarget,
  onUndo,
}) => {
  const members = Array.from(
    { length: group.endIndex - group.startIndex + 1 },
    (_, offset) => group.startIndex + offset
  );
  const getStatus = (index: number): string | undefined =>
    (steps[index] as (WorkflowStep & { status?: string }) | undefined)?.status;
  const running = members.filter(
    (index) =>
      activeStepIndices.includes(index) ||
      getStatus(index) === STEP_STATUS.RUNNING ||
      getStatus(index) === STEP_STATUS.SENT
  ).length;
  const complete = members.filter(
    (index) => getStatus(index) === STEP_STATUS.COMPLETED
  ).length;
  const failed = members.filter(
    (index) =>
      getStatus(index) === STEP_STATUS.FAILED ||
      getStatus(index) === STEP_STATUS.CANCELLED
  ).length;
  const targetKeys = members.map((index) => `queue:${index}`);
  const isAllVisible = targetKeys.every(
    (targetKey) => !hiddenTargetKeys.has(targetKey)
  );

  return (
    <div className="mx-2 mb-1 rounded border border-panel-border bg-sidebar-bg px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-foreground">
          Parallel steps {group.startIndex + 1}–{group.endIndex + 1}
        </span>
        <span className="text-description-fg">
          {running} running · {complete} complete · {failed} failed
        </span>
        {onUndo && (
          <button
            type="button"
            className="ml-auto text-link-fg hover:text-link-active-fg"
            onClick={onUndo}
          >
            Undo group
          </button>
        )}
      </div>
      <div
        className="mt-1 flex flex-wrap gap-1"
        role="group"
        aria-label="Output filters"
      >
        <button
          type="button"
          className={`rounded border px-1.5 py-0.5 ${
            isAllVisible
              ? "border-focus-border text-foreground"
              : "border-panel-border text-description-fg"
          }`}
          onClick={onShowAll}
          aria-pressed={isAllVisible}
        >
          All
        </button>
        {members.map((index) => {
          const targetKey = `queue:${index}`;
          const step = steps[index];
          const label = step?.name?.trim() || `Step ${index + 1}`;
          const selected =
            hiddenTargetKeys.size === targetKeys.length - 1 &&
            !hiddenTargetKeys.has(targetKey);
          return (
            <button
              key={targetKey}
              type="button"
              className={`rounded border px-1.5 py-0.5 ${
                selected
                  ? "border-focus-border text-foreground"
                  : "border-panel-border text-description-fg"
              }`}
              onClick={() => onSoloTarget(targetKey, targetKeys)}
              aria-pressed={selected}
            >
              {index + 1} {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
