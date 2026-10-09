import type { StepContextMenuEntry } from "@components/shared/StepContextMenu";
import { writeClipboardText } from "@utils/stepClipboard";

export const REFERENCE_CHIP_MENU_LABELS = {
  GO_TO: "Go to Reference",
  COPY: "Copy Reference",
  SEND_AS_PLAIN_TEXT: "Send as Plain Text",
} as const;

export interface ReferenceChipMenuOptions {
  /** Open the reference, exactly as a plain click on the chip does. */
  open: () => void;
  /** The reference exactly as written; Copy is disabled without it. */
  sourceText: string | null;
  /** Validation resolved the reference as nonexistent, so it can't be opened. */
  invalid?: boolean;
  /**
   * Wrap the reference in backticks so it isn't expanded. Omitted where the
   * chip isn't editable text (the output pane), which drops the item.
   */
  sendAsPlainText?: () => void;
  /** The editor is read-only, so the reference can't be rewritten. */
  readOnly?: boolean;
}

/**
 * Right-click / long-press menu for an atomic reference chip, shared by the
 * prompt editor, the workspace file editor and the output pane so the three
 * offer the same actions under the same names.
 */
export function buildReferenceChipMenuItems({
  open,
  sourceText,
  invalid = false,
  sendAsPlainText,
  readOnly = false,
}: ReferenceChipMenuOptions): StepContextMenuEntry[] {
  const items: StepContextMenuEntry[] = [
    {
      label: REFERENCE_CHIP_MENU_LABELS.GO_TO,
      icon: "codicon-go-to-file",
      disabled: invalid,
      disabledTitle: "This reference doesn't resolve to an existing file",
      onClick: open,
    },
    {
      label: REFERENCE_CHIP_MENU_LABELS.COPY,
      icon: "codicon-copy",
      disabled: sourceText === null,
      disabledTitle: "The reference text could not be found",
      onClick: () => {
        if (sourceText !== null) void writeClipboardText(sourceText);
      },
    },
  ];
  if (sendAsPlainText) {
    items.push(
      { type: "divider" },
      {
        label: REFERENCE_CHIP_MENU_LABELS.SEND_AS_PLAIN_TEXT,
        icon: "codicon-code",
        disabled: readOnly || sourceText === null,
        title:
          "Wrap in backticks so the reference is sent as written instead of expanded",
        disabledTitle: readOnly
          ? "This file is read-only"
          : "The reference text could not be found",
        onClick: sendAsPlainText,
      }
    );
  }
  return items;
}

/**
 * Wrap `text` in an inline code span, which every reference parser treats as
 * literal (see `findCodeRanges`). The delimiter is one backtick longer than
 * any run inside the text, and padded when the text itself starts or ends
 * with a backtick, so the span always closes where it should.
 */
export function wrapInInlineCode(text: string): string {
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
