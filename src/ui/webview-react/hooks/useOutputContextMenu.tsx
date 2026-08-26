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

function buildCopyAllText(
  allMessages: OutputMessage[],
  lastCliIndexPerStep: Map<string, number>
): string {
  const seen = new Map<string, OutputMessage["target"]>();
  for (const msg of allMessages) {
    const key = `${msg.target.kind}:${msg.target.index}`;
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
  allMessages: OutputMessage[];
  stepScrollFractions: Map<string, number>;
  lastCliIndexPerStep: Map<string, number>;
  onOpenFind: () => void;
}

export function useOutputContextMenu({
  allMessages,
  stepScrollFractions,
  lastCliIndexPerStep,
  onOpenFind,
}: UseOutputContextMenuOptions) {
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
      for (const [key, fraction] of stepScrollFractions) {
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

      const copyAllText = buildCopyAllText(allMessages, lastCliIndexPerStep);
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
            label: "Copy All",
            icon: "codicon-copy",
            disabled: !hasAnyOutput || copyAllText.length === 0,
            disabledTitle: "No output to copy",
            onClick: () => {
              void writeClipboardText(copyAllText);
            },
          },
          {
            label: "Copy Step Output",
            icon: "codicon-copy",
            disabled: !hoveredOutputText,
            disabledTitle: hoveredStepKey
              ? "No output to copy for this step"
              : "No step under cursor",
            onClick: () => {
              if (!hoveredOutputText) return;
              void writeClipboardText(hoveredOutputText);
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
    [allMessages, stepScrollFractions, lastCliIndexPerStep, onOpenFind]
  );

  const outputContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, outputContextMenuPortal };
}
