import { useEffect, useRef, useState } from "react";
import type React from "react";

export function useLocalInput(
  externalValue: string,
  onCommit: (value: string) => void,
  onValueChange?: (value: string) => void
) {
  const [value, setValue] = useState(externalValue);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setValue(externalValue);
    }
  }, [externalValue]);

  return {
    value,
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => {
      setValue(e.target.value);
      onValueChange?.(e.target.value);
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      focused.current = false;
      onCommit(e.target.value);
    },
  };
}
