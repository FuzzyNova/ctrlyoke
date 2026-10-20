import { useEffect, useState } from "react";
import { useUiStore } from "@store/uiStore";
import type { PickerShortcutTarget } from "@root/types/DashboardConstants";
import {
  useListboxKeyboardNavigation,
  type ListboxNavigationOption,
} from "./useListboxKeyboardNavigation";
import { usePickerShortcutRequest } from "./usePickerShortcutRequest";

interface PickerListboxConfig {
  /** The Alt/Alt+Shift shortcut that targets this picker, if any. */
  shortcutTarget?: PickerShortcutTarget;
  /** Inline lists (footer quick pickers) are open whenever mounted. */
  inline: boolean;
  isOpen: boolean;
  /** Open a trigger-mode dropdown. */
  onOpen: () => void;
  disabled: boolean;
  options: readonly ListboxNavigationOption[];
  selectedValue: string;
  onCommit: (value: string) => void;
  onDismiss: () => void;
}

/**
 * The option-list half of a shortcut-addressable dropdown (CustomSelect,
 * HarnessDropdown): keyboard navigation plus claiming picker shortcut
 * requests. The press that reaches a closed picker opens it and focuses the
 * list on the current value; a press while the list has focus advances the
 * highlight, so repeating the shortcut cycles through the options.
 */
export function usePickerListbox({
  shortcutTarget,
  inline,
  isOpen,
  onOpen,
  disabled,
  options,
  selectedValue,
  onCommit,
  onDismiss,
}: PickerListboxConfig) {
  const navigation = useListboxKeyboardNavigation({
    options,
    selectedValue,
    onCommit,
    onDismiss,
  });
  const { focusList, reset, listRef } = navigation;
  // Nonce of a request this picker opened for but has not focused yet. A
  // trigger-mode popup renders a frame or so after opening (its position is
  // measured first), so focusing waits until the list element exists — and
  // the request stays pending until then, so if this instance is remounted
  // first (a panel expanding around it) the new instance still claims it.
  const [focusWhenShown, setFocusWhenShown] = useState<number | null>(null);
  const clearRequest = (nonce: number) =>
    useUiStore.getState().clearPickerShortcutRequest(nonce);

  usePickerShortcutRequest(
    shortcutTarget ? [shortcutTarget] : undefined,
    (request) => {
      if (disabled) {
        clearRequest(request.nonce);
      } else if (!inline && !isOpen) {
        onOpen();
        setFocusWhenShown(request.nonce);
      } else {
        clearRequest(request.nonce);
        if (navigation.isListFocused()) navigation.advance();
        else focusList();
      }
    }
  );

  useEffect(() => {
    if (focusWhenShown === null || !listRef.current) return;
    setFocusWhenShown(null);
    clearRequest(focusWhenShown);
    focusList();
  });

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);

  return navigation;
}
