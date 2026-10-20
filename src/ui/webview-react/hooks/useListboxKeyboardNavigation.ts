import { useCallback, useEffect, useRef, useState } from "react";
import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";

/** One option the keyboard can land on: visible and enabled, in display order. */
export interface ListboxNavigationOption {
  value: string;
  label: string;
}

interface ListboxKeyboardNavigationConfig {
  options: readonly ListboxNavigationOption[];
  selectedValue: string;
  /** Enter on the highlighted option. */
  onCommit: (value: string) => void;
  /** Escape or Tab: close without changing the value. */
  onDismiss: () => void;
}

/** Typed characters within this window extend one typeahead query. */
const TYPEAHEAD_RESET_MS = 1000;

/** Marks each option row so the highlighted one can be scrolled into view. */
export const LISTBOX_OPTION_VALUE_ATTRIBUTE = "data-listbox-value";

/**
 * Keyboard navigation for a dropdown option list that has been handed focus
 * (`focusList`). Arrow keys, Home and End move a highlight, typing jumps to
 * the first option whose label starts with (else contains) what was typed,
 * Enter commits the highlight, and Escape/Tab dismiss. Committing or
 * dismissing first returns focus to whatever had it before `focusList`, so a
 * picker opened by shortcut from the prompt editor hands the caret straight
 * back. Mouse-opened lists never call `focusList` and behave as before.
 */
export function useListboxKeyboardNavigation({
  options,
  selectedValue,
  onCommit,
  onDismiss,
}: ListboxKeyboardNavigationConfig) {
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const typeaheadRef = useRef({ query: "", at: 0 });
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const selectedValueRef = useRef(selectedValue);
  selectedValueRef.current = selectedValue;

  const isListFocused = useCallback(
    () => listRef.current?.contains(document.activeElement) ?? false,
    []
  );

  const focusList = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (!list.contains(document.activeElement)) {
      const previous = document.activeElement;
      returnFocusRef.current =
        previous instanceof HTMLElement && previous !== document.body
          ? previous
          : null;
    }
    const navigable = optionsRef.current;
    setActiveValue(
      navigable.some((option) => option.value === selectedValueRef.current)
        ? selectedValueRef.current
        : (navigable[0]?.value ?? null)
    );
    typeaheadRef.current = { query: "", at: 0 };
    list.focus({ preventScroll: true });
  }, []);

  const move = useCallback((delta: number) => {
    const navigable = optionsRef.current;
    if (navigable.length === 0) return;
    setActiveValue((current) => {
      const index = navigable.findIndex((option) => option.value === current);
      if (index === -1) return navigable[0].value;
      const next = (index + delta + navigable.length) % navigable.length;
      return navigable[next].value;
    });
  }, []);

  /** Move the highlight to the next option, wrapping (a repeat shortcut press). */
  const advance = useCallback(() => move(1), [move]);

  /** Clear the highlight, e.g. when the list closes some other way. */
  const reset = useCallback(() => setActiveValue(null), []);

  const restoreFocus = useCallback(() => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    setActiveValue(null);
    if (target?.isConnected) target.focus();
  }, []);

  const typeahead = (character: string) => {
    const now = Date.now();
    const previous = typeaheadRef.current;
    const query = (
      now - previous.at > TYPEAHEAD_RESET_MS
        ? character
        : previous.query + character
    ).toLowerCase();
    typeaheadRef.current = { query, at: now };
    const navigable = optionsRef.current;
    const match =
      navigable.find((option) =>
        option.label.toLowerCase().startsWith(query)
      ) ??
      navigable.find((option) => option.label.toLowerCase().includes(query));
    if (match) setActiveValue(match.value);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const navigable = optionsRef.current;
    let handled = true;
    switch (event.key) {
      case KEYBOARD_KEYS.ARROW_DOWN:
        move(1);
        break;
      case KEYBOARD_KEYS.ARROW_UP:
        move(-1);
        break;
      case KEYBOARD_KEYS.HOME:
        setActiveValue(navigable[0]?.value ?? null);
        break;
      case KEYBOARD_KEYS.END:
        setActiveValue(navigable[navigable.length - 1]?.value ?? null);
        break;
      case KEYBOARD_KEYS.ENTER:
        if (activeValue !== null) {
          restoreFocus();
          onCommit(activeValue);
        }
        break;
      case KEYBOARD_KEYS.ESCAPE:
      case KEYBOARD_KEYS.TAB:
        restoreFocus();
        onDismiss();
        break;
      case KEYBOARD_KEYS.BACKSPACE:
        typeaheadRef.current = {
          query: typeaheadRef.current.query.slice(0, -1),
          at: Date.now(),
        };
        break;
      default:
        handled =
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey;
        if (handled) typeahead(event.key);
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  useEffect(() => {
    if (activeValue === null) return;
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(
        `[${LISTBOX_OPTION_VALUE_ATTRIBUTE}]`
      ) ?? []
    ).find(
      (element) =>
        element.getAttribute(LISTBOX_OPTION_VALUE_ATTRIBUTE) === activeValue
    );
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeValue]);

  return {
    listRef,
    activeValue,
    focusList,
    isListFocused,
    advance,
    reset,
    onKeyDown,
  };
}
