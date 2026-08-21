import {
  HARNESS_IDS,
  type StatusLineTrackingHarnessId,
} from "@root/types/DashboardConstants";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { StatusLineTrackingControls } from "./stats/StatusLineTrackingControls";

const STATUS_LINE_HARNESS_IDS: StatusLineTrackingHarnessId[] = [
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.ANTIGRAVITY_CLI,
];

interface Props {
  settings: FullGlobalSettings;
}

export function StatusLineSection({ settings }: Props) {
  return (
    <section
      className="space-y-3"
      aria-labelledby="statusline-tracking-heading"
    >
      <div>
        <h3
          id="statusline-tracking-heading"
          className="text-xs font-semibold uppercase text-description-fg tracking-wide"
        >
          Statusline Tracking
        </h3>
        <p className="text-xs text-description-fg mt-1">
          Configure provider statusline integration to capture token, quota, and
          context-window metrics.
        </p>
      </div>
      <div className="space-y-3">
        {STATUS_LINE_HARNESS_IDS.map((harnessId) => (
          <StatusLineTrackingControls
            key={harnessId}
            harnessId={harnessId}
            settings={settings}
          />
        ))}
      </div>
    </section>
  );
}
