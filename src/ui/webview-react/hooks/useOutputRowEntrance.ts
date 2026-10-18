import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  OUTPUT_ROW_ENTER_DURATION_MS,
  OUTPUT_ROW_ENTER_EASING,
  findEnteringRowKeys,
  prefersReducedMotion,
} from "@utils/outputMotion";

interface UseOutputRowEntranceInput {
  autoscrollEnabledRef: RefObject<boolean>;
  /** Live output is streaming into a visible pane. */
  isEnabled: boolean;
  outputRef: RefObject<HTMLDivElement | null>;
  /** Changes on a workflow, run or filter switch, whose rows are never "new". */
  rowRenderIdentity: string;
  rows: readonly { key: string }[];
}

/**
 * Fades in rows that arrive while the pane follows live output.
 *
 * Opacity only: a slide would move the row's client rect, which the anchor
 * lock and viewport-anchor capture both read. Runs as a layout effect so the
 * row's first paint is already at the start of the fade. Rows that remount
 * later (scrolling back up, run switches, scroll-seek placeholders swapping
 * back) are never new by this definition, so they never replay it.
 */
export function useOutputRowEntrance({
  autoscrollEnabledRef,
  isEnabled,
  outputRef,
  rowRenderIdentity,
  rows,
}: UseOutputRowEntranceInput): void {
  const previousRowsRef = useRef(rows);
  const previousIdentityRef = useRef(rowRenderIdentity);

  useLayoutEffect(() => {
    const previousRows = previousRowsRef.current;
    const identityChanged = previousIdentityRef.current !== rowRenderIdentity;
    previousRowsRef.current = rows;
    previousIdentityRef.current = rowRenderIdentity;

    const scrollElement = outputRef.current;
    if (
      identityChanged ||
      !isEnabled ||
      !autoscrollEnabledRef.current ||
      !scrollElement ||
      prefersReducedMotion()
    ) {
      return;
    }

    const enteringKeys = new Set(findEnteringRowKeys(previousRows, rows));
    if (enteringKeys.size === 0) {
      return;
    }
    scrollElement
      .querySelectorAll<HTMLElement>("[data-row-key]")
      .forEach((element) => {
        const rowKey = element.dataset.rowKey;
        if (
          rowKey === undefined ||
          !enteringKeys.has(rowKey) ||
          typeof element.animate !== "function"
        ) {
          return;
        }
        element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: OUTPUT_ROW_ENTER_DURATION_MS,
          easing: OUTPUT_ROW_ENTER_EASING,
        });
      });
  }, [autoscrollEnabledRef, isEnabled, outputRef, rowRenderIdentity, rows]);
}
