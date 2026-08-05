import React from "react";
import { referenceBasename } from "@utils/atomicReferences";

interface PathPartProps {
  path: string;
}

function PathPart({ path }: PathPartProps) {
  const normalizedPath = path.replace(/\\/g, "/");
  const basename = referenceBasename(path);
  const directory = normalizedPath.slice(
    0,
    Math.max(0, normalizedPath.length - basename.length)
  );

  return (
    <span className="flex min-w-0 items-baseline">
      <span className="truncate opacity-60">{directory}</span>
      <span className="shrink-0 font-medium [overflow-wrap:anywhere]">
        {basename}
      </span>
    </span>
  );
}

export interface DiffFilePathLabelProps {
  path: string;
  oldPath?: string;
}

export const DiffFilePathLabel: React.FC<DiffFilePathLabelProps> = ({
  path,
  oldPath,
}) => {
  const isRename = oldPath !== undefined && oldPath !== path;
  const title = isRename ? `${oldPath} → ${path}` : path;

  return (
    <span
      className="flex min-w-0 items-baseline gap-1"
      title={title}
      aria-label={title}
    >
      {isRename && (
        <>
          <PathPart path={oldPath ?? ""} />
          <span className="shrink-0 opacity-60" aria-hidden="true">
            →
          </span>
        </>
      )}
      <PathPart path={path} />
    </span>
  );
};
