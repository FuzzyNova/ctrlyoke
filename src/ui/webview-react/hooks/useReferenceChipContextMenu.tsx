import { useCallback, useState, type ReactNode } from "react";
import {
  StepContextMenu,
  type StepContextMenuEntry,
  type StepContextMenuState,
} from "@components/shared/StepContextMenu";

export type ReferenceChipMenuOpener = (
  x: number,
  y: number,
  items: StepContextMenuEntry[]
) => void;

interface UseReferenceChipContextMenuResult {
  /** Stable, so CodeMirror extensions built once can hold on to it. */
  openReferenceChipMenu: ReferenceChipMenuOpener;
  referenceChipMenuPortal: ReactNode;
}

/** Menu state plus portal for an atomic reference chip's context menu. */
export function useReferenceChipContextMenu(): UseReferenceChipContextMenuResult {
  const [menu, setMenu] = useState<StepContextMenuState | null>(null);
  const openReferenceChipMenu = useCallback<ReferenceChipMenuOpener>(
    (x, y, items) => setMenu({ x, y, items }),
    []
  );
  const close = useCallback(() => setMenu(null), []);

  return {
    openReferenceChipMenu,
    referenceChipMenuPortal: menu ? (
      <StepContextMenu {...menu} onClose={close} />
    ) : null,
  };
}
