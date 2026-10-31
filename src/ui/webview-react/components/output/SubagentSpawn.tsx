import { memo, useId, type ReactNode } from "react";
import type { SubagentSpawn } from "@root/types/CliOutputTypes";
import {
  SUBAGENT_SPAWN_STATES,
  TOOL_CALL_EXPANSION_SECTIONS,
} from "@root/types/DashboardConstants";
import type { ToolResult } from "../../types/cliEvents";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import { useToolCallExpansion } from "./ToolCallOutput";

interface SubagentSpawnOutputProps {
  name: string;
  spawn: SubagentSpawn;
  result?: ToolResult;
  descriptionFindMatches?: RowFindDecoration["matches"];
  statusFindMatches?: RowFindDecoration["matches"];
  promptFindMatches?: RowFindDecoration["matches"];
  /** Matches in the response, offset against `getToolResultText(result)`. */
  resultFindMatches?: RowFindDecoration["matches"];
  /** Row-owned state, so a toggle survives the row scrolling out of view. */
  expansion?: ToolCallExpansionState;
  onExpansionChange?: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
}

/** Marks a spawn card and every row of its child activity as a subagent's. */
export const SUBAGENT_LABEL_PREFIX = "Subagent: ";

/** Whether the card shows the result's error rather than its output. */
function isSubagentSpawnResultError(result?: ToolResult): boolean {
  return !!result && !result.success && typeof result.error === "string";
}

interface SpawnDisclosureProps {
  noun: string;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  className: string;
  contentClassName: string;
  children: ReactNode;
}

/**
 * A collapsed-by-default section of the spawn card. The prompt and the
 * response mostly repeat what the child's own rows already show, so they stay
 * one click away rather than taking the card's height.
 */
function SpawnDisclosure({
  noun,
  expanded,
  onToggle,
  className,
  contentClassName,
  children,
}: SpawnDisclosureProps) {
  const contentId = useId();
  return (
    <div className={className}>
      <button
        type="button"
        className="cy-dropdown-row rounded-sm text-xs text-description-fg hover:text-foreground"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => onToggle(!expanded)}
      >
        {expanded ? `Hide ${noun}` : `Show ${noun}`}
      </button>
      {expanded && (
        <pre id={contentId} className={contentClassName}>
          {children}
        </pre>
      )}
    </div>
  );
}

/** Renders the spawn lifecycle independently of the tool result lifecycle. */
export const SubagentSpawnOutput = memo<SubagentSpawnOutputProps>(
  ({
    name,
    spawn,
    result,
    descriptionFindMatches,
    statusFindMatches,
    promptFindMatches,
    resultFindMatches,
    expansion,
    onExpansionChange,
  }) => {
    const [resolvedExpansion, updateExpansion] = useToolCallExpansion(
      expansion,
      onExpansionChange
    );
    const label =
      spawn.children?.map((child) => child.label || child.agentId).join(", ") ||
      spawn.agentType ||
      name;
    const stateLabel =
      spawn.state === SUBAGENT_SPAWN_STATES.COMPLETED
        ? "Completed"
        : spawn.state === SUBAGENT_SPAWN_STATES.FAILED
          ? "Failed"
          : "Running";
    // Same error-over-output rule as getToolResultText, which find offsets
    // are computed against. A background launch's result only acknowledges
    // the launch; the agent's report arrives later as its own child activity.
    const isError = isSubagentSpawnResultError(result);
    const resultText = isError
      ? result?.error
      : spawn.background
        ? undefined
        : result?.output;
    const resultSection = isError
      ? TOOL_CALL_EXPANSION_SECTIONS.ERROR
      : TOOL_CALL_EXPANSION_SECTIONS.OUTPUT;
    const resultExpanded = isError
      ? resolvedExpansion.errorExpanded
      : resolvedExpansion.outputExpanded;

    return (
      <section className="rounded-md border border-panel-border bg-panel px-3 py-2 text-sm">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1 font-medium">
            {SUBAGENT_LABEL_PREFIX}
            {highlightText(
              spawn.description || label,
              descriptionFindMatches ?? []
            )}
          </span>
          {spawn.children?.length ? (
            <span className="text-xs text-description-fg">{label}</span>
          ) : null}
          {spawn.agentType && (
            <span className="text-xs text-description-fg">
              {spawn.agentType}
            </span>
          )}
          <span className="text-xs text-description-fg">{stateLabel}</span>
        </header>
        {spawn.statusLine && (
          <div className="mt-1 text-description-fg">
            {highlightText(spawn.statusLine, statusFindMatches ?? [])}
          </div>
        )}
        {spawn.prompt && (
          <SpawnDisclosure
            noun="prompt"
            expanded={resolvedExpansion.subagentPromptExpanded ?? false}
            onToggle={(expanded) =>
              updateExpansion(
                TOOL_CALL_EXPANSION_SECTIONS.SUBAGENT_PROMPT,
                expanded
              )
            }
            className="mt-2"
            contentClassName="mt-1 whitespace-pre-wrap wrap-anywhere border-l border-panel-border pl-2 font-sans text-description-fg"
          >
            {highlightText(spawn.prompt, promptFindMatches ?? [])}
          </SpawnDisclosure>
        )}
        {resultText && (
          <SpawnDisclosure
            noun={isError ? "error" : "response"}
            expanded={resultExpanded}
            onToggle={(expanded) => updateExpansion(resultSection, expanded)}
            className="mt-2 border-t border-panel-border pt-2"
            contentClassName="mt-1 whitespace-pre-wrap wrap-anywhere"
          >
            {highlightText(resultText, resultFindMatches ?? [])}
          </SpawnDisclosure>
        )}
      </section>
    );
  }
);
SubagentSpawnOutput.displayName = "SubagentSpawnOutput";
