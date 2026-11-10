import React from "react";
import type { CtrlYokeToolBodyProps } from "./viewComponents";
import { RawToolCallSection } from "./RawToolCallSection";
import type { SubmitCommitMessageParams } from "@root/utils/ctrlyokeToolViews/submitCommitMessageModel";

export const SubmitCommitMessageBody: React.FC<CtrlYokeToolBodyProps> = (
  props
) => {
  const params = props.params as SubmitCommitMessageParams | undefined;
  const message = params?.message;
  return (
    <div className="space-y-1">
      {message && (
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-sm bg-muted/40 p-2 font-mono text-(length:--cy-output-font-size-sm)">
          {message}
        </pre>
      )}
      <RawToolCallSection
        data={props.data}
        expansion={props.expansion}
        onExpansionChange={props.onExpansionChange}
      />
    </div>
  );
};
