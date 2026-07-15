import { HarnessIcon } from "@components/shared/HarnessIcon";
import {
  HARNESS_DISPLAY_NAMES,
  SUPPORTED_HARNESSES,
} from "@components/shared/HarnessDropdown";
import { useSettingsStore } from "@store/settingsStore";
import { HARNESS_STATUS_STRINGS } from "@/types/messages";

/**
 * Non-blocking first-run guidance shown after every supported CLI has been
 * checked and none are available. Install commands originate with each CLI
 * provider and arrive with the existing harness-status payload.
 */
export function HarnessPreflightPanel() {
  const harnessStatus = useSettingsStore((state) => state.harnessStatus);
  const statuses = SUPPORTED_HARNESSES.map((id) => harnessStatus[id]);
  const isStillChecking = statuses.some(
    (status) => status?.status === HARNESS_STATUS_STRINGS.CHECKING
  );
  const hasAvailableHarness = statuses.some((status) => status?.available);

  if (isStillChecking || hasAvailableHarness) {
    return null;
  }

  return (
    <section
      className="mx-3 mt-3 rounded border border-input-error-border bg-input-bg px-3 py-2 text-sm text-foreground"
      aria-label="Harness installation guidance"
    >
      <div className="flex items-center gap-2">
        <i className="codicon codicon-warning text-error-fg" />
        <p className="font-medium">No AI harness CLI is available</p>
      </div>
      <p className="mt-1 text-description-fg">
        ctrlyoke runs an installed AI coding CLI. Install one of the supported
        harnesses below, then sign in with that CLI before running a workflow.
      </p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {SUPPORTED_HARNESSES.map((harnessId) => {
          const status = harnessStatus[harnessId];
          return (
            <li
              key={harnessId}
              className="flex min-w-0 items-center gap-1.5 rounded bg-editor-bg px-2 py-1"
            >
              <HarnessIcon harnessId={harnessId} size={14} />
              <span className="shrink-0 text-xs font-medium">
                {HARNESS_DISPLAY_NAMES[harnessId]}
              </span>
              <code className="min-w-0 truncate text-xxs text-description-fg">
                {status?.installHint ?? "Installation command unavailable"}
              </code>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
