import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import {
  projectAtomicReferenceFind,
  SYMBOL_ICON_COLORS,
  type AtomicReferenceChip as AtomicReferenceDescriptor,
  type AtomicReferencePresentation,
} from "@utils/atomicReferences";
import type { RowFindDecoration } from "@utils/outputFind";

export interface AtomicReferenceChipProps {
  descriptor: AtomicReferenceDescriptor;
  presentation: AtomicReferencePresentation;
  findMatches?: RowFindDecoration["matches"];
  onOpen: MouseEventHandler<HTMLButtonElement>;
  className?: string;
}

function atomicReferenceAriaLabel(
  descriptor: AtomicReferenceDescriptor
): string {
  const { attrs, title } = descriptor;
  const type = attrs["data-type"];
  switch (type) {
    case "directory":
      return `Reveal ${attrs["data-path"] ?? title}`;
    case "lineRange":
      return `Open ${attrs["data-path"] ?? title}:${attrs["data-line-start"] ?? ""}-${attrs["data-line-end"] ?? ""}`;
    case "symbol":
      return `Go to ${attrs["data-symbol-name"] ?? "symbol"} in ${attrs["data-path"] ?? title}:${attrs["data-line-start"] ?? ""}-${attrs["data-line-end"] ?? ""}`;
    case "git":
      return `Open git ${attrs["data-git-ref"] ?? title}`;
    case "priorContext":
      return `Open ${title}`;
    case "file":
    default:
      return `Open ${attrs["data-path"] ?? title}`;
  }
}

function renderLabel(
  text: string,
  marks: { from: number; to: number; active: boolean }[]
): ReactNode {
  if (marks.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  marks.forEach((mark, index) => {
    if (mark.from > cursor) {
      parts.push(
        <span key={`text-${cursor}`}>{text.slice(cursor, mark.from)}</span>
      );
    }
    parts.push(
      <mark
        key={`mark-${index}-${mark.from}`}
        data-find-active={mark.active ? "true" : undefined}
      >
        {text.slice(mark.from, mark.to)}
      </mark>
    );
    cursor = mark.to;
  });
  if (cursor < text.length) {
    parts.push(<span key={`text-${cursor}`}>{text.slice(cursor)}</span>);
  }
  return parts;
}

/** A native, selectable output reference chip. */
export function AtomicReferenceChip({
  descriptor,
  presentation,
  findMatches = [],
  onOpen,
  className,
}: AtomicReferenceChipProps) {
  const projected = projectAtomicReferenceFind(presentation, findMatches);
  const iconColor = SYMBOL_ICON_COLORS[descriptor.icon];
  const style = {
    "--atomic-reference-accent": iconColor,
  } as CSSProperties;

  return (
    <button
      type="button"
      className={["atomic-reference-chip", className].filter(Boolean).join(" ")}
      title={descriptor.title}
      aria-label={atomicReferenceAriaLabel(descriptor)}
      onClick={onOpen}
      style={style}
      data-atomic-reference-copy-text={projected.selectionText}
      data-atomic-reference-source-text={presentation.sourceText}
      {...descriptor.attrs}
      {...(descriptor.invalid ? { "data-invalid": "true" } : {})}
    >
      <span
        className={`atomic-reference-chip-icon codicon codicon-${descriptor.icon}`}
        aria-hidden="true"
      />
      <span className="atomic-reference-chip-label">
        {renderLabel(projected.text, projected.marks)}
      </span>
    </button>
  );
}
