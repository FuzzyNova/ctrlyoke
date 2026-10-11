import { useEffect, useRef, useState } from "react";
import type React from "react";

/**
 * Buffers an externally-owned value while the user edits it and commits it
 * on blur. External updates are ignored while editing so a delayed
 * host round-trip of an earlier keystroke cannot overwrite newer local text.
 */
export function useLocalValue<T>(
  externalValue: T,
  onCommit: (value: T) => void,
  getNormalizedValue?: (value: T) => T
) {
  const [value, setValue] = useState(externalValue);
  const editing = useRef(false);
  const externalValueRef = useRef(externalValue);

  useEffect(() => {
    externalValueRef.current = externalValue;
    if (!editing.current) {
      setValue(externalValue);
    }
  }, [externalValue]);

  return {
    value,
    onChange: (next: T) => {
      editing.current = true;
      setValue(next);
    },
    onFocus: () => {
      editing.current = true;
    },
    onBlur: () => {
      editing.current = false;
      onCommit(value);
      const normalizedValue = getNormalizedValue?.(value);
      setValue(
        normalizedValue !== undefined &&
          Object.is(normalizedValue, externalValueRef.current)
          ? externalValueRef.current
          : value
      );
    },
  };
}

export function useLocalInput(
  externalValue: string,
  onCommit: (value: string) => void,
  onValueChange?: (value: string) => void,
  getNormalizedValue?: (value: string) => string
) {
  const local = useLocalValue(externalValue, onCommit, getNormalizedValue);

  return {
    value: local.value,
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => {
      local.onChange(e.target.value);
      onValueChange?.(e.target.value);
    },
    onFocus: local.onFocus,
    onBlur: local.onBlur,
  };
}
