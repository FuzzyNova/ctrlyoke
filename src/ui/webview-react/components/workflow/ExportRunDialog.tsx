import React, { useEffect, useRef, useState } from "react";
import { Button, Modal, SettingToggleRow } from "../shared";
import { WorkflowLocationNameFields } from "./WorkflowLocationNameFields";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import { validateSafeName } from "@utils/string";

function splitBundlePath(fullPath: string) {
  const normalized = fullPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const location = slash >= 0 ? normalized.slice(0, slash) : "";
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return { location, name: base.replace(/\.ctrlyokerun$/i, "") };
}

export const ExportRunDialog: React.FC = () => {
  const data = useUiStore((state) => state.runExportDialogData);
  const close = useUiStore((state) => state.closeRunExportDialog);
  const update = useUiStore((state) => state.updateRunExportDialog);
  const browserOpen = useUiStore((state) => !!state.fileBrowserState);
  const vscode = useVsCodeApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [includeSnapshots, setIncludeSnapshots] = useState(false);
  const [includeChanges, setIncludeChanges] = useState(true);
  const requestId = data?.requestId;
  const defaultPath = data?.defaultPath;

  useEffect(() => {
    if (!requestId || !defaultPath) return;
    const split = splitBundlePath(defaultPath);
    setLocation(split.location);
    setName(split.name);
    setNameError(null);
    setIncludeSnapshots(false);
    setIncludeChanges(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [defaultPath, requestId]);

  if (!data) return null;
  const destination = `${location.replace(/\/$/, "")}${location ? "/" : ""}${name.trim() || "…"}.ctrlyokerun`;
  const busy =
    data.result === undefined &&
    data.error === undefined &&
    data.exporting === true;
  const canExport =
    !!name.trim() &&
    !validateSafeName(name, "Bundle name is required") &&
    !busy;

  const exportRun = () => {
    const error = validateSafeName(name, "Bundle name is required");
    if (error) {
      setNameError(error);
      return;
    }
    update(data.requestId, {
      error: undefined,
      result: undefined,
      exporting: true,
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.EXPORT_RUN,
      requestId: data.requestId,
      address: data.address,
      bundleDir: destination,
      includeSnapshots,
      includeChanges,
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === KEYBOARD_KEYS.ENTER && canExport) exportRun();
  };

  return (
    <Modal
      isOpen={!browserOpen}
      onClose={close}
      title={`Export Run — ${data.workflowName}`}
      size="md"
      footer={
        <div className="flex items-center justify-between w-full">
          <span className="text-xs text-description-fg">
            Review the redaction report before sharing.
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
            {!data.result && (
              <Button
                variant="primary"
                onClick={exportRun}
                disabled={!canExport}
              >
                Export Run
              </Button>
            )}
          </div>
        </div>
      }
    >
      {data.result ? (
        <div className="space-y-3 text-sm" aria-label="Export result">
          <p>
            Exported to{" "}
            <span className="font-mono break-all">{data.result.bundleDir}</span>
          </p>
          <p>
            {data.result.eventCount} history events.{" "}
            {data.result.continuable
              ? "Run state is included."
              : "History only."}
          </p>
          <section aria-label="Redaction summary">
            <h3 className="font-medium">Redaction summary</h3>
            <p>{data.result.redaction.removedCount} value(s) removed</p>
            {Object.entries(data.result.redaction.byRule).map(
              ([rule, count]) => (
                <p key={rule}>
                  {rule}: {count}
                </p>
              )
            )}
            {Object.entries(data.result.redaction.byFile ?? {}).map(
              ([file, count]) => (
                <p key={file}>
                  {file}: {count}
                </p>
              )
            )}
          </section>
          {!!data.result.externalPaths.length && (
            <section>
              <h3 className="font-medium">External paths</h3>
              {data.result.externalPaths.map((file) => (
                <p key={file} className="font-mono break-all">
                  {file}
                </p>
              ))}
            </section>
          )}
          {!!data.result.warnings.length && (
            <section role="alert">
              <h3 className="font-medium">Warnings</h3>
              {data.result.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </section>
          )}
          <p className="text-warning-fg">
            Review the bundle contents and redaction summary before sharing.
            Redaction is best effort.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <WorkflowLocationNameFields
            location={location}
            name={name}
            nameError={nameError}
            placeholder="workflow-run"
            inputRef={inputRef}
            onLocationChange={setLocation}
            onNameChange={(event) => {
              const value = event.target.value;
              setName(value);
              setNameError(
                value
                  ? validateSafeName(value, "Bundle name is required")
                  : null
              );
            }}
            onNameKeyDown={handleKeyDown}
          />
          <section
            aria-label="What's included"
            className="space-y-2 border-t border-panel-border pt-3"
          >
            <h3 className="font-medium">What’s included</h3>
            <p>Run history and its redacted timeline are always included.</p>
            {data.continuable ? (
              <>
                <p>
                  Run state and workspace changes are available to continue this
                  run.
                </p>
                <p>
                  {data.changedFiles.length} changed file(s):{" "}
                  {data.changedFiles.length
                    ? data.changedFiles.join(", ")
                    : "none"}
                </p>
                <SettingToggleRow
                  label="Omit workspace changes"
                  description="Keep the run state but leave out changes.patch."
                  checked={!includeChanges}
                  onChange={(value) => setIncludeChanges(!value)}
                />
              </>
            ) : (
              <p>
                This run has no pending work to continue; history only will be
                exported.
              </p>
            )}
            <SettingToggleRow
              label="Include workspace snapshots"
              description="Snapshots can contain file contents. They are omitted by default."
              checked={includeSnapshots}
              onChange={setIncludeSnapshots}
            />
          </section>
          <p className="text-xs text-description-fg">
            Will export to{" "}
            <span className="font-mono break-all">{destination}</span>
          </p>
          {data.error && (
            <p role="alert" className="text-error-fg">
              {data.error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};
