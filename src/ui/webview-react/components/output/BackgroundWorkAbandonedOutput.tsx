import React from "react";
import type { BackgroundWorkAbandonedData } from "../../types/cliEvents";
import { getBackgroundWorkAbandonedNotice } from "@root/utils/BackgroundWorkHoldText";
import { Icon } from "../shared/Icon";

/** Display-only warning that pending work was stopped with a headless session. */
export const BackgroundWorkAbandonedOutput: React.FC<{
  data: BackgroundWorkAbandonedData;
}> = ({ data }) => (
  <div className="my-2" data-testid="background-work-abandoned">
    <div className="flex items-center gap-1.5 min-w-0 text-(length:--cy-output-font-size-xs) text-warning-fg">
      <Icon name="warning" className="text-xxs shrink-0" />
      <span>{getBackgroundWorkAbandonedNotice(data.pendingTasks)}</span>
    </div>
  </div>
);
