import React from "react";
import { referenceBasename } from "@utils/atomicReferences";

interface SplitPath {
  directory: string;
  basename: string;
}

function splitPath(path: string): SplitPath {
  const normalizedPath = path.replace(/\\/g, "/");
  const basename = referenceBasename(path);
  const directory = normalizedPath.slice(
    0,
    Math.max(0, normalizedPath.length - basename.length)
  );
  return { directory, basename };
}

export interface DiffFilePathLabelProps {
  path: string;
  /** Previous path — set only for a true rename. Never a /dev/null sentinel. */
  oldPath?: string;
  className?: string;
}

/** Basename(s) only — the file identity, meant to sit on the header's first line. */
export const DiffFileNameLabel: React.FC<DiffFilePathLabelProps> = ({
  path,
  oldPath,
  className,
}) => {
  const isRename = oldPath !== undefined && oldPath !== path;
  const { basename } = splitPath(path);
  const oldBasename = isRename ? splitPath(oldPath ?? "").basename : undefined;

  return (
    <span className={`flex min-w-0 items-baseline gap-1 ${className ?? ""}`}>
      {oldBasename !== undefined && (
        <>
          <span className="truncate font-medium wrap-anywhere">
            {oldBasename}
          </span>
          <span className="shrink-0 opacity-60" aria-hidden="true">
            →
          </span>
        </>
      )}
      <span className="truncate font-medium wrap-anywhere">{basename}</span>
    </span>
  );
};

/** Directory(ies) only — meant to sit on its own line below the name. */
export const DiffFileDirectoryLabel: React.FC<DiffFilePathLabelProps> = ({
  path,
  oldPath,
  className,
}) => {
  const isRename = oldPath !== undefined && oldPath !== path;
  const { directory } = splitPath(path);
  const oldDirectory = isRename
    ? splitPath(oldPath ?? "").directory
    : undefined;

  if (!directory && oldDirectory === undefined) return null;

  return (
    <span
      className={`flex min-w-0 items-baseline gap-1 opacity-60 ${className ?? ""}`}
    >
      {oldDirectory !== undefined && (
        <>
          <span className="truncate">{oldDirectory || "./"}</span>
          <span className="shrink-0" aria-hidden="true">
            →
          </span>
        </>
      )}
      <span className="truncate">{directory || "./"}</span>
    </span>
  );
};

export function diffFilePathTitle(path: string, oldPath?: string): string {
  return oldPath !== undefined && oldPath !== path
    ? `${oldPath} → ${path}`
    : path;
}
