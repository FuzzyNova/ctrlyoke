import { useState, useCallback } from "react";
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuState,
} from "../components/shared/ContextMenu";
import { findOutputRowKey } from "@utils/outputDom";
import type { OutputRenderRow } from "@utils/outputRows";
import { describeRowDetails } from "@utils/outputRowDetails";
import { writeClipboardText } from "@utils/clipboard";
import { getStepAssistantTextForCopy } from "@utils/outputUtils";
import type { OutputMessage } from "@utils/outputProjection";
import type { CliOutput as CliOutputType } from "../types/cliEvents";
import { FINAL_STEP_PHASES } from "../types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { getOutputTargetStepName, getTargetKey } from "@utils/outputProjection";
import { formatStepTargetLabel } from "@root/utils/FinalStepLabels";
import { generateSingleStepMarkdownExport } from "@utils/markdownExport";
import {
  OUTPUT_COPY_MENU_LABELS,
  OUTPUT_COPY_MENU_TITLES,
  formatCopyAllResponsesLabel,
  getStepCopyLabels,
} from "@utils/outputCopyMenuLabels";
import { isScriptOutput } from "@utils/outputRenderUtils";
import type { WorkflowStep } from "@store/workflowStore";

interface CopyAllResponsesSteps {
  steps: readonly WorkflowStep[];
  finalStep: WorkflowStep | null;
}

/**
 * The text a prompt step sent, or a script step's command. `cliCommand` is
 * the spawned harness command line for a prompt step, so it is never used as
 * the prompt.
 */
function getCopyAllInput(
  msg: OutputMessage,
  output: CliOutputType
): { label: string; text: string } | undefined {
  if (isScriptOutput(output)) {
    const command = output.cliCommand?.trim();
    return command ? { label: "Command", text: command } : undefined;
  }
  const prompt = msg.prompt?.trim();
  return prompt ? { label: "Prompt", text: prompt } : undefined;
}

function buildCopyAllText(
  allMessages: OutputMessage[],
  lastCliIndexPerStep: Map<string, number>,
  hiddenTargetKeys: readonly string[],
  { steps, finalStep }: CopyAllResponsesSteps
): string {
  const hiddenKeys = new Set(hiddenTargetKeys);
  const seen = new Map<string, OutputMessage["target"]>();
  for (const msg of allMessages) {
    const key = getTargetKey(msg.target);
    if (!seen.has(key)) seen.set(key, msg.target);
  }

  const parts: string[] = [];

  for (const [key, target] of seen) {
    const lastCliIdx = lastCliIndexPerStep.get(key);
    if (lastCliIdx === undefined) continue;

    const msg = allMessages[lastCliIdx];
    if (msg?.type !== OUTPUT_MESSAGE_TYPES.CLI) continue;

    const output = msg.data as CliOutputType;
    const isFinalStep = target.kind === FINAL_STEP_PHASES.FINAL_STEP;

    if (hiddenKeys.has(key)) continue;

    const stepLabel = formatStepTargetLabel(isFinalStep, target.index);
    const stepName = getOutputTargetStepName(target, steps, finalStep);
    const header = stepName ? `${stepLabel}: ${stepName}` : stepLabel;

    const input = getCopyAllInput(msg, output);
    const outputText = getStepAssistantTextForCopy(output);

    if (input || outputText) {
      const section: string[] = [`=== ${header} ===`];
      if (input) section.push(`\n${input.label}:\n${input.text}`);
      if (outputText) {
        const outputLabel = isScriptOutput(output) ? "Output" : "Response";
        section.push(`\n${outputLabel}:\n${outputText}`);
      }
      parts.push(section.join("\n"));
    }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * The row under the pointer: the clicked element when there is one, else
 * whatever sits at the point (a touch long press reports only coordinates).
 */
function findRowAt(
  x: number,
  y: number,
  target: EventTarget | null | undefined,
  rows: readonly OutputRenderRow[]
): OutputRenderRow | undefined {
  const element =
    target instanceof Element
      ? target
      : typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(x, y)
        : null;
  const rowKey = findOutputRowKey(element);
  return rowKey === undefined
    ? undefined
    : rows.find((row) => row.key === rowKey);
}

/**
 * The Details submenu: the row's start time, duration and step (or a step
 * header's whole description), one item per line that copies that line, and a
 * Copy Details item for all of them. Kept in a submenu so the menu stays as
 * short as it was, and so nothing appears until it is asked for.
 */
function buildDetailsEntry(details: readonly string[] | undefined) {
  const submenu: ContextMenuEntry[] = details
    ? [
        ...details.map((line) => ({
          label: line,
          icon: "codicon-copy",
          disabled: false,
          title: "Copy this line",
          onClick: () => void writeClipboardText(line),
        })),
        { type: "divider" as const },
        {
          label: "Copy Details",
          icon: "codicon-copy",
          disabled: false,
          onClick: () => void writeClipboardText(details.join("\n")),
        },
      ]
    : [];
  return {
    label: "Details",
    icon: "codicon-info",
    disabled: !details,
    title: "When this line started, how long it took, and its step",
    disabledTitle: "No details for this line",
    submenu,
  };
}

interface UseOutputContextMenuOptions {
  anchorScrollFractions?: Map<string, number>;
  allMessages: OutputMessage[];
  hiddenTargetKeys: readonly string[];
  stepScrollFractions: Map<string, number>;
  lastCliIndexPerStep: Map<string, number>;
  /** The rendered output rows, for the Details of the row under the pointer. */
  rows: readonly OutputRenderRow[];
  /** Workflow steps, used to name each section of Copy All Responses. */
  steps: readonly WorkflowStep[];
  finalStep: WorkflowStep | null;
  onOpenFind: () => void;
}

export function useOutputContextMenu({
  anchorScrollFractions,
  allMessages,
  hiddenTargetKeys,
  stepScrollFractions,
  lastCliIndexPerStep,
  rows,
  steps,
  finalStep,
  onOpenFind,
}: UseOutputContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const openContextMenu = useCallback(
    (
      x: number,
      y: number,
      scrollContainer: HTMLDivElement,
      target?: EventTarget | null
    ) => {
      // Capture selection before the menu click clears it
      const selectedText = window.getSelection()?.toString() ?? "";
      const hoveredRow = findRowAt(x, y, target, rows);
      const hoveredRowDetails = hoveredRow
        ? describeRowDetails(hoveredRow)
        : undefined;

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
      let hoveredOutput: CliOutputType | undefined;
      let hoveredTarget: OutputMessage["target"] | undefined;
      let hoveredPrompt: string | undefined;
      if (hoveredStepKey) {
        const lastCliIdx = lastCliIndexPerStep.get(hoveredStepKey);
        if (lastCliIdx !== undefined) {
          const msg = allMessages[lastCliIdx];
          if (msg?.type === OUTPUT_MESSAGE_TYPES.CLI) {
            hoveredOutput = msg.data as CliOutputType;
            hoveredTarget = msg.target;
            hoveredPrompt = msg.prompt;
            hoveredOutputText = getStepAssistantTextForCopy(hoveredOutput);
          }
        }
      }

      const copyAllText = buildCopyAllText(
        allMessages,
        lastCliIndexPerStep,
        hiddenTargetKeys,
        { steps, finalStep }
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
      const hoveredCopyLabels = getStepCopyLabels(
        !!hoveredOutput && isScriptOutput(hoveredOutput)
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
            label: formatCopyAllResponsesLabel(hiddenStepCount),
            icon: "codicon-copy",
            disabled: !hasAnyOutput || copyAllText.length === 0,
            title: OUTPUT_COPY_MENU_TITLES.ALL_RESPONSES,
            disabledTitle: "No output to copy",
            onClick: () => {
              void writeClipboardText(copyAllText);
            },
          },
          {
            label: hoveredCopyLabels.outputMenu,
            icon: "codicon-copy",
            disabled: !hoveredOutputText,
            title: hoveredCopyLabels.title,
            disabledTitle: hoveredStepKey
              ? "No output to copy for this step"
              : "No step under cursor",
            onClick: () => {
              if (!hoveredOutputText) return;
              void writeClipboardText(hoveredOutputText);
            },
          },
          {
            label: OUTPUT_COPY_MENU_LABELS.COPY_STEP_TRANSCRIPT,
            icon: "codicon-copy",
            disabled: !hoveredOutput || !hoveredTarget,
            title: hoveredCopyLabels.transcriptTitle,
            disabledTitle: hoveredStepKey
              ? "No output to copy for this step"
              : "No step under cursor",
            onClick: () => {
              if (!hoveredOutput || !hoveredTarget) return;
              void writeClipboardText(
                generateSingleStepMarkdownExport(
                  hoveredOutput,
                  hoveredTarget,
                  hoveredPrompt
                )
              );
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
          { type: "divider" },
          buildDetailsEntry(hoveredRowDetails),
        ],
      });
    },
    [
      anchorScrollFractions,
      allMessages,
      hiddenTargetKeys,
      stepScrollFractions,
      lastCliIndexPerStep,
      rows,
      steps,
      finalStep,
      onOpenFind,
    ]
  );

  const outputContextMenuPortal = contextMenu ? (
    <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, outputContextMenuPortal };
}
