import { useCallback, useMemo, useState } from "react";
import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { parseRangeNotation } from "@root/utils/RangeNotationParser";
import {
  generateMarkdownExport,
  type ExportOptions,
} from "@utils/markdownExport";
import { getTargetKey, type OutputMessage } from "@utils/outputProjection";
import type { WorkflowStep } from "@store/workflowStore";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import { FINAL_STEP_PHASES, MESSAGE_TYPES } from "@/types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { WebviewLog } from "@/utils/logger";

interface UseOutputExportInput {
  allMessages: OutputMessage[];
  currentStep: number;
  executionState: string;
  fileName: string | null;
  finalStep: WorkflowStep | null;
  historyOrderedEntries?: OrderedHistoryEntry[];
  isViewingHistory: boolean;
  hiddenTargetKeys: readonly string[];
  steps: WorkflowStep[];
  totalSteps: number;
}

function getVisibleStepRange(
  allMessages: readonly OutputMessage[],
  hiddenTargetKeys: readonly string[]
): string {
  if (hiddenTargetKeys.length === 0) return "";

  const hiddenKeys = new Set(hiddenTargetKeys);
  const seenKeys = new Set<string>();
  const visibleStepNumbers: number[] = [];
  const sortedMessages = [...allMessages].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      (left.sequence ?? 0) - (right.sequence ?? 0)
  );

  for (const message of sortedMessages) {
    if (message.type !== OUTPUT_MESSAGE_TYPES.CLI) continue;

    const key = getTargetKey(message.target);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    if (!hiddenKeys.has(key)) {
      visibleStepNumbers.push(seenKeys.size);
    }
  }

  return visibleStepNumbers.join(",");
}

export function useOutputExport({
  allMessages,
  currentStep,
  executionState,
  fileName,
  finalStep,
  historyOrderedEntries,
  isViewingHistory,
  hiddenTargetKeys,
  steps,
  totalSteps,
}: UseOutputExportInput) {
  const [modalOpen, setModalOpen] = useState(false);
  const [includeCommand, setIncludeCommand] = useState(true);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [stepRange, setStepRange] = useState("");
  const [stepRangeError, setStepRangeError] = useState(false);

  const visibleStepRange = useMemo(
    () => getVisibleStepRange(allMessages, hiddenTargetKeys),
    [allMessages, hiddenTargetKeys]
  );

  const openModal = useCallback(() => {
    if (hiddenTargetKeys.length > 0) {
      setStepRange(visibleStepRange);
      setStepRangeError(false);
    }
    setModalOpen(true);
  }, [hiddenTargetKeys, visibleStepRange]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
  }, []);

  const updateStepRange = useCallback((value: string) => {
    setStepRange(value);
    setStepRangeError(false);
  }, []);

  const totalCliSteps = useMemo(() => {
    const seen = new Set<string>();
    for (const msg of allMessages) {
      if (msg.type === OUTPUT_MESSAGE_TYPES.CLI) {
        seen.add(getTargetKey(msg.target));
      }
    }
    return seen.size;
  }, [allMessages]);

  const buildExportMessages = useCallback(
    () =>
      allMessages.map((msg) => ({
        type: msg.type,
        target: msg.target,
        timestamp: msg.timestamp,
        sequence: msg.sequence,
        data: msg.data,
        attemptIndex: msg.attemptIndex,
        runIndex: msg.runIndex,
        stepName:
          msg.type === OUTPUT_MESSAGE_TYPES.CLI
            ? msg.target.kind === FINAL_STEP_PHASES.FINAL_STEP
              ? finalStep?.name?.trim() || undefined
              : steps[msg.target.index]?.name?.trim() || undefined
            : undefined,
      })),
    [allMessages, finalStep?.name, steps]
  );

  const confirmExport = useCallback(() => {
    let parsedRange: number[] | undefined;
    if (stepRange.trim()) {
      const parsed = parseRangeNotation(stepRange);
      if (!parsed) {
        setStepRangeError(true);
        return;
      }
      parsedRange = parsed;
    }

    const exportOptions: ExportOptions = {
      includeCommand,
      includeMetadata,
      stepRange: parsedRange,
    };

    let markdownContent: string;
    try {
      markdownContent = generateMarkdownExport(
        buildExportMessages(),
        {
          fileName: fileName || "Unknown",
          executionState,
          currentStep,
          totalSteps,
        },
        {
          orderedEntries:
            isViewingHistory && historyOrderedEntries?.length
              ? historyOrderedEntries
              : undefined,
          exportOptions,
        }
      );
    } catch (error) {
      WebviewLog.error("[useOutputExport] Failed to generate markdown export", error);
      return;
    }

    setModalOpen(false);

    if (isStandalone) {
      const blob = new Blob([markdownContent], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileName ?? "output"}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }

    getVsCodeApi()?.postMessage({
      type: MESSAGE_TYPES.EXPORT_OUTPUT,
      content: markdownContent,
      fileName,
    });
  }, [
    buildExportMessages,
    currentStep,
    executionState,
    fileName,
    historyOrderedEntries,
    includeCommand,
    includeMetadata,
    isViewingHistory,
    stepRange,
    totalSteps,
  ]);

  return {
    closeModal,
    confirmExport,
    includeCommand,
    includeMetadata,
    isStandaloneMode: isStandalone,
    modalOpen,
    openModal,
    setIncludeCommand,
    setIncludeMetadata,
    stepRange,
    stepRangeError,
    totalCliSteps,
    updateStepRange,
  };
}
