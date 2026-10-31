import { useState } from "react";
import { WORKSPACE_MEDIA_KINDS, type WorkspaceMediaKind } from "@root/types/DashboardConstants";

/* eslint-disable jsx-a11y/media-has-caption -- Workspace files may not include caption tracks. */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- Native load failures need an inline fallback. */

export const WORKSPACE_MEDIA_LABELS = {
  CANNOT_PLAY: "This browser can't play this file",
  CANNOT_DISPLAY_IMAGE: "This image can't be displayed",
  OPEN_IN_NEW_TAB: "Open in new tab",
  DOWNLOAD: "Download",
} as const;

interface WorkspaceMediaElementProps {
  kind: WorkspaceMediaKind;
  rawUrl: string;
  label: string;
  compact?: boolean;
}

/** Shared raw-URL renderer for workspace media files and diff sides. */
export function WorkspaceMediaElement({
  kind,
  rawUrl,
  label,
  compact = false,
}: WorkspaceMediaElementProps) {
  const [errorUrl, setErrorUrl] = useState<string | null>(null);
  const hasError = errorUrl === rawUrl;
  const linkClass = "text-link-fg underline";
  const frameClass = compact
    ? "max-h-full max-w-full"
    : "max-h-full max-w-full";

  if (hasError) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 text-center text-xs text-description-fg">
        <span role="status">
          {kind === WORKSPACE_MEDIA_KINDS.IMAGE
            ? WORKSPACE_MEDIA_LABELS.CANNOT_DISPLAY_IMAGE
            : WORKSPACE_MEDIA_LABELS.CANNOT_PLAY}
        </span>
        <div className="flex items-center gap-3">
          <a href={rawUrl} target="_blank" rel="noopener" className={linkClass}>
            {WORKSPACE_MEDIA_LABELS.OPEN_IN_NEW_TAB}
          </a>
          <a href={rawUrl} download className={linkClass}>
            {WORKSPACE_MEDIA_LABELS.DOWNLOAD}
          </a>
        </div>
      </div>
    );
  }

  const onError = () => setErrorUrl(rawUrl);
  if (kind === WORKSPACE_MEDIA_KINDS.IMAGE) {
    return (
      <img
        src={rawUrl}
        alt={label}
        title={compact ? undefined : label}
        onError={onError}
        className={`${frameClass} object-contain`}
      />
    );
  }
  if (kind === WORKSPACE_MEDIA_KINDS.VIDEO) {
    return (
      <video
        src={rawUrl}
        controls
        preload="metadata"
        playsInline
        aria-label={label}
        onError={onError}
        className={`${frameClass} ${compact ? "w-full object-contain" : "w-full"}`}
      />
    );
  }
  if (kind === WORKSPACE_MEDIA_KINDS.AUDIO) {
    return (
      <audio
        src={rawUrl}
        controls
        preload="metadata"
        aria-label={label}
        onError={onError}
        className="w-full"
      />
    );
  }
  return null;
}
