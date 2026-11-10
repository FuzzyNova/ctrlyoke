import { useCallback, useState, type ReactNode } from "react";
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuState,
} from "@components/shared/ContextMenu";

export type ReferenceChipMenuOpener = (
  x: number,
  y: number,
  items: ContextMenuEntry[],
  /** True for a long press, which must leave focus (and the keyboard) in the editor. */
  keepInvokerFocus?: boolean
) => void;

interface UseReferenceChipContextMenuResult {
  /** Stable, so CodeMirror extensions built once can hold on to it. */
  openReferenceChipMenu: ReferenceChipMenuOpener;
  referenceChipMenuPortal: ReactNode;
}

/** Menu state plus portal for an atomic reference chip's context menu. */
export function useReferenceChipContextMenu(): UseReferenceChipContextMenuResult {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const openReferenceChipMenu = useCallback<ReferenceChipMenuOpener>(
    (x, y, items, keepInvokerFocus) =>
      setMenu({ x, y, items, keepInvokerFocus }),
    []
  );
  const close = useCallback(() => setMenu(null), []);

  return {
    openReferenceChipMenu,
    referenceChipMenuPortal: menu ? (
      <ContextMenu {...menu} onClose={close} />
    ) : null,
  };
}
