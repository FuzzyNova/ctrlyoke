import { useEffect, useState } from "react";
import {
  HARNESS_IDS,
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
  type StatusLineTrackingHarnessId,
} from "@root/types/DashboardConstants";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { AnimatedSection } from "@components/shared/AnimatedSection";
import { SettingToggleRow } from "@components/shared/SettingToggleRow";
import { sendMessage } from "@hooks/useMessageHandler";
import { StatusLineFormatEditor } from "./stats/StatusLineFormatEditor";
import { StatusLineTrackingControls } from "./stats/StatusLineTrackingControls";

const STATUS_LINE_HARNESS_IDS: StatusLineTrackingHarnessId[] = [
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.ANTIGRAVITY_CLI,
];

interface Props {
  settings: FullGlobalSettings;
}

export function StatusLineSection({ settings }: Props) {
  const { useDifferentFormatPerHarness, sharedFormat } =
    settings.settings.permissions.statusLineTracking;
  const [sharedDraft, setSharedDraft] = useState(sharedFormat);

  useEffect(() => {
    setSharedDraft(sharedFormat);
  }, [sharedFormat]);

  const sendGlobalSetting = (path: string, value: unknown): void => {
    sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
      path,
      value,
      scope: SETTING_SCOPES.USER,
    });
  };

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
        <SettingToggleRow
          label="Use a different status line format per harness"
          checked={useDifferentFormatPerHarness}
          onChange={(useDifferentFormatPerHarness) =>
            sendMessage(MESSAGE_TYPES.SET_STATUS_LINE_FORMAT_MODE, {
              useDifferentFormatPerHarness,
            })
          }
          path={
            SETTING_PATHS.PERMISSIONS_STATUS_LINE_TRACKING_USE_DIFFERENT_FORMAT_PER_HARNESS
          }
          sources={settings.sources}
          onReset={(path) => sendGlobalSetting(path, undefined)}
          activeScope={SETTING_SCOPES.USER}
        />
        <AnimatedSection visible={!useDifferentFormatPerHarness}>
          <StatusLineFormatEditor
            format={sharedFormat}
            onCommit={(format) =>
              sendGlobalSetting(
                SETTING_PATHS.PERMISSIONS_STATUS_LINE_TRACKING_SHARED_FORMAT,
                format
              )
            }
            onDraftChange={setSharedDraft}
            hidePreview
            title="Shared status line format"
          />
        </AnimatedSection>
        {STATUS_LINE_HARNESS_IDS.map((harnessId) => (
          <StatusLineTrackingControls
            key={harnessId}
            harnessId={harnessId}
            settings={settings}
            sharedDraft={sharedDraft}
            useDifferentFormatPerHarness={useDifferentFormatPerHarness}
          />
        ))}
      </div>
    </section>
  );
}
