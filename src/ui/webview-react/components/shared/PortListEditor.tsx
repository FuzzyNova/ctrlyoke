import { useState, type FormEvent } from "react";
import { Button } from "./Button";

export interface PortListEditorProps {
  ports: number[];
  onAdd: (port: number) => void;
  onRemove: (port: number) => void;
  inputId?: string;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;
const PORT_REQUIREMENT_TEXT = `Enter a port number between ${MIN_PORT} and ${MAX_PORT}.`;

function parsePort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MIN_PORT && value <= MAX_PORT ? value : null;
}

/**
 * Ordered chip list for a short set of port numbers (ctrlyoke server
 * fallback ports). Validation happens on submit — an invalid or duplicate
 * entry leaves the input in place with an inline error, mirroring
 * TrustedRootsListEditor's path validation rather than a live-typing
 * warning border.
 */
export function PortListEditor({
  ports,
  onAdd,
  onRemove,
  inputId = "port-list-input",
}: PortListEditorProps) {
  const [portInput, setPortInput] = useState("");
  const [portError, setPortError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const port = parsePort(portInput);
    if (port === null) {
      setPortError(
        portInput.trim() ? PORT_REQUIREMENT_TEXT : "Port cannot be empty."
      );
      return;
    }
    if (ports.includes(port)) {
      setPortError(`Port ${port} is already in the list.`);
      return;
    }

    setPortInput("");
    setPortError(null);
    onAdd(port);
  };

  return (
    <div className="space-y-2">
      <form onSubmit={handleSubmit} className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="sr-only">
            Fallback port
          </label>
          <input
            id={inputId}
            type="text"
            inputMode="numeric"
            value={portInput}
            onChange={(event) => {
              setPortInput(event.target.value);
              setPortError(null);
            }}
            placeholder="e.g. 4749"
            className="w-full rounded border border-input-border bg-input-bg px-2 py-1.5 font-mono text-sm text-input-fg focus:border-focus-border focus:outline-none"
            aria-invalid={portError ? "true" : undefined}
            aria-describedby={portError ? `${inputId}-error` : undefined}
          />
          {portError && (
            <p
              id={`${inputId}-error`}
              role="alert"
              className="mt-1 text-xs text-error-fg"
            >
              {portError}
            </p>
          )}
        </div>
        <Button type="submit" size="sm">
          Add
        </Button>
      </form>

      {ports.length === 0 ? (
        <p className="rounded border border-panel-border px-3 py-2 text-xs text-description-fg">
          No fallback ports configured.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ports.map((port) => (
            <span
              key={port}
              className="flex items-center gap-1.5 rounded border border-panel-border bg-input-bg px-2 py-1 font-mono text-xs text-foreground"
              data-testid={`port-list-entry-${port}`}
            >
              {port}
              <button
                type="button"
                onClick={() => onRemove(port)}
                aria-label={`Remove port ${port}`}
                className="text-description-fg hover:text-error-fg"
              >
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
