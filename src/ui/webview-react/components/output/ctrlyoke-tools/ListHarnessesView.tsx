import React from "react";
import { McpToolCallOutput } from "@components/output/ToolCallOutput";
import { TOOL_CALL_EXPANSION_SECTIONS } from "@root/types/DashboardConstants";
import { allHarnesses, type ListHarnessesResult } from "./listHarnessesModel";
import type { ToolViewBodyProps } from "./WorkflowStatusView";
export const ListHarnessesBody: React.FC<ToolViewBodyProps> = ({
  result,
  data,
  expansion,
  onExpansionChange,
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
}) => {
  const modelsExpanded = expansion.listHarnessModelsExpanded ?? false;
  return (
    <div className="space-y-2 text-[length:var(--cy-output-font-size-sm)]">
      <ul className="flex flex-wrap gap-2">
        {allHarnesses(result as ListHarnessesResult).map((harness) => (
          <li key={harness.id} className="space-y-1">
            <span
              className={`inline-flex rounded-full px-2 py-1 ${harness.available ? "bg-[var(--vscode-testing-iconPassed)]/20 text-[var(--vscode-testing-iconPassed)]" : "bg-muted text-muted-foreground"}`}
            >
              {harness.displayName} ·{" "}
              {harness.available ? "available" : "unavailable"}
            </span>
            {modelsExpanded &&
              (harness.models?.length ? (
                <div className="px-2 text-muted-foreground">
                  {harness.models.join(", ")}
                </div>
              ) : null)}
          </li>
        ))}
      </ul>
      {allHarnesses(result as ListHarnessesResult).some(
        (h) => !!h.models?.length
      ) && (
        <button
          type="button"
          className="text-bash-expand-link cursor-pointer bg-transparent p-0 text-[length:var(--cy-output-font-size-sm)] hover:underline"
          aria-expanded={modelsExpanded}
          onClick={() =>
            onExpansionChange(
              TOOL_CALL_EXPANSION_SECTIONS.LIST_HARNESS_MODELS,
              !modelsExpanded
            )
          }
        >
          {modelsExpanded ? "Hide models" : "Show models"}
        </button>
      )}
      <button
        type="button"
        className="text-bash-expand-link cursor-pointer bg-transparent p-0 text-[length:var(--cy-output-font-size-sm)] hover:underline"
        aria-expanded={!!expansion.rawExpanded}
        onClick={() => {
          const opening = !expansion.rawExpanded;
          onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.RAW, opening);
          if (opening)
            onExpansionChange(TOOL_CALL_EXPANSION_SECTIONS.PARAMS, true);
        }}
      >
        {expansion.rawExpanded ? "Hide raw" : "Raw"}
      </button>
      {expansion.rawExpanded && (
        <McpToolCallOutput
          server={data.server}
          tool={data.tool}
          parameters={data.parameters}
          result={data.result}
          paramsFindMatches={paramsFindMatches}
          outputFindMatches={outputFindMatches}
          errorFindMatches={errorFindMatches}
          expansion={expansion}
          onExpansionChange={onExpansionChange}
        />
      )}
    </div>
  );
};
