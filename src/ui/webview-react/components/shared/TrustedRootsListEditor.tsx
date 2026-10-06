import { useState, type FormEvent } from "react";
import { TRUST_DECISIONS } from "@root/types/DashboardConstants";
import { Button } from "./Button";

export interface TrustedRootsListEditorProps {
  entries: { path: string; decision?: "allow" | "deny" }[];
  showDecisionStatus: boolean;
  onAdd: (path: string) => void;
  onBrowse: () => void;
  onRemove: (path: string) => void;
  onDecisionChange?: (path: string, decision: "allow" | "deny") => void;
}

const PATH_REQUIREMENT_TEXT =
  "Enter a path containing a directory separator, such as /var/log or C:\\tools.";

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("~")
  );
}

function decisionLabel(decision: "allow" | "deny" | undefined): string {
  if (decision === TRUST_DECISIONS.ALLOW) return "Approved";
  if (decision === TRUST_DECISIONS.DENY) return "Denied";
  return "Pending";
}

function decisionClass(decision: "allow" | "deny" | undefined): string {
  if (decision === TRUST_DECISIONS.ALLOW) return "text-indicator-success";
  if (decision === TRUST_DECISIONS.DENY) return "text-error-fg";
  return "text-warning-fg";
}

export function TrustedRootsListEditor({
  entries,
  showDecisionStatus,
  onAdd,
  onBrowse,
  onRemove,
  onDecisionChange,
}: TrustedRootsListEditorProps) {
  const [pathInput, setPathInput] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedPath = pathInput.trim();
    if (!trimmedPath || !looksLikePath(trimmedPath)) {
      setPathError(
        trimmedPath ? PATH_REQUIREMENT_TEXT : "Path cannot be empty."
      );
      return;
    }

    setPathInput("");
    setPathError(null);
    onAdd(trimmedPath);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onBrowse}>
          Add folder…
        </Button>
        <form onSubmit={handleSubmit} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="trusted-root-manual-path" className="sr-only">
              External directory path
            </label>
            <input
              id="trusted-root-manual-path"
              type="text"
              value={pathInput}
              onChange={(event) => {
                setPathInput(event.target.value);
                setPathError(null);
              }}
              placeholder="Enter a directory path"
              className="w-full rounded-sm border border-input-border bg-input-bg px-2 py-1.5 font-mono text-sm text-input-fg focus:border-focus-border focus:outline-hidden"
              aria-invalid={pathError ? "true" : undefined}
              aria-describedby={
                pathError ? "trusted-root-path-error" : undefined
              }
            />
            {pathError && (
              <p
                id="trusted-root-path-error"
                role="alert"
                className="mt-1 text-xs text-error-fg"
              >
                {pathError}
              </p>
            )}
          </div>
          <Button type="submit" size="sm">
            Add
          </Button>
        </form>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-sm border border-panel-border px-3 py-3 text-sm text-description-fg">
          No external directories configured.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.path}
              className="flex items-start gap-3 rounded-sm border border-panel-border px-3 py-2"
              data-testid={`trusted-root-row-${entry.path}`}
            >
              <code className="min-w-0 flex-1 break-all text-sm text-foreground">
                {entry.path}
              </code>
              {showDecisionStatus && (
                <div className="flex shrink-0 items-start gap-2">
                  <span
                    className={`rounded-sm px-1.5 py-px text-xs font-semibold ${decisionClass(entry.decision)}`}
                    data-testid={`trusted-root-status-${entry.path}`}
                  >
                    {decisionLabel(entry.decision)}
                  </span>
                  {onDecisionChange && (
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          onDecisionChange(entry.path, TRUST_DECISIONS.ALLOW)
                        }
                        disabled={entry.decision === TRUST_DECISIONS.ALLOW}
                        aria-label={`Allow ${entry.path}`}
                      >
                        Allow
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          onDecisionChange(entry.path, TRUST_DECISIONS.DENY)
                        }
                        disabled={entry.decision === TRUST_DECISIONS.DENY}
                        aria-label={`Deny ${entry.path}`}
                      >
                        Deny
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => onRemove(entry.path)}
                aria-label={`Delete ${entry.path}`}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
