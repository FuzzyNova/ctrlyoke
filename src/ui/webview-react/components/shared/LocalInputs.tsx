import { useLocalInput } from "@hooks/useLocalInput";
import type React from "react";

type LocalTextInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type"
> & {
  value: string;
  onCommit: (value: string) => void;
};

export function LocalTextInput({
  value,
  onCommit,
  ...props
}: LocalTextInputProps) {
  const local = useLocalInput(value, onCommit);
  return <input type="text" {...props} {...local} />;
}

type LocalNumberInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "value"
> & {
  value: number;
  onCommit: (value: number) => void;
  parse?: (raw: string) => number;
};

export function LocalNumberInput({
  value,
  onCommit,
  parse,
  ...props
}: LocalNumberInputProps) {
  const local = useLocalInput(String(value), (v) =>
    onCommit(parse ? parse(v) : Number(v))
  );
  return <input type="number" {...props} {...local} />;
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
