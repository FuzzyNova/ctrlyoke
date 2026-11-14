import { useLocalInput } from "@hooks/useLocalInput";
import type React from "react";
import {
  parseNumberOrVariable,
  type WorkflowVariablePlaceholder,
} from "@utils/wholeValueVariables";

type LocalTextInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange"
> & {
  value: string;
  onCommit: (value: string) => void;
  onValueChange?: (value: string) => void;
};

export function LocalTextInput({
  value,
  onCommit,
  onValueChange,
  ...props
}: LocalTextInputProps) {
  const local = useLocalInput(value, onCommit, onValueChange);
  return <input type="text" {...props} {...local} />;
}

type LocalNumberInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "value"
> & {
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  parse?: (raw: string) => number | undefined;
  allowEmpty?: boolean;
};

export function LocalNumberInput({
  value,
  onCommit,
  parse,
  allowEmpty = false,
  ...props
}: LocalNumberInputProps) {
  const normalize = (raw: string) => {
    if (parse) return parse(raw);
    if (allowEmpty && raw.trim() === "") return undefined;
    return Number(raw);
  };
  const local = useLocalInput(
    allowEmpty ? String(value ?? "") : String(value),
    (raw) => onCommit(normalize(raw)),
    undefined,
    (raw) => String(normalize(raw) ?? (allowEmpty ? "" : undefined))
  );
  return <input type="number" {...props} {...local} />;
}

/** A number field that may also hold a typed whole-value `{{name}}`. */
export type NumberOrVariable = number | WorkflowVariablePlaceholder;

type LocalNumberOrVariableInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "value"
> & {
  value: NumberOrVariable | undefined;
  onCommit: (value: NumberOrVariable | undefined) => void;
  /** Parses numeric text; a typed `{{name}}` bypasses it and is kept as is. */
  parse: (raw: string) => number | undefined;
};

/**
 * Number input for a `kind: value` field: it accepts digits or a typed
 * `{{name}}`, so it renders as text with a numeric keyboard hint.
 */
export function LocalNumberOrVariableInput({
  value,
  onCommit,
  parse,
  ...props
}: LocalNumberOrVariableInputProps) {
  const normalize = (raw: string) => parseNumberOrVariable(raw, parse);
  const local = useLocalInput(
    String(value ?? ""),
    (raw) => onCommit(normalize(raw)),
    undefined,
    (raw) => String(normalize(raw) ?? "")
  );
  return <input type="text" inputMode="decimal" {...props} {...local} />;
}

type LocalTextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange"
> & {
  value: string;
  onCommit: (value: string) => void;
};

export function LocalTextarea({
  value,
  onCommit,
  ...props
}: LocalTextareaProps) {
  const local = useLocalInput(value, onCommit);
  return <textarea {...props} {...local} />;
}
