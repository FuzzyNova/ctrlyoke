import { useState, useCallback } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import { writeClipboardText } from "@utils/stepClipboard";
import { extractCliOutputText } from "@utils/outputUtils";
import type { OutputMessage } from "@utils/outputProjection";
import type { CliOutput as CliOutputType } from "../types/cliEvents";
import { FINAL_STEP_PHASES } from "../types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { getTargetKey } from "@utils/outputProjection";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";
import { useToolOutputContent } from "@hooks/useToolOutputContent";
import { hydrateOutputMessages } from "@utils/toolOutputHydration";

export function buildCopyAllText(
  allMessages: OutputMessage[],
  lastCliIndexPerStep: Map<string, number>,
  hiddenTargetKeys: readonly string[]
): string {
  const hiddenKeys = new Set(hiddenTargetKeys);
  const seen = new Map<string, OutputMessage["target"]>();
  for (const msg of allMessages) {
    const key = getTargetKey(msg.target);
    if (!seen.has(key)) seen.set(key, msg.target);
  }

  const parts: string[] = [];
  let queueStepNum = 1;

  for (const [key, target] of seen) {
    const lastCliIdx = lastCliIndexPerStep.get(key);
    if (lastCliIdx === undefined) continue;

    const msg = allMessages[lastCliIdx];
    if (msg?.type !== OUTPUT_MESSAGE_TYPES.CLI) continue;

    const output = msg.data as CliOutputType;
    const isFinalStep = target.kind === FINAL_STEP_PHASES.FINAL_STEP;

    // Keep the original step numbering in copied headers even when an earlier
    // step is hidden. This matches the numbering used by markdown export.
    if (hiddenKeys.has(key)) {
      if (!isFinalStep) queueStepNum++;
      continue;
    }

    const header = isFinalStep
      ? `Final Step Loop ${target.index + 1}`
      : `Step ${queueStepNum}`;

    const promptText = (output.prompt ?? output.cliCommand)?.trim();
    const outputText = extractCliOutputText(output);

    if (promptText || outputText) {
      const section: string[] = [`=== ${header} ===`];
      if (promptText) section.push(`\nPrompt:\n${promptText}`);
      if (outputText) section.push(`\nOutput:\n${outputText}`);
      parts.push(section.join("\n"));
    }

    if (!isFinalStep) queueStepNum++;
  }

  return parts.join("\n\n---\n\n");
}

interface UseOutputContextMenuOptions {
  address?: WorkflowRunAddress;
  anchorScrollFractions?: Map<string, number>;
  allMessages: OutputMessage[];
  hiddenTargetKeys: readonly string[];
  stepScrollFractions: Map<string, number>;
  lastCliIndexPerStep: Map<string, number>;
  onOpenFind: () => void;
}

export function useOutputContextMenu({
  address,
  anchorScrollFractions,
  allMessages,
  hiddenTargetKeys,
  stepScrollFractions,
  lastCliIndexPerStep,
  onOpenFind,
}: UseOutputContextMenuOptions) {
  const fetchToolOutputEvent = useToolOutputContent();
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openContextMenu = useCallback(
    (x: number, y: number, scrollContainer: HTMLDivElement) => {
      // Capture selection before the menu click clears it
      const selectedText = window.getSelection()?.toString() ?? "";

      const containerRect = scrollContainer.getBoundingClientRect();
      const clickPixelPos = y - containerRect.top + scrollContainer.scrollTop;
      const scrollHeight = scrollContainer.scrollHeight;
      const clickFraction = scrollHeight > 0 ? clickPixelPos / scrollHeight : 0;

      // Find the step with the largest scroll fraction at or above the click
      let hoveredStepKey: string | null = null;
      let bestFraction = -1;
      for (const [key, fraction] of anchorScrollFractions ??
        stepScrollFractions) {
        if (fraction <= clickFraction && fraction > bestFraction) {
          bestFraction = fraction;
          hoveredStepKey = key;
        }
      }

      let hoveredOutputText: string | undefined;
      if (hoveredStepKey) {
        const lastCliIdx = lastCliIndexPerStep.get(hoveredStepKey);
        if (lastCliIdx !== undefined) {
          const msg = allMessages[lastCliIdx];
          if (msg?.type === OUTPUT_MESSAGE_TYPES.CLI) {
            hoveredOutputText = extractCliOutputText(msg.data as CliOutputType);
          }
        }
      }

      const copyAllText = buildCopyAllText(
        allMessages,
        lastCliIndexPerStep,
        hiddenTargetKeys
      );
      const presentTargetKeys = new Set(
        allMessages.map((message) => getTargetKey(message.target))
      );
      const hiddenStepCount = hiddenTargetKeys.filter((key) =>
        presentTargetKeys.has(key)
      ).length;
      const hasAnyOutput = allMessages.some(
        (m) => m.type === OUTPUT_MESSAGE_TYPES.CLI
      );

      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Copy",
            icon: "codicon-copy",
            disabled: false,
            onClick: () => {
              if (selectedText) void writeClipboardText(selectedText);
            },
          },
          { type: "divider" },
          {
            label:
              hiddenStepCount > 0
                ? `Copy All (${hiddenStepCount} step${hiddenStepCount === 1 ? "" : "s"} hidden)`
                : "Copy All",
            icon: "codicon-copy",
            disabled: !hasAnyOutput || copyAllText.length === 0,
            disabledTitle: "No output to copy",
            onClick: async () => {
              const fullMessages = address
                ? await hydrateOutputMessages(
                    allMessages,
                    address,
                    fetchToolOutputEvent
                  )
                : allMessages;
              void writeClipboardText(
                buildCopyAllText(
                  fullMessages,
                  lastCliIndexPerStep,
                  hiddenTargetKeys
                )
              );
            },
          },
          {
            label: "Copy Step Output",
            icon: "codicon-copy",
            disabled: !hoveredOutputText,
            disabledTitle: hoveredStepKey
              ? "No output to copy for this step"
              : "No step under cursor",
            onClick: async () => {
              if (!hoveredOutputText) return;
              const lastCliIdx = hoveredStepKey
                ? lastCliIndexPerStep.get(hoveredStepKey)
                : undefined;
              const hoveredMessage =
                lastCliIdx === undefined ? undefined : allMessages[lastCliIdx];
              const fullMessages =
                address && hoveredMessage
                  ? await hydrateOutputMessages(
                      [hoveredMessage],
                      address,
                      fetchToolOutputEvent
                    )
                  : [hoveredMessage];
              const fullMessage = fullMessages[0];
              const fullText =
                fullMessage?.type === OUTPUT_MESSAGE_TYPES.CLI
                  ? extractCliOutputText(fullMessage.data as CliOutputType)
                  : hoveredOutputText;
              if (fullText) void writeClipboardText(fullText);
            },
          },
          { type: "divider" },
          {
            label: "Find in Output",
            icon: "codicon-search",
            disabled: false,
            onClick: () => {
              onOpenFind();
            },
          },
        ],
      });
    },
    [
      anchorScrollFractions,
      address,
      allMessages,
      hiddenTargetKeys,
      stepScrollFractions,
      lastCliIndexPerStep,
      onOpenFind,
      fetchToolOutputEvent,
    ]
  );

  const outputContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, outputContextMenuPortal };
}
