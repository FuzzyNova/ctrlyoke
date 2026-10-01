import React from "react";
import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import {
  createAtomicReferencePresentation,
  type AtomicReferenceChip as AtomicReferenceDescriptor,
} from "@utils/atomicReferences";
import {
  contextReferenceTargetFromDescriptor,
  openContextReference,
} from "@utils/contextReferenceActions";
import {
  highlightText,
  sliceDecorationMatches,
  type RowFindDecoration,
} from "@utils/outputFind";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  AtomicReferenceChip,
  atomicReferenceAriaLabel,
} from "./AtomicReferenceChip";

interface ContextReferenceProps {
  /** Parsed reference; `from`/`to` are offsets in the row's find-search text. */
  descriptor: AtomicReferenceDescriptor;
  /** The reference exactly as written (the row text between `from` and `to`). */
  text: string;
  /** Row-relative find matches; each renderer projects its own slice. */
  matches: RowFindDecoration["matches"];
  /** Compact chip formatting (`ui.atomicContextReferences`) vs a plain text link. */
  atomicContextReferences: boolean;
}

/**
 * One ctrlyoke context reference in the output pane. Both presentations open
 * through {@link openContextReference}, so an echoed prompt and an agent's
 * Markdown reply that cite the same reference behave identically.
 */
export const ContextReference: React.FC<ContextReferenceProps> = ({
  descriptor,
  text,
  matches,
  atomicContextReferences,
}) => {
  const open = () =>
    openContextReference(
      contextReferenceTargetFromDescriptor(descriptor),
      getVsCodeApi()
    );

  if (atomicContextReferences) {
    return (
      <AtomicReferenceChip
        descriptor={descriptor}
        presentation={createAtomicReferencePresentation(descriptor, text)}
        findMatches={matches}
        onOpen={open}
      />
    );
  }

  return (
    <span
      role="link"
      tabIndex={0}
      className="cursor-pointer text-link-fg hover:text-link-active-fg hover:underline"
      title={atomicReferenceAriaLabel(descriptor)}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === KEYBOARD_KEYS.ENTER || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      {highlightText(
        text,
        sliceDecorationMatches({ matches }, descriptor.from, descriptor.to)
      )}
    </span>
  );
};
