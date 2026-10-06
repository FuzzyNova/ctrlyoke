import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, CustomSelect, Modal } from "@components/shared";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import {
  KEYBOARD_KEYS,
  HARNESS_IDS,
  HARNESS_INFO,
  type HarnessId,
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import { viewedRunLabel } from "@utils/runNavigation";

const SAME_AS_SOURCE = "";
let duplicateRequestSequence = 0;

function nextDuplicateRequestId(): string {
  duplicateRequestSequence += 1;
  return `duplicate-${Date.now()}-${duplicateRequestSequence}`;
}

function isSameAddress(
  left: WorkflowViewAddress,
  right: WorkflowViewAddress | null
): boolean {
  return (
    right?.workflowKey === left.workflowKey &&
    right?.kind === left.kind &&
    (left.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
      (right.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        right.runRef === left.runRef))
  );
}

export const DuplicateWorkflowDialog: React.FC = () => {
  const dialogOpen = useUiStore((state) => state.duplicateWorkflowDialogOpen);
  const dialogData = useUiStore((state) => state.duplicateWorkflowDialogData);
  const request = useUiStore((state) => state.duplicateWorkflowRequest);
  const error = useUiStore((state) => state.duplicateWorkflowError);
  const closeDialog = useUiStore((state) => state.closeDuplicateWorkflowDialog);
  const beginRequest = useUiStore(
    (state) => state.beginDuplicateWorkflowRequest
  );
  const setError = useUiStore((state) => state.setDuplicateWorkflowError);
  const displayedViewAddress = useUiStore(
    (state) => state.displayedViewAddress
  );
  const runSummaries = useUiStore((state) => state.runSummaries);
  const vscode = useVsCodeApi();
  const getEffectiveHarness = useSettingsStore(
    (state) => state.getEffectiveHarness
  );
  const getModelsForHarness = useSettingsStore(
    (state) => state.getModelsForHarness
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [harness, setHarness] = useState(SAME_AS_SOURCE);
  const [model, setModel] = useState(SAME_AS_SOURCE);

  useEffect(() => {
    if (!dialogOpen || !dialogData) return;
    setName(`${dialogData.workflowName} Copy`);
    setNameError(null);
    setHarness(SAME_AS_SOURCE);
    setModel(SAME_AS_SOURCE);
    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [dialogData, dialogOpen]);

  const sourceMatchesDisplayedAddress =
    dialogData !== null &&
    isSameAddress(dialogData.source, displayedViewAddress);
  const sourceRunSummaries =
    dialogData &&
    displayedViewAddress?.workflowKey === dialogData.source.workflowKey
      ? runSummaries
      : [];
  const sourceLabel = dialogData
    ? `${dialogData.workflowName} · ${viewedRunLabel(dialogData.source, sourceRunSummaries, false)}`
    : "";

  const sourceAddress = dialogData?.source;
  const sourceRunSummary =
    sourceAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
      ? runSummaries.find(
          (summary) =>
            summary.workflowKey === sourceAddress.workflowKey &&
            summary.runRef === sourceAddress.runRef
        )
      : undefined;
  const sourceHarness = sourceMatchesDisplayedAddress
    ? getEffectiveHarness()
    : (sourceRunSummary?.primaryHarness as HarnessId | undefined);
  const selectedHarness =
    harness === SAME_AS_SOURCE ? sourceHarness : (harness as HarnessId);
  const modelOptions = useMemo(() => {
    const options = selectedHarness ? getModelsForHarness(selectedHarness) : [];
    return [
      { value: SAME_AS_SOURCE, label: "Same as source" },
      ...options.filter((option) => option.value !== SAME_AS_SOURCE),
    ];
  }, [getModelsForHarness, selectedHarness]);

  const harnessOptions = useMemo(
    () => [
      { value: SAME_AS_SOURCE, label: "Same as source" },
      ...(Object.values(HARNESS_IDS) as HarnessId[]).map((harnessId) => ({
        value: harnessId,
        label: HARNESS_INFO[harnessId].name,
      })),
    ],
    []
  );

  const handleNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
      setNameError(null);
      setError(null);
    },
    [setError]
  );

  const handleSubmit = useCallback(() => {
    if (!dialogData) return;
    const workflowName = name.trim();
    if (!workflowName) {
      setNameError("Workflow name is required");
      return;
    }

    const overrides = {
      ...(harness !== SAME_AS_SOURCE ? { harness: harness as HarnessId } : {}),
      ...(model !== SAME_AS_SOURCE ? { model } : {}),
    };
    const requestId = nextDuplicateRequestId();
    const request = {
      requestId,
      source: dialogData.source,
      workflowName,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    };
    beginRequest(request);
    vscode.postMessage({
      type: MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT,
      ...request,
    });
  }, [beginRequest, dialogData, harness, model, name, vscode]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === KEYBOARD_KEYS.ENTER) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const isPending = request !== null && error === null;

  return (
    <Modal
      isOpen={dialogOpen && dialogData !== null}
      onClose={closeDialog}
      title="Duplicate Workflow"
      size="md"
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <Button variant="secondary" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSubmit}
            disabled={isPending || !name.trim()}
          >
            Duplicate
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
          <span className="text-sm font-medium text-foreground">Source</span>
          <output
            className="truncate text-sm text-description-fg"
            title={sourceLabel}
          >
            {sourceLabel}
          </output>

          <label
            htmlFor="duplicate-workflow-name"
            className="text-sm font-medium text-foreground"
          >
            Name
          </label>
          <div>
            <input
              ref={inputRef}
              id="duplicate-workflow-name"
              type="text"
              value={name}
              onChange={handleNameChange}
              onKeyDown={handleKeyDown}
              aria-invalid={nameError ? "true" : undefined}
              aria-describedby={
                nameError ? "duplicate-workflow-name-error" : undefined
              }
              className="w-full rounded-sm border border-input-border bg-input-bg px-2 py-1.5 text-sm text-input-fg focus:border-focus-border focus:outline-hidden"
            />
            {nameError && (
              <p
                id="duplicate-workflow-name-error"
                role="alert"
                className="mt-1 text-xs text-error-fg"
              >
                {nameError}
              </p>
            )}
          </div>

          <label
            htmlFor="duplicate-workflow-harness"
            className="text-sm font-medium text-foreground"
          >
            Workflow Harness
          </label>
          <CustomSelect
            id="duplicate-workflow-harness"
            value={harness}
            onChange={(value) => {
              setHarness(value);
              setModel(SAME_AS_SOURCE);
            }}
            options={harnessOptions}
            triggerAriaLabel="Workflow Harness"
          />

          <label
            htmlFor="duplicate-workflow-model"
            className="text-sm font-medium text-foreground"
          >
            Workflow Model
          </label>
          <CustomSelect
            id="duplicate-workflow-model"
            value={model}
            onChange={setModel}
            options={modelOptions}
            disabled={!selectedHarness}
            triggerAriaLabel="Workflow Model"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-error-fg">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
};
