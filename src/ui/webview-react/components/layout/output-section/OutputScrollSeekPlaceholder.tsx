import React from "react";
import type { OutputRenderRow } from "@utils/outputRows";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { CLI_EVENT_TYPES } from "@/types/messages";

const OUTPUT_SCROLL_SEEK_TEXT_PLACEHOLDER_MIN_CHARS = 1200;

export function getWheelDeltaPixels(
  event: React.WheelEvent<HTMLDivElement>
): number {
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return event.deltaY * 16;
    case WheelEvent.DOM_DELTA_PAGE:
      return event.deltaY * event.currentTarget.clientHeight;
    default:
      return event.deltaY;
  }
}

function getScrollSeekRowLabel(row: OutputRenderRow): string {
  switch (row.rowKind) {
    case OUTPUT_ROW_KINDS.STRUCTURED_EVENT:
      if (row.diff) {
        return row.diff.renderPlan.viewType === "split"
          ? "Diff"
          : "Unified diff";
      }
      if (row.toolCall) {
        return "Tool call";
      }
      return row.event.type;
    case OUTPUT_ROW_KINDS.CLI_HEADER:
      return row.stepLabel;
    case OUTPUT_ROW_KINDS.CLI_COMMAND:
      return "Command";
    case OUTPUT_ROW_KINDS.SCRIPT_COMMAND:
      return "Script command";
    case OUTPUT_ROW_KINDS.PLAIN_RESPONSE:
      return "Response";
    case OUTPUT_ROW_KINDS.SCRIPT_OUTPUT:
      return "Script output";
    case OUTPUT_ROW_KINDS.PROMPT:
      return "Prompt";
    case OUTPUT_ROW_KINDS.STATUS:
      return "Status";
    case OUTPUT_ROW_KINDS.STATS:
      return "Stats";
    case OUTPUT_ROW_KINDS.SCRIPT_VERDICT:
      return "Script verdict";
    case OUTPUT_ROW_KINDS.ATTEMPT_GROUP_SUMMARY:
      return "Attempts";
    case OUTPUT_ROW_KINDS.ERROR:
      return "Error";
    case OUTPUT_ROW_KINDS.STEP_ANCHOR:
      return "Step";
    case OUTPUT_ROW_KINDS.FINAL_STEP_LABEL:
      return row.label;
  }
}

export function shouldRenderScrollSeekPlaceholder(
  row: OutputRenderRow
): boolean {
  switch (row.rowKind) {
    case OUTPUT_ROW_KINDS.PLAIN_RESPONSE:
    case OUTPUT_ROW_KINDS.SCRIPT_OUTPUT:
      return row.text.length >= OUTPUT_SCROLL_SEEK_TEXT_PLACEHOLDER_MIN_CHARS;
    case OUTPUT_ROW_KINDS.STRUCTURED_EVENT:
      if (row.diff || row.toolCall) {
        return true;
      }

      switch (row.event.type) {
        case CLI_EVENT_TYPES.BASH_COMMAND:
        case CLI_EVENT_TYPES.FILE_EDIT:
        case CLI_EVENT_TYPES.FILE_WRITE:
        case CLI_EVENT_TYPES.FILE_READ:
        case CLI_EVENT_TYPES.FILE_DELETE:
        case CLI_EVENT_TYPES.MCP_TOOL_CALL:
        case CLI_EVENT_TYPES.TOOL_CALL:
        case CLI_EVENT_TYPES.TOOL_RESULT:
          return true;
        case CLI_EVENT_TYPES.TEXT:
        case CLI_EVENT_TYPES.THINKING: {
          const data = row.event.data as { text?: string };
          return (
            (data.text?.length ?? 0) >=
            OUTPUT_SCROLL_SEEK_TEXT_PLACEHOLDER_MIN_CHARS
          );
        }
        default:
          return false;
      }
    default:
      return false;
  }
}

export const OutputScrollSeekPlaceholder: React.FC<{
  row: OutputRenderRow;
  height: number;
}> = ({ row, height }) => (
  <div
    className="px-2 py-1 text-[length:var(--fp-output-font-size-xs)] text-description-fg"
    style={{
      height: `${Math.max(1, height)}px`,
      contain: "layout paint style",
    }}
  >
    <div className="h-full min-h-6 rounded border border-panel-border bg-sidebar-bg/40 px-2 py-1 overflow-hidden">
      <span className="opacity-80">
        Rendering {getScrollSeekRowLabel(row)}...
      </span>
    </div>
  </div>
);
