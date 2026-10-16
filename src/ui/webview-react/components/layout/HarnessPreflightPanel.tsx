import { HarnessIcon } from "@components/shared/HarnessIcon";
import { HARNESS_DISPLAY_NAMES } from "@components/shared/HarnessDropdown";
import { useSettingsStore } from "@store/settingsStore";
import {
  HARNESS_STATUS_STRINGS,
  HARNESS_VERSION_STATUSES,
} from "@/types/messages";
import { HARNESS_DISPLAY_ORDER } from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";
import { CopyButton } from "../shared/CopyButton";

/**
 * Non-blocking first-run guidance shown after every supported CLI has been
 * checked and none are available. Install and update commands originate with
 * each CLI provider and arrive with the existing harness-status payload; a CLI
 * that is installed but below its supported minimum shows its update command.
 */
export function HarnessPreflightPanel() {
  const harnessStatus = useSettingsStore((state) => state.harnessStatus);
  const statuses = HARNESS_DISPLAY_ORDER.map((id) => harnessStatus[id]);
  const isStillChecking = statuses.some(
    (status) => status?.status === HARNESS_STATUS_STRINGS.CHECKING
  );
  const hasAvailableHarness = statuses.some((status) => status?.available);

  if (isStillChecking || hasAvailableHarness) {
    return null;
  }

  return (
    <section
      className="mx-3 mt-3 rounded-sm border border-input-error-border bg-input-bg px-3 py-2 text-sm text-foreground"
      aria-label="Harness installation guidance"
    >
      <div className="flex items-center gap-2">
        <Icon name="warning" className="text-error-fg" />
        <p className="font-medium">No CLI coding agent is available</p>
      </div>
      <p className="mt-1 text-description-fg">
        ctrlyoke calls a CLI coding agent you have installed. Install or update
        one of the supported harnesses below, then sign in with that CLI before
        running a workflow.
      </p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {HARNESS_DISPLAY_ORDER.map((harnessId) => {
          const status = harnessStatus[harnessId];
          const isUnsupported =
            status?.version?.status === HARNESS_VERSION_STATUSES.UNSUPPORTED;
          const command = isUnsupported
            ? status?.version?.updateCommand
            : status?.installCommand;
          const displayName = HARNESS_DISPLAY_NAMES[harnessId];
          return (
            <li
              key={harnessId}
              className="flex min-w-0 items-center gap-1.5 rounded-sm bg-editor-bg px-2 py-1"
            >
              <HarnessIcon harnessId={harnessId} size={14} />
              <span className="shrink-0 text-xs font-medium">
                {displayName}
              </span>
              <code
                className="min-w-0 flex-1 truncate bg-code-block text-xxs text-description-fg"
                title={
                  isUnsupported
                    ? `${status?.version?.installedVersion} is below the supported minimum ${status?.version?.minimumVersion}. Update with: ${command}`
                    : command
                }
              >
                {command ?? "Installation command unavailable"}
              </code>
              {command && (
                <CopyButton
                  text={command}
                  label={`Copy ${isUnsupported ? "update" : "install"} command for ${displayName}`}
                  className="icon-btn shrink-0 py-0 px-0.5"
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
