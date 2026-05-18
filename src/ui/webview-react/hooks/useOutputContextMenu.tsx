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
    if (msg?.type !== "cli") continue;

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
}

export function useOutputContextMenu({
  allMessages,
  stepScrollFractions,
  lastCliIndexPerStep,
}: UseOutputContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openContextMenu = useCallback(
    (x: number, y: number, scrollContainer: HTMLDivElement) => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const clickPixelPos =
        y - containerRect.top + scrollContainer.scrollTop;
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
          if (msg?.type === "cli") {
            hoveredOutputText = extractCliOutputText(msg.data as CliOutputType);
          }
        }
      }

      const copyAllText = buildCopyAllText(allMessages, lastCliIndexPerStep);
      const hasAnyOutput = allMessages.some((m) => m.type === "cli");

      setContextMenu({
        x,
        y,
        items: [
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
            label: "Copy All",
            icon: "codicon-copy",
            disabled: !hasAnyOutput || copyAllText.length === 0,
            disabledTitle: "No output to copy",
            onClick: () => {
              void writeClipboardText(copyAllText);
            },
          },
        ],
      });
    },
    [allMessages, stepScrollFractions, lastCliIndexPerStep]
  );

  const outputContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, outputContextMenuPortal };
}
