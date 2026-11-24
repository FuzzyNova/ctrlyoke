import { HarnessIcon } from "@components/shared/HarnessIcon";
import { HARNESS_DISPLAY_NAMES } from "@utils/harnessDisplayNames";
import { useHarnessDetectionRetry } from "@hooks/useHarnessDetectionRetry";
import { useSettingsStore } from "@store/settingsStore";
import { HARNESS_STATUS_STRINGS } from "@/types/messages";
import { HARNESS_DISPLAY_ORDER } from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";
import { CopyButton } from "../shared/CopyButton";

/**
 * Non-blocking first-run guidance shown after every supported CLI has been
 * checked and none are available. Install commands originate with each CLI
 * provider and arrive with the existing harness-status payload. "Check again"
 * re-detects every CLI; the panel unmounts by itself once one is available.
 */
export function HarnessPreflightPanel() {
  const harnessStatus = useSettingsStore((state) => state.harnessStatus);
  const { retrying, retry } = useHarnessDetectionRetry();
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
        <p className="flex-1 font-medium">No CLI coding agent is available</p>
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          aria-label={
            retrying ? "Checking for CLI coding agents" : "Check again"
          }
          title="Detect installed CLI coding agents again"
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm border border-panel-border px-2 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          <Icon
            name={retrying ? "loading" : "refresh"}
            className={`text-xxs ${retrying ? "codicon-modifier-spin" : ""}`}
          />
          {retrying ? "Checking…" : "Check again"}
        </button>
      </div>
      <p className="mt-1 text-description-fg">
        ctrlyoke calls a CLI coding agent you have installed. Install or update
        one of the supported harnesses below, sign in with that CLI, then choose
        Check again.
      </p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {HARNESS_DISPLAY_ORDER.map((harnessId) => {
          const status = harnessStatus[harnessId];
          const command = status?.installCommand;
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
                title={command}
              >
                {command ?? "Installation command unavailable"}
              </code>
              {command && (
                <CopyButton
                  text={command}
                  label={`Copy install command for ${displayName}`}
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
