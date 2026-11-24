import type { ReactNode } from "react";
import { COLUMN_HEADING_CLASS } from "./headingStyles";

type HeadingLevel = 2 | 3 | 4;

interface PageTitleProps {
  title: string;
  /**
   * Heading level, chosen to fit under the surface's own heading: settings
   * pages sit under the drawer title (h2), property drawers under their h3.
   */
  level?: HeadingLevel;
  /** Hover text for the title, e.g. the schema tooltip of the field it names. */
  tooltip?: string;
  /** Controls aligned to the right end of the title row. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The title row at the top of a settings or properties page: an uppercase
 * label over a divider. Sections below it should not repeat the title.
 */
export function PageTitle({
  title,
  level = 2,
  tooltip,
  actions,
  className,
}: PageTitleProps) {
  const Heading = `h${level}` as const;
  return (
    <div
      className={`flex min-h-6 shrink-0 items-center justify-between gap-2 border-b border-panel-border pb-1 mb-2${className ? ` ${className}` : ""}`}
    >
      <Heading
        title={tooltip}
        className={`${COLUMN_HEADING_CLASS}${tooltip ? " cursor-help" : ""}`}
      >
        {title}
      </Heading>
      {actions && (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      )}
    </div>
  );
}
