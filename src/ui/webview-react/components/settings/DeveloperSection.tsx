import { useEffect, useState } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@/types/messages";
import { Button } from "@components/shared/Button";
import { SettingToggleRow } from "@components/shared/SettingToggleRow";
import {
  configureProfiler,
  getProfilerState,
  setProfilingEnabled,
} from "@utils/performanceProfiler";

const TERMINATION_WARNING =
  "Reload and restart actions terminate active workflows, PTY sessions, and CLI processes.";

interface DevAction {
  label: string;
  messageType: string;
  disabled?: boolean;
}

function formatBuildDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function DeveloperSection() {
  const vscode = useVsCodeApi();
  const [profilerState, setProfilerState] = useState(() => getProfilerState());
  const dev = useSettingsStore((state) => state.dev);
  const devBuild = useSettingsStore((state) => state.devBuild);
  const clearDevBuildOutput = useSettingsStore(
    (state) => state.clearDevBuildOutput
  );
  const resetLayoutState = useUiStore((s) => s.resetLayoutState);
  const showToast = useUiStore((s) => s.showToast);

  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.DEV_REQUEST_STATUS });
  }, [vscode]);

  if (!dev?.enabled) {
    return (
      <div className="text-sm text-description-fg">
        Developer controls are available in dev builds.
      </div>
    );
  }

  const buildDisabled = devBuild.isBuilding;
  const actions: DevAction[] = [
    {
      label: "Send Test Notification",
      messageType: MESSAGE_TYPES.DEV_SEND_TEST_NOTIFICATION,
    },
    {
      label: "Run Tests",
      messageType: MESSAGE_TYPES.DEV_RUN_TESTS,
    },
    {
      label: "Rebuild UI",
      messageType: MESSAGE_TYPES.DEV_BUILD_WEBVIEW,
    },
    {
      label: "Rebuild UI & Reload Window",
      messageType: MESSAGE_TYPES.DEV_BUILD_WEBVIEW_AND_RELOAD,
      disabled: !dev.commands.reloadWindow,
    },
    {
      label: "Rebuild Extension",
      messageType: MESSAGE_TYPES.DEV_BUILD_EXTENSION,
    },
    {
      label: "Rebuild Extension & Restart",
      messageType: MESSAGE_TYPES.DEV_BUILD_EXTENSION_AND_RELOAD,
      disabled: !dev.commands.restartExtensionHost,
    },
    { label: "Rebuild All", messageType: MESSAGE_TYPES.DEV_BUILD_ALL },
    {
      label: "Rebuild All & Restart",
      messageType: MESSAGE_TYPES.DEV_BUILD_ALL_AND_RELOAD,
      disabled: !dev.commands.restartExtensionHost,
    },
    {
      label: "Reload Window",
      messageType: MESSAGE_TYPES.DEV_RELOAD_WINDOW,
      disabled: !dev.commands.reloadWindow,
    },
    ...(dev.commands.restartExtensionHost
      ? [
          {
            label: "Restart Extension Host",
            messageType: MESSAGE_TYPES.DEV_RESTART_EXTENSION_HOST,
          },
        ]
      : []),
  ];

  function sendAction(action: DevAction) {
    vscode.postMessage({ type: action.messageType });
  }

  function updateProfilerEnabled(enabled: boolean) {
    setProfilerState(
      setProfilingEnabled(
        enabled,
        enabled
          ? {
              slowThresholdMs: 8,
              logMeasurements: true,
              logVirtualRanges: true,
              logAllScrollFrames: false,
              logLongFrames: true,
            }
          : undefined
      )
    );
    showToast(
      enabled
        ? "Performance profiling enabled."
        : "Performance profiling disabled.",
      "info"
    );
  }

  function updateProfilerOptions(
    options: Parameters<typeof configureProfiler>[0]
  ) {
    setProfilerState(configureProfiler(options));
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Developer
        </h3>
        <p className="text-xs text-description-fg">
          Command output comes from the extension host. Use reload for UI-only
          changes and restart the extension host whenever extension code is
          rebuilt.
        </p>
      </div>

      <div className="text-xs text-description-fg space-y-1">
        <div>Extension build date: {formatBuildDate(dev.buildDate)}</div>
        <div>
          Restart Extension Host:{" "}
          {dev.commands.restartExtensionHost ? "available" : "unavailable"}
        </div>
      </div>

      <div className="border-t border-panel-border pt-3">
        <p className="text-xs text-warning-fg mb-3">{TERMINATION_WARNING}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {actions.map((action) => (
            <Button
              key={action.messageType}
              type="button"
              variant="primary"
              size="sm"
              disabled={buildDisabled || action.disabled}
              onClick={() => sendAction(action)}
              className="w-full"
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="border-t border-panel-border pt-3 space-y-2">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Layout Testing
        </h3>
        <p className="text-xs text-description-fg">
          Clears persisted panel sizes and collapse states so the next reload
          shows what a new user sees. Reload the window after clicking.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            resetLayoutState();
            showToast(
              "Layout state cleared. Reload the window to see default panel sizes.",
              "info"
            );
          }}
        >
          Reset Layout to Defaults
        </Button>
      </div>

      <div className="border-t border-panel-border pt-3 space-y-2">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Performance Profiling
        </h3>
        <p className="text-xs text-description-fg">
          Logs gated performance measurements through the webview logger.
          Reproduce the slowdown, then filter logs for{" "}
          <span className="font-mono">[FP-perf]</span>.
        </p>
        <SettingToggleRow
          label="Enable performance profiling"
          description={`Logs slow phases at ${profilerState.slowThresholdMs}ms or slower.`}
          checked={profilerState.enabled}
          onChange={updateProfilerEnabled}
        />
        {profilerState.enabled && (
          <div className="pl-7 space-y-3">
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-description-fg">
                General (whole UI)
              </h4>
              <SettingToggleRow
                label="Log long frames"
                description="Captures requestAnimationFrame gaps and browser long-task entries across the entire webview — use to find render hotspots anywhere in the UI."
                checked={profilerState.logLongFrames}
                onChange={(checked) =>
                  updateProfilerOptions({ logLongFrames: checked })
                }
              />
            </div>
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-description-fg">
                Output section
              </h4>
              <SettingToggleRow
                label="Log row measurements"
                description="Includes mounted row measurement cost and measured-vs-estimated height deltas."
                checked={profilerState.logMeasurements}
                onChange={(checked) =>
                  updateProfilerOptions({ logMeasurements: checked })
                }
              />
              <SettingToggleRow
                label="Log virtual ranges"
                description="Logs TanStack Virtual window changes while scrolling."
                checked={profilerState.logVirtualRanges}
                onChange={(checked) =>
                  updateProfilerOptions({ logVirtualRanges: checked })
                }
              />
              <SettingToggleRow
                label="Log every scroll frame"
                description="Verbose; use only for short reproductions."
                checked={profilerState.logAllScrollFrames}
                onChange={(checked) =>
                  updateProfilerOptions({ logAllScrollFrames: checked })
                }
              />
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-panel-border pt-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
            Command Output
          </h3>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={devBuild.isBuilding || devBuild.output.length === 0}
            onClick={clearDevBuildOutput}
          >
            Clear
          </Button>
        </div>

        {devBuild.command && (
          <div className="text-xs text-description-fg">
            {devBuild.isBuilding ? "Running" : "Last command"}:{" "}
            {devBuild.command}
          </div>
        )}

        {devBuild.lastResult && (
          <div
            className={`text-xs ${
              devBuild.lastResult.success
                ? "text-indicator-success"
                : "text-error-fg"
            }`}
          >
            {devBuild.lastResult.success
              ? `Succeeded in ${devBuild.lastResult.durationMs}ms`
              : `Failed with exit code ${devBuild.lastResult.exitCode ?? "unknown"}`}
          </div>
        )}

        {devBuild.lastResult?.errorSummary && (
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-input-border bg-input-bg p-2 text-xs text-error-fg">
            {devBuild.lastResult.errorSummary}
          </pre>
        )}

        <pre className="min-h-40 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-input-border bg-input-bg p-2 text-xs text-foreground">
          {devBuild.output || "No command output yet."}
        </pre>
      </div>
    </div>
  );
}
