import React from "react";
import type { BackgroundWorkHoldData } from "../../types/cliEvents";
import {
  getBackgroundTaskLabel,
  getBackgroundWorkHoldHeadline,
} from "@root/utils/BackgroundWorkHoldText";
import { formatTime } from "@utils/outputUtils";
import { Icon } from "../shared/Icon";

/**
 * A Stop hook the step deliberately ignored because the harness still had
 * background work pending. The hold has no time limit, so this row is the
 * only on-screen explanation of why the step is still running and which
 * background task(s) it is waiting on.
 *
 * Every line is single-line and truncated so `estimateBackgroundWorkHoldHeight`
 * can size the row from its line count alone.
 */
export const BackgroundWorkHoldOutput: React.FC<{
  data: BackgroundWorkHoldData;
}> = ({ data }) => {
  const heldAtLabel = data.heldAt ? formatTime(data.heldAt) : "";
  return (
    <div className="my-2" data-testid="background-work-hold">
      <div className="flex items-center gap-1.5 min-w-0 text-[length:var(--cy-output-font-size-xs)] text-warning-fg">
        <Icon name="watch" className="text-xxs shrink-0" />
        <span className="truncate">
          {getBackgroundWorkHoldHeadline(data)}
          {heldAtLabel ? ` — ${heldAtLabel}` : ""}
        </span>
      </div>
      {data.pendingTasks.length > 0 && (
        <ul className="mt-1 pl-3 border-l border-warning-fg/50">
          {data.pendingTasks.map((task, index) => {
            const { name, meta, command } = getBackgroundTaskLabel(task);
            return (
              <li key={task.taskId ?? index} className="min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="truncate text-editor-fg">{name}</span>
                  {meta && (
                    <span className="shrink-0 text-description-fg">{meta}</span>
                  )}
                </div>
                {command && (
                  <div className="truncate text-description-fg" title={command}>
                    $ {command}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
