import React from "react";
import type { WorkspaceImageDiffSides } from "@root/types/HostedWorkspaceViewerTypes";
import { Icon } from "../shared/Icon";

export interface ImageDiffViewProps {
  path?: string;
  sides: WorkspaceImageDiffSides;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const checkerboardStyle: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, rgba(127, 127, 127, 0.16) 25%, transparent 25%), linear-gradient(-45deg, rgba(127, 127, 127, 0.16) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.16) 75%), linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.16) 75%)",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
  backgroundSize: "16px 16px",
};

function ImageSide({
  label,
  dataUri,
  path,
}: {
  label: "Before" | "After";
  dataUri?: string;
  path?: string;
}) {
  const sideName = path
    ? `${path} ${label.toLowerCase()}`
    : label.toLowerCase();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h4 className="text-xs font-semibold text-description-fg">{label}</h4>
      <div
        className="flex h-64 min-w-72 items-center justify-center overflow-hidden rounded border border-panel-border bg-editor-bg"
        style={checkerboardStyle}
      >
        {dataUri ? (
          <img
            src={dataUri}
            alt={sideName}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div
            role="img"
            aria-label={`${sideName} image unavailable`}
            className="px-4 text-center text-xs italic text-description-fg"
          >
            {label === "Before" ? "No previous image" : "No new image"}
          </div>
        )}
      </div>
    </div>
  );
}

/** Direct before/after image comparison; this intentionally does not use DiffView. */
export const ImageDiffView: React.FC<ImageDiffViewProps> = ({
  path,
  sides,
  collapsed = false,
  onCollapsedChange,
}) => (
  <div className="my-1 border-t border-panel-border px-2.5 py-2">
    <button
      type="button"
      className="flex items-center gap-1.5 text-xs text-description-fg"
      aria-label="Toggle image diff"
      aria-expanded={!collapsed}
      onClick={() => onCollapsedChange?.(!collapsed)}
    >
      <Icon
        name="chevron-right"
        className={`text-xxs transition-transform ${collapsed ? "" : "rotate-90"}`}
      />
      <span>{collapsed ? "Show image diff" : "Hide image diff"}</span>
    </button>
    {!collapsed && (
      <div className="mt-2 max-w-full overflow-x-auto">
        <div className="grid min-w-[36rem] grid-cols-2 gap-3">
          <ImageSide
            label="Before"
            dataUri={sides.oldImageDataUri}
            path={path}
          />
          <ImageSide
            label="After"
            dataUri={sides.newImageDataUri}
            path={path}
          />
        </div>
      </div>
    )}
  </div>
);
