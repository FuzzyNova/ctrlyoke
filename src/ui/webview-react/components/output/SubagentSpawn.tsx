import { memo, useId, useState } from "react";
import type { SubagentSpawn } from "@root/types/CliOutputTypes";
import { SUBAGENT_SPAWN_STATES } from "@root/types/DashboardConstants";
import type { ToolResult } from "../../types/cliEvents";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";

interface SubagentSpawnOutputProps {
  name: string;
  spawn: SubagentSpawn;
  result?: ToolResult;
  descriptionFindMatches?: RowFindDecoration["matches"];
  statusFindMatches?: RowFindDecoration["matches"];
  promptFindMatches?: RowFindDecoration["matches"];
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
  }) => {
    const [promptExpanded, setPromptExpanded] = useState(false);
    const promptId = useId();
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
    const resultText = result?.error || result?.output;

    return (
      <section className="rounded-md border border-panel-border bg-panel px-3 py-2 text-sm">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1 font-medium">
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
          <div className="mt-2">
            <button
              type="button"
              className="cy-dropdown-row rounded-sm text-xs text-description-fg hover:text-foreground"
              aria-expanded={promptExpanded}
              aria-controls={promptId}
              onClick={() => setPromptExpanded((expanded) => !expanded)}
            >
              {promptExpanded ? "Hide prompt" : "Show prompt"}
            </button>
            {promptExpanded && (
              <pre
                id={promptId}
                className="mt-1 whitespace-pre-wrap wrap-anywhere border-l border-panel-border pl-2 font-sans text-description-fg"
              >
                {highlightText(spawn.prompt, promptFindMatches ?? [])}
              </pre>
            )}
          </div>
        )}
        {resultText && (
          <pre className="mt-2 whitespace-pre-wrap wrap-anywhere border-t border-panel-border pt-2">
            {resultText}
          </pre>
        )}
      </section>
    );
  }
);
SubagentSpawnOutput.displayName = "SubagentSpawnOutput";
