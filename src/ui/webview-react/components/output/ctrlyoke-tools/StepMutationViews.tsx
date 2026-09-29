import React from "react";
import { DiffView } from "@components/output/DiffView";
import { RawToolCallSection } from "./RawToolCallSection";
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
  RemoveStepResult,
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
    <RawToolCallSection
      data={data}
      expansion={expansion}
      onExpansionChange={onExpansionChange}
      paramsFindMatches={paramsFindMatches}
      outputFindMatches={outputFindMatches}
      errorFindMatches={errorFindMatches}
    />
  );
}

function NoChangeNotice({
  changed,
  note,
}: {
  changed: boolean | undefined;
  note: string | undefined;
}) {
  if (changed !== false) return null;
  return (
    <div className="text-[length:var(--cy-output-font-size-sm)] text-warning-fg">
      <div className="font-medium">No change</div>
      {note && <div className="break-words">{note}</div>}
    </div>
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
    result.changed !== false && typeof updates.prompt === "string"
      ? updates.prompt
      : undefined;
  const oldPrompt =
    typeof result.before?.prompt === "string" ? result.before.prompt : "";
  const summary = editStepSummary(params, result);
  return (
    <div className="space-y-1">
      <NoChangeNotice changed={result.changed} note={result.note} />
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
      {result.changed !== false && fields.length === 0 && !prompt && (
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
  const result = props.result as RemoveStepResult;
  return (
    <div className="space-y-1">
      <NoChangeNotice changed={result.changed} note={result.note} />
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
      <NoChangeNotice changed={result.changed} note={result.note} />
      {result.changed !== false && (
        <div className="text-[length:var(--cy-output-font-size-sm)] font-medium">
          {reorderStepsSummary(params, result)}
        </div>
      )}
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
