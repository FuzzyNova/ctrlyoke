import { useCallback, useEffect, useRef, useState } from "react";
import { writeClipboardText } from "@utils/stepClipboard";
import { Icon } from "./Icon";

/** How long the check mark replaces the copy icon after a successful copy. */
export const COPY_FEEDBACK_MS = 1200;

interface CopyButtonProps {
  /** The exact text written to the clipboard. */
  text: string;
  /** Tooltip and accessible name, e.g. "Copy session ID". */
  label: string;
  className?: string;
  iconClassName?: string;
}

/**
 * Icon-only copy button that briefly swaps to a check mark once the text is
 * on the clipboard. Stops click propagation so it can sit inside clickable
 * rows (step cards, list items) without triggering them.
 */
export function CopyButton({
  text,
  label,
  className = "icon-btn py-0 px-0.5",
  iconClassName = "text-xxs",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      try {
        await writeClipboardText(text);
      } catch {
        return;
      }
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(
        () => setCopied(false),
        COPY_FEEDBACK_MS
      );
    },
    [text]
  );

  return (
    <button
      type="button"
      className={className}
      onClick={(event) => void handleClick(event)}
      title={label}
      aria-label={label}
    >
      <Icon
        name={copied ? "codicon-check" : "codicon-copy"}
        className={iconClassName}
      />
    </button>
  );
}
