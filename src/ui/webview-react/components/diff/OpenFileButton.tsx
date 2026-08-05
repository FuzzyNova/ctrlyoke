import React from "react";
import { openContextReference } from "@utils/contextReferenceActions";
import { getVsCodeApi } from "@hooks/useVsCodeApi";

export interface OpenFileButtonProps {
  path: string;
}

/**
 * Opens `path` the same way ctrlyoke's own @-reference links do — in the
 * hosted browser dashboard this routes through the workspace-viewer store,
 * in the VS Code panel it posts OPEN_FILE for the extension host to open
 * natively. See `contextReferenceActions.ts`.
 */
export const OpenFileButton: React.FC<OpenFileButtonProps> = ({ path }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      openContextReference({ type: "file", path }, getVsCodeApi());
    }}
    className="flex items-center justify-center rounded p-0.5 text-editor-fg opacity-60 hover:opacity-100 hover:bg-list-hover-bg transition-colors"
    title="Open file"
    aria-label={`Open ${path}`}
  >
    <i className="codicon codicon-go-to-file" aria-hidden="true" />
  </button>
);
