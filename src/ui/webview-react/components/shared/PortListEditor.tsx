import { ChipListEditor, type ChipListParseResult } from "./ChipListEditor";

export interface PortListEditorProps {
  ports: number[];
  onAdd: (port: number) => void;
  onRemove: (port: number) => void;
  inputId?: string;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;
const PORT_REQUIREMENT_TEXT = `Enter a port number between ${MIN_PORT} and ${MAX_PORT}.`;

function parsePort(trimmed: string): ChipListParseResult<number> {
  if (!/^\d+$/.test(trimmed)) return { error: PORT_REQUIREMENT_TEXT };
  const value = Number(trimmed);
  return value >= MIN_PORT && value <= MAX_PORT
    ? { value }
    : { error: PORT_REQUIREMENT_TEXT };
}

/** Ordered chip list for the ctrlyoke server's fallback ports. */
export function PortListEditor({
  ports,
  onAdd,
  onRemove,
  inputId = "port-list-input",
}: PortListEditorProps) {
  return (
    <ChipListEditor
      items={ports}
      onAdd={onAdd}
      onRemove={onRemove}
      parse={parsePort}
      inputId={inputId}
      inputLabel="Fallback port"
      placeholder="e.g. 4749"
      emptyText="No fallback ports configured."
      emptyInputError="Port cannot be empty."
      duplicateError={(port) => `Port ${port} is already in the list.`}
      removeLabel={(port) => `Remove port ${port}`}
      testIdPrefix="port-list-entry"
      inputMode="numeric"
    />
  );
}
