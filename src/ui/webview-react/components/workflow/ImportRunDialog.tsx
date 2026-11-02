import React, { useEffect, useState } from "react";
import { Button } from "@components/shared/Button";
import { Modal } from "@components/shared/Modal";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import {
  RUN_CHANGES_TARGETS,
  type RunChangesTarget,
} from "@root/types/RunBundleTypes";

const CHANGES_TARGET_LABELS: Record<RunChangesTarget, string> = {
  [RUN_CHANGES_TARGETS.WORKTREE]: "A new managed worktree",
  [RUN_CHANGES_TARGETS.CHECKOUT]: "This checkout",
  [RUN_CHANGES_TARGETS.SKIP]: "Nowhere: I've synced the code myself",
};

export const ImportRunDialog: React.FC = () => {
  const data = useUiStore((state) => state.runImportDialogData);
  const close = useUiStore((state) => state.closeRunImportDialog);
  const update = useUiStore((state) => state.updateRunImportDialog);
  const vscode = useVsCodeApi();
  const [changes, setChanges] = useState<RunChangesTarget | null>(null);
  useEffect(() => setChanges(null), [data?.requestId]);
  if (!data) return null;
  const preview = data.preview;
  const blocked = !!preview?.blockers.length;
  const continuation = preview?.continuation;
  // The preview offers only targets that can succeed here; fall back to the
  // first of them when the CLI default (e.g. a dirty checkout) is not one.
  const selectedChanges: RunChangesTarget | undefined = continuation
    ? (changes ??
      (continuation.allowedChangesTargets.includes(
        continuation.defaultChangesTarget
      )
        ? continuation.defaultChangesTarget
        : continuation.allowedChangesTargets[0]))
    : undefined;
  const importRun = (continueRun: boolean, again = false) => {
    update(data.requestId, { importing: true, error: undefined });
    vscode.postMessage({
      type: continueRun
        ? MESSAGE_TYPES.IMPORT_RUN_AND_CONTINUE
        : MESSAGE_TYPES.IMPORT_RUN,
      requestId: data.requestId,
      bundleDir: data.bundleDir,
      ...(selectedChanges ? { changes: selectedChanges } : {}),
      again,
    });
  };
  return (
    <Modal
      isOpen
      onClose={close}
      title="Import Run"
      size="lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => importRun(false)}
            disabled={
              !preview || data.importing || !!preview.provenance.alreadyImported
            }
          >
            Import
          </Button>
          <Button
            onClick={() => importRun(true)}
            disabled={
              !preview?.continuable ||
              blocked ||
              data.importing ||
              !!preview.provenance.alreadyImported
            }
          >
            Import and Continue
          </Button>
        </div>
      }
    >
      {!preview ? (
        <p role={data.error ? "alert" : undefined}>
          {data.error ?? "Loading import preview…"}
        </p>
      ) : (
        <div className="max-h-[65vh] space-y-4 overflow-y-auto text-sm">
          <section aria-label="Provenance">
            <h3 className="font-medium">Provenance</h3>
            <p>{preview.provenance.workflowName}</p>
            <p>{preview.provenance.sourceRoot}</p>
            <p>
              Exported {preview.provenance.exportedAt} with ctrlyoke{" "}
              {preview.provenance.exportedByVersion}
            </p>
            {preview.provenance.alreadyImported && (
              <div role="status">
                <p>This run was already imported.</p>
                <Button
                  onClick={() => {
                    vscode.postMessage({
                      type: MESSAGE_TYPES.OPEN_IMPORTED_RUN,
                      workflowKey:
                        preview.provenance.alreadyImported!.workflowKey,
                      runRef: preview.provenance.alreadyImported!.runRef,
                    });
                    close();
                  }}
                >
                  Open existing import
                </Button>
                <Button onClick={() => importRun(false, true)}>
                  Import again
                </Button>
              </div>
            )}
          </section>
          {preview.continuation && (
            <section aria-label="Base commit and changes">
              <h3 className="font-medium">Base commit</h3>
              <p>
                {preview.continuation.baseCommit.commit}:{" "}
                {preview.continuation.baseCommit.exists
                  ? "available"
                  : preview.continuation.baseCommit.instruction}
              </p>
              <p>{preview.continuation.patchFileCount} changed files.</p>
              <label className="block">
                Where changes will land
                <select
                  value={selectedChanges}
                  onChange={(event) =>
                    setChanges(event.target.value as RunChangesTarget)
                  }
                  className="ml-2"
                >
                  {preview.continuation.allowedChangesTargets.map((target) => (
                    <option key={target} value={target}>
                      {CHANGES_TARGET_LABELS[target]}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                Checkout{" "}
                {preview.continuation.checkoutClean
                  ? "is clean"
                  : "has changes"}{" "}
                and{" "}
                {preview.continuation.checkoutAtBaseCommit
                  ? "is at base commit"
                  : "is not at base commit"}
                .
              </p>
            </section>
          )}
          <section aria-label="Harness sessions">
            <h3 className="font-medium">Harness sessions</h3>
            {preview.sessions.length ? (
              preview.sessions.map((session) => (
                <p key={`${session.stepIndex}-${session.sessionId}`}>
                  Step {session.stepIndex + 1}: {session.availability}; executed
                  steps covered:{" "}
                  {session.executedStepIndices.map((n) => n + 1).join(", ") ||
                    (session.notFromThisRun ? "not from this run" : "none")}
                </p>
              ))
            ) : (
              <p>No pending session resumes.</p>
            )}
          </section>
          <section aria-label="Pending steps">
            <h3 className="font-medium">Pending steps</h3>
            {preview.pendingSteps.map((step) => (
              <article
                key={step.stepIndex}
                className="border-t border-panel-border pt-2"
              >
                <strong>
                  Step {step.stepIndex + 1}: {step.name ?? step.kind}
                </strong>
                <p>
                  {step.harness ?? "Configured harness"} /{" "}
                  {step.model ?? "configured model"}
                  {step.previouslyUsed &&
                    ` (used ${step.previouslyUsed.harness ?? "unknown"} / ${step.previouslyUsed.model ?? "unknown"})`}
                </p>
                {step.promptPreview && (
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-sm bg-code-block p-2">
                    {step.promptPreview}
                  </pre>
                )}
                {step.promptRedacted && (
                  <p className="text-warning-fg">Prompt text was redacted.</p>
                )}
                {[
                  ["Script", step.script?.script],
                  ["Pre-condition script", step.preCondition?.script],
                  ["End-condition script", step.endCondition?.script],
                ].map(([label, script]) =>
                  script ? (
                    <p key={label} className="text-warning-fg">
                      {label}: <code>{script}</code>
                    </p>
                  ) : null
                )}
                {step.additionalArgs && (
                  <p>Additional arguments: {step.additionalArgs}</p>
                )}
                {!!step.mcpServers?.length && (
                  <p>
                    MCP servers:{" "}
                    {step.mcpServers
                      .map((server) =>
                        typeof server === "string" ? server : server.id
                      )
                      .join(", ")}
                  </p>
                )}
                {step.secretGrants.map((grant) => (
                  <p key={grant.name} className="text-warning-fg">
                    Secret grant: {grant.name} (
                    {grant.approved ? "approved" : "not approved"})
                  </p>
                ))}
              </article>
            ))}
          </section>
          {!!preview.blockers.length && (
            <section aria-label="Blockers" role="alert">
              <h3 className="font-medium">Blockers</h3>
              {preview.blockers.map((blocker, index) => (
                <p key={`${blocker.code}-${index}`}>{blocker.message}</p>
              ))}
            </section>
          )}
          {data.error && <p role="alert">{data.error}</p>}
        </div>
      )}
    </Modal>
  );
};
