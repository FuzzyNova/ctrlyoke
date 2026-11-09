import { useCallback, useMemo, useState } from "react";
import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { parseRangeNotation } from "@root/utils/RangeNotationParser";
import {
  generateMarkdownExport,
  sortByOutputOrder,
  type ExportOptions,
} from "@utils/markdownExport";
import {
  getOutputTargetStepName,
  getTargetKey,
  mapOrderedHistoryEntriesToMessages,
  type OutputMessage,
} from "@utils/outputProjection";
import { writeClipboardText } from "@utils/stepClipboard";
import type { WorkflowStep } from "@store/workflowStore";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import { MESSAGE_TYPES } from "@/types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { WebviewLog } from "@/utils/logger";

interface UseOutputExportInput {
  allMessages: OutputMessage[];
  currentStep: number;
  executionState: string;
  fileName: string | null;
  finalStep: WorkflowStep | null;
  historyOrderedEntries?: OrderedHistoryEntry[];
  liveOrderedEntries?: OrderedHistoryEntry[];
  isViewingHistory: boolean;
  hiddenTargetKeys: readonly string[];
  steps: WorkflowStep[];
  totalSteps: number;
}

function getVisibleStepRange(
  orderedMessages: readonly OutputMessage[],
  hiddenTargetKeys: readonly string[]
): string {
  if (hiddenTargetKeys.length === 0) return "";

  const hiddenKeys = new Set(hiddenTargetKeys);
  const seenKeys = new Set<string>();
  const visibleStepNumbers: number[] = [];
  for (const message of orderedMessages) {
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
  liveOrderedEntries,
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

  const exportOrderedEntries = isViewingHistory
    ? historyOrderedEntries
    : liveOrderedEntries;
  // Export order is fixed here once, so the step numbers in the range
  // prompt, the step count and the generated markdown always agree.
  const exportMessages = useMemo(() => {
    if (exportOrderedEntries?.length) {
      return mapOrderedHistoryEntriesToMessages(exportOrderedEntries);
    }
    return sortByOutputOrder(
      allMessages.filter((message) => !message.isActivity)
    );
  }, [allMessages, exportOrderedEntries]);

  const visibleStepRange = useMemo(
    () => getVisibleStepRange(exportMessages, hiddenTargetKeys),
    [exportMessages, hiddenTargetKeys]
  );

  const openModal = useCallback(() => {
    setStepRange(visibleStepRange);
    setStepRangeError(false);
    setModalOpen(true);
  }, [visibleStepRange]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
  }, []);

  const updateStepRange = useCallback((value: string) => {
    setStepRange(value);
    setStepRangeError(false);
  }, []);

  const totalCliSteps = useMemo(() => {
    const seen = new Set<string>();
    for (const msg of exportMessages) {
      if (msg.type === OUTPUT_MESSAGE_TYPES.CLI) {
        seen.add(getTargetKey(msg.target));
      }
    }
    return seen.size;
  }, [exportMessages]);

  const buildExportMessages = useCallback(
    () =>
      exportMessages.map((msg) => ({
        type: msg.type,
        target: msg.target,
        timestamp: msg.timestamp,
        sequence: msg.sequence,
        data: msg.data,
        prompt: msg.prompt,
        attemptIndex: msg.attemptIndex,
        runIndex: msg.runIndex,
        stepName:
          msg.type === OUTPUT_MESSAGE_TYPES.CLI
            ? getOutputTargetStepName(msg.target, steps, finalStep)
            : undefined,
      })),
    [exportMessages, finalStep, steps]
  );

  /**
   * Build the markdown for the modal's current options, or null when the
   * step range is invalid (flagged in the modal) or generation fails.
   */
  const buildMarkdownContent = useCallback((): string | null => {
    let parsedRange: number[] | undefined;
    if (stepRange.trim()) {
      const parsed = parseRangeNotation(stepRange);
      if (!parsed) {
        setStepRangeError(true);
        return null;
      }
      parsedRange = parsed;
    }

    const exportOptions: ExportOptions = {
      includeCommand,
      includeMetadata,
      stepRange: parsedRange,
    };

    try {
      return generateMarkdownExport(
        buildExportMessages(),
        {
          fileName: fileName || "Unknown",
          executionState,
          currentStep,
          totalSteps,
        },
        { preordered: true, exportOptions }
      );
    } catch (error) {
      WebviewLog.error(
        "[useOutputExport] Failed to generate markdown export",
        error
      );
      return null;
    }
  }, [
    buildExportMessages,
    currentStep,
    executionState,
    fileName,
    includeCommand,
    includeMetadata,
    stepRange,
    totalSteps,
  ]);

  const copyExport = useCallback(() => {
    const markdownContent = buildMarkdownContent();
    if (markdownContent === null) return;
    setModalOpen(false);
    writeClipboardText(markdownContent).catch((error: unknown) => {
      WebviewLog.error(
        "[useOutputExport] Failed to copy markdown export",
        error
      );
    });
  }, [buildMarkdownContent]);

  const confirmExport = useCallback(() => {
    const markdownContent = buildMarkdownContent();
    if (markdownContent === null) return;

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
  }, [buildMarkdownContent, fileName]);

  return {
    closeModal,
    confirmExport,
    copyExport,
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
