import { useEffect } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@/types/messages";
import { Button } from "@components/shared/Button";

const TERMINATION_WARNING =
  "Active workflows, PTY sessions, and CLI processes will be terminated.";

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
  const dev = useSettingsStore((state) => state.dev);
  const devBuild = useSettingsStore((state) => state.devBuild);
  const clearDevBuildOutput = useSettingsStore(
    (state) => state.clearDevBuildOutput
  );

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
      label: "Rebuild Extension",
      messageType: MESSAGE_TYPES.DEV_BUILD_EXTENSION,
    },
    { label: "Rebuild All", messageType: MESSAGE_TYPES.DEV_BUILD_ALL },
    {
      label: "Reload Window",
      messageType: MESSAGE_TYPES.DEV_RELOAD_WINDOW,
      disabled: !dev.commands.reloadWindow,
    },
    {
      label: "Rebuild Extension & Reload",
      messageType: MESSAGE_TYPES.DEV_BUILD_EXTENSION_AND_RELOAD,
      disabled: !dev.commands.reloadWindow,
    },
    {
      label: "Rebuild All & Reload",
      messageType: MESSAGE_TYPES.DEV_BUILD_ALL_AND_RELOAD,
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

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Developer
        </h3>
        <p className="text-xs text-description-fg">
          Build output comes from the extension host. Reload and restart actions
          replace the running extension code after a successful build.
        </p>
      </div>

      <div className="text-xs text-description-fg space-y-1">
        <div>Build date: {formatBuildDate(dev.buildDate)}</div>
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
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
            Build Output
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
              devBuild.lastResult.success ? "text-bash-status-success" : "text-error-fg"
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
          {devBuild.output || "No build output yet."}
        </pre>
      </div>
    </div>
  );
}
