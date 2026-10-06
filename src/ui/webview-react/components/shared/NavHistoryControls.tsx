import React from "react";
import { useNavHistory } from "@/navigation/useNavHistory";
import { useIsMobile } from "@hooks/useMediaQuery";
import { HEADER_BUTTON_SIZES } from "@/constants";
import { Icon } from "./Icon";

interface NavHistoryControlsProps {
  /** Extra classes for outer spacing/layout in the host header. */
  className?: string;
}

const buttonClass = (enabled: boolean, iconButtonSize: string): string =>
  `control-button flex h-full self-stretch items-center justify-center ${iconButtonSize} border-0 transition-colors ${
    enabled
      ? "bg-transparent text-btn-secondary-fg hover:bg-btn-secondary-hover"
      : "bg-transparent text-btn-secondary-fg opacity-40 cursor-not-allowed"
  }`;

/**
 * Back / forward navigation controls (VS Code style). Walks the shared
 * navigation history stack; disabled at the ends. Rendered both in the main
 * dashboard header and in the workspace-viewer header — both drive the same
 * history. Sized to match the other header icon buttons on mobile and desktop.
 */
export const NavHistoryControls: React.FC<NavHistoryControlsProps> = ({
  className = "",
}) => {
  const { canBack, canForward, back, forward } = useNavHistory();
  const isMobile = useIsMobile();
  const btnSize = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;

  // `flex`, not `inline-flex`: callers pass `hidden md:flex`, and Tailwind 4
  // emits `.inline-flex` after `.hidden`, so it would override the hide.
  return (
    <div
      className={`flex shrink-0 ${btnSize.groupContainer} ${className}`}
      role="group"
      aria-label="Navigation history"
    >
      <button
        type="button"
        onClick={back}
        disabled={!canBack}
        title="Back"
        aria-label="Go back"
        className={buttonClass(canBack, btnSize.iconButton)}
      >
        <Icon name="arrow-left" className={`${btnSize.icon}`} />
      </button>
      <button
        type="button"
        onClick={forward}
        disabled={!canForward}
        title="Forward"
        aria-label="Go forward"
        className={buttonClass(canForward, btnSize.iconButton)}
      >
        <Icon name="arrow-right" className={`${btnSize.icon}`} />
      </button>
    </div>
  );
};
