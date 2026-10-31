import React from "react";
import type { WorkspaceMediaDiffSides } from "@root/types/HostedWorkspaceViewerTypes";
import { WORKSPACE_MEDIA_KINDS } from "@root/types/DashboardConstants";
import { workspaceRawUrl } from "@utils/hostedApi";
import { WorkspaceMediaElement } from "@components/shared/WorkspaceMediaElement";
import { Icon } from "../shared/Icon";

export interface MediaDiffViewProps {
  path?: string;
  sides: WorkspaceMediaDiffSides;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const checkerboardStyle: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, rgba(127, 127, 127, 0.16) 25%, transparent 25%), linear-gradient(-45deg, rgba(127, 127, 127, 0.16) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.16) 75%), linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.16) 75%)",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
  backgroundSize: "16px 16px",
};

function MediaSide({
  label,
  side,
  mediaKind,
  path,
}: {
  label: "Before" | "After";
  side?: WorkspaceMediaDiffSides["old"];
  mediaKind: WorkspaceMediaDiffSides["mediaKind"];
  path?: string;
}) {
  const sideName = path
    ? `${path} ${label.toLowerCase()}`
    : label.toLowerCase();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h4 className="text-xs font-semibold text-description-fg">{label}</h4>
      <div
        className="flex h-64 min-w-72 items-center justify-center overflow-hidden rounded-sm border border-panel-border bg-editor-bg"
        style={checkerboardStyle}
      >
        {side && mediaKind !== WORKSPACE_MEDIA_KINDS.PDF ? (
          <WorkspaceMediaElement
            kind={mediaKind}
            rawUrl={workspaceRawUrl(side)}
            label={sideName}
            compact
          />
        ) : (
          <div
            role="img"
            aria-label={`${sideName} ${mediaKind} unavailable`}
            className="px-4 text-center text-xs italic text-description-fg"
          >
            {side ? `${mediaKind} preview` : label === "Before" ? `No previous ${mediaKind}` : `No new ${mediaKind}`}
            {side && (
              <a href={workspaceRawUrl(side)} target="_blank" rel="noreferrer" className="ml-2 text-link-fg underline">
                Open in new tab
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Direct before/after media comparison; this intentionally does not use DiffView. */
export const MediaDiffView: React.FC<MediaDiffViewProps> = ({
  path,
  sides,
  collapsed = false,
  onCollapsedChange,
}) => (
  <div className="my-1 border-t border-panel-border px-2.5 py-2">
    <button
      type="button"
      className="flex items-center gap-1.5 text-xs text-description-fg"
      aria-label="Toggle media diff"
      aria-expanded={!collapsed}
      onClick={() => onCollapsedChange?.(!collapsed)}
    >
      <Icon
        name="chevron-right"
        className={`text-xxs transition-transform ${collapsed ? "" : "rotate-90"}`}
      />
      <span>{collapsed ? "Show media diff" : "Hide media diff"}</span>
    </button>
    {!collapsed && (
      <div className="mt-2 max-w-full overflow-x-auto">
        <div className="grid min-w-xl grid-cols-2 gap-3">
          <MediaSide
            label="Before"
            side={sides.old}
            mediaKind={sides.mediaKind}
            path={path}
          />
          <MediaSide
            label="After"
            side={sides.new}
            mediaKind={sides.mediaKind}
            path={path}
          />
        </div>
      </div>
    )}
  </div>
);
