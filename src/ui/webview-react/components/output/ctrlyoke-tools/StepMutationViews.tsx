import React from "react";
import { DiffView } from "@components/output/DiffView";
import { McpToolCallOutput } from "@components/output/ToolCallOutput";
import { TOOL_CALL_EXPANSION_SECTIONS } from "@root/types/DashboardConstants";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type { RowFindDecoration } from "@utils/outputFind";
import type { McpToolCallData } from "../../../types/cliEvents";
import type { CtrlYokeToolBodyProps } from "./viewComponents";
import {
  editStepChangedFields,
  editStepSummary,
  reorderStepPairs,
  reorderStepsSummary,
  STEP_MUTATION_PROMPT_FIELD,
} from "./stepMutationModel";
import type {
  EditStepParams,
  EditStepResult,
  ReorderStepsParams,
  ReorderStepsResult,
  SubmitCommitMessageParams,
} from "./stepMutationModel";

function RawToggle({
  data,
  expansion,
  onExpansionChange,
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
}: {
  data: McpToolCallData;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  paramsFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
}) {
  return (
    <>
      <button
        type="button"
        className="text-bash-expand-link no-underline text-[length:var(--cy-output-font-size-sm)] cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
        aria-expanded={expansion.rawExpanded ?? false}
        onClick={() => {
          const opening = !(expansion.rawExpanded ?? false);
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
    </>
  );
}

export const EditStepBody: React.FC<CtrlYokeToolBodyProps> = (props) => {
  const params = props.params as EditStepParams | undefined;
  const result = props.result as EditStepResult;
  const updates = params?.updates ?? result.updates ?? {};
  const cleared = params?.clearProperties?.length
    ? params.clearProperties
    : result.clearProperties;
  const fields = editStepChangedFields(params, result);
  const prompt =
    typeof updates.prompt === "string" ? updates.prompt : undefined;
  const oldPrompt =
    typeof result.before?.prompt === "string" ? result.before.prompt : "";
  const summary = editStepSummary(params, result);
  return (
    <div className="space-y-1">
      {fields.length > 0 && (
        <ul className="m-0 list-none space-y-0.5 p-0 text-[length:var(--cy-output-font-size-sm)]">
          {fields.map((field) => {
            const value = updates[field];
            const before = result.before?.[field];
            const hasBefore = Object.prototype.hasOwnProperty.call(
              result.before ?? {},
              field
            );
            return (
              <li key={field} className="break-words">
                <span className="font-medium">{field}</span>:{" "}
                {hasBefore ? <>{String(before)} → </> : null}
                {field === STEP_MUTATION_PROMPT_FIELD
                  ? "updated below"
                  : value === undefined
                    ? "updated"
                    : String(value)}
              </li>
            );
          })}
          {cleared.map((field) => (
            <li key={`clear-${field}`} className="break-words">
              <s>{field}</s>: inherited default
            </li>
          ))}
        </ul>
      )}
      {prompt !== undefined && (
        <div aria-label="Prompt change">
          <DiffView
            oldContent={oldPrompt}
            newContent={prompt}
            globallyCollapsed={false}
            collapsed={false}
            viewType="unified"
            outerMarginClassName="my-1"
          />
        </div>
      )}
      {fields.length === 0 && !prompt && (
        <div className="text-[length:var(--cy-output-font-size-sm)] text-muted-foreground">
          {summary}
        </div>
      )}
      <RawToggle
        data={props.data}
        expansion={props.expansion}
        onExpansionChange={props.onExpansionChange}
        paramsFindMatches={props.paramsFindMatches}
        outputFindMatches={props.outputFindMatches}
        errorFindMatches={props.errorFindMatches}
      />
    </div>
  );
};

export const RemoveStepBody: React.FC<CtrlYokeToolBodyProps> = (props) => {
  return (
    <div className="space-y-1">
      <RawToggle
        data={props.data}
        expansion={props.expansion}
        onExpansionChange={props.onExpansionChange}
      />
    </div>
  );
};

export const ReorderStepsBody: React.FC<CtrlYokeToolBodyProps> = (props) => {
  const params = props.params as ReorderStepsParams | undefined;
  const result = props.result as ReorderStepsResult;
  return (
    <div className="space-y-1">
      <div className="text-[length:var(--cy-output-font-size-sm)] font-medium">
        {reorderStepsSummary(params, result)}
      </div>
      <ol className="m-0 list-none space-y-0.5 p-0 text-[length:var(--cy-output-font-size-sm)]">
        {reorderStepPairs(params, result).map((pair) => (
          <li key={pair}>{pair}</li>
        ))}
      </ol>
      <RawToggle
        data={props.data}
        expansion={props.expansion}
        onExpansionChange={props.onExpansionChange}
      />
    </div>
  );
};

export const SubmitCommitMessageBody: React.FC<CtrlYokeToolBodyProps> = (
  props
) => {
  const params = props.params as SubmitCommitMessageParams | undefined;
  const message = params?.message;
  return (
    <div className="space-y-1">
      {message && (
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[length:var(--cy-output-font-size-sm)]">
          {message}
        </pre>
      )}
      <RawToggle
        data={props.data}
        expansion={props.expansion}
        onExpansionChange={props.onExpansionChange}
      />
    </div>
  );
};
