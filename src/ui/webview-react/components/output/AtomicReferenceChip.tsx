import type { CSSProperties, ReactNode } from "react";
import { useLongPress } from "@hooks/useLongPress";
import { useReferenceChipContextMenu } from "@hooks/useReferenceChipContextMenu";
import { buildReferenceChipMenuItems } from "@utils/referenceChipMenu";
import {
  projectAtomicReferenceFind,
  SYMBOL_ICON_COLORS,
  type AtomicReferenceChip as AtomicReferenceDescriptor,
  type AtomicReferencePresentation,
} from "@utils/atomicReferences";
import type { RowFindDecoration } from "@utils/outputFind";
import { ATOMIC_REFERENCE_KINDS } from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

export interface AtomicReferenceChipProps {
  descriptor: AtomicReferenceDescriptor;
  presentation: AtomicReferencePresentation;
  findMatches?: RowFindDecoration["matches"];
  /** Open the reference; also the context menu's Go to Reference. */
  onOpen: () => void;
  className?: string;
}

/** Accessible name (and plain-link tooltip) describing what opening a reference does. */
export function atomicReferenceAriaLabel(
  descriptor: AtomicReferenceDescriptor
): string {
  const { attrs, title } = descriptor;
  const type = attrs["data-type"];
  switch (type) {
    case ATOMIC_REFERENCE_KINDS.DIRECTORY:
      return `Reveal ${attrs["data-path"] ?? title}`;
    case ATOMIC_REFERENCE_KINDS.LINE_RANGE:
      return `Open ${attrs["data-path"] ?? title}:${attrs["data-line-start"] ?? ""}-${attrs["data-line-end"] ?? ""}`;
    case ATOMIC_REFERENCE_KINDS.SYMBOL:
      return `Go to ${attrs["data-symbol-name"] ?? "symbol"} in ${attrs["data-path"] ?? title}:${attrs["data-line-start"] ?? ""}-${attrs["data-line-end"] ?? ""}`;
    case ATOMIC_REFERENCE_KINDS.GIT:
      return `Open git ${attrs["data-git-ref"] ?? title}`;
    case ATOMIC_REFERENCE_KINDS.PRIOR_CONTEXT:
      return `Open ${title}`;
    case ATOMIC_REFERENCE_KINDS.SKILL:
      return `Open ctrlyoke skill ${attrs["data-skill-name"] ?? title}`;
    case ATOMIC_REFERENCE_KINDS.MCP:
      return `Open ctrlyoke MCP server ${attrs["data-mcp-server-name"] ?? title} in MCP Manager`;
    case ATOMIC_REFERENCE_KINDS.SECRET:
      return `Open ctrlyoke Secrets settings for ${attrs["data-secret-name"] ?? title}`;
    case ATOMIC_REFERENCE_KINDS.FILE:
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

/**
 * A native, selectable output reference chip. Right-click or long-press opens
 * the shared chip menu (Go to / Copy Reference); the output is read-only, so
 * it has no Send as Plain Text.
 */
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
  const { openReferenceChipMenu, referenceChipMenuPortal } =
    useReferenceChipContextMenu();
  const openMenu = (x: number, y: number) =>
    openReferenceChipMenu(
      x,
      y,
      buildReferenceChipMenuItems({
        open: onOpen,
        sourceText: presentation.sourceText,
        invalid: descriptor.invalid,
      })
    );
  const longPressHandlers = useLongPress(openMenu);

  // The portal is a sibling, not a child: React bubbles synthetic events
  // through portals, so a menu inside the button would reach its handlers.
  return (
    <>
      <button
        type="button"
        className={["atomic-reference-chip", className]
          .filter(Boolean)
          .join(" ")}
        title={descriptor.title}
        aria-label={atomicReferenceAriaLabel(descriptor)}
        onClick={() => onOpen()}
        onContextMenu={(event) => {
          // Take precedence over the output pane's own context menu.
          event.preventDefault();
          event.stopPropagation();
          openMenu(event.clientX, event.clientY);
        }}
        {...longPressHandlers}
        onTouchStart={(event) => {
          // Keep the output pane's long-press menu from arming as well.
          event.stopPropagation();
          longPressHandlers.onTouchStart(event);
        }}
        style={style}
        data-atomic-reference-copy-text={projected.selectionText}
        data-atomic-reference-source-text={presentation.sourceText}
        {...descriptor.attrs}
        {...(descriptor.invalid ? { "data-invalid": "true" } : {})}
      >
        <Icon name={descriptor.icon} className="atomic-reference-chip-icon" />
        <span className="atomic-reference-chip-label">
          {renderLabel(projected.text, projected.marks)}
        </span>
      </button>
      {referenceChipMenuPortal}
    </>
  );
}
