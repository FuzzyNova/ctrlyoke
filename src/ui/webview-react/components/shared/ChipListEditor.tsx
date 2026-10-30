import { useState, type FormEvent, type HTMLAttributes } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";

/** Result of parsing the add input: the value to add, or why it was rejected. */
export type ChipListParseResult<T> = { value: T } | { error: string };

export interface ChipListEditorProps<T extends string | number> {
  items: readonly T[];
  onAdd: (item: T) => void;
  onRemove: (item: T) => void;
  /** Validate the trimmed input; duplicates are rejected before this runs. */
  parse: (trimmed: string) => ChipListParseResult<T>;
  inputId: string;
  /** Screen-reader label for the add input. */
  inputLabel: string;
  placeholder: string;
  emptyText: string;
  emptyInputError: string;
  duplicateError: (item: T) => string;
  removeLabel: (item: T) => string;
  /** Prefix for each chip's `data-testid` (`<prefix>-<item>`). */
  testIdPrefix: string;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  /** Show a filter box once the list is longer than this. */
  filterThreshold?: number;
  filterLabel?: string;
}

/**
 * Chip list with an add box for a short list of scalar values. Validation
 * happens on submit: an invalid or duplicate entry leaves the input in place
 * with an inline error, mirroring TrustedRootsListEditor's path validation
 * rather than a live-typing warning border.
 */
export function ChipListEditor<T extends string | number>({
  items,
  onAdd,
  onRemove,
  parse,
  inputId,
  inputLabel,
  placeholder,
  emptyText,
  emptyInputError,
  duplicateError,
  removeLabel,
  testIdPrefix,
  inputMode,
  filterThreshold,
  filterLabel = "Filter",
}: ChipListEditorProps<T>) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const showFilter =
    filterThreshold !== undefined && items.length > filterThreshold;
  const normalizedFilter = showFilter ? filter.trim().toLowerCase() : "";
  const visibleItems = normalizedFilter
    ? items.filter((item) =>
        String(item).toLowerCase().includes(normalizedFilter)
      )
    : items;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) {
      setError(emptyInputError);
      return;
    }
    const result = parse(trimmed);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    if (items.includes(result.value)) {
      setError(duplicateError(result.value));
      return;
    }

    setInput("");
    setError(null);
    onAdd(result.value);
  };

  return (
    <div className="space-y-2">
      <form onSubmit={handleSubmit} className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="sr-only">
            {inputLabel}
          </label>
          <input
            id={inputId}
            type="text"
            inputMode={inputMode}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setError(null);
            }}
            placeholder={placeholder}
            className="w-full rounded-sm border border-input-border bg-input-bg px-2 py-1.5 font-mono text-sm text-input-fg focus:border-focus-border focus:outline-hidden"
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
          />
          {error && (
            <p
              id={`${inputId}-error`}
              role="alert"
              className="mt-1 text-xs text-error-fg"
            >
              {error}
            </p>
          )}
        </div>
        <Button type="submit" size="sm">
          Add
        </Button>
      </form>

      {showFilter && (
        <div>
          <label htmlFor={`${inputId}-filter`} className="sr-only">
            {filterLabel}
          </label>
          <input
            id={`${inputId}-filter`}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={filterLabel}
            className="w-full rounded-sm border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg focus:border-focus-border focus:outline-hidden"
          />
        </div>
      )}

      {items.length === 0 ? (
        <p className="rounded-sm border border-panel-border px-3 py-2 text-xs text-description-fg">
          {emptyText}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {visibleItems.map((item) => (
            <span
              key={item}
              className="flex items-center gap-1.5 rounded-sm border border-panel-border bg-input-bg px-2 py-1 font-mono text-xs text-foreground"
              data-testid={`${testIdPrefix}-${item}`}
            >
              {item}
              <button
                type="button"
                onClick={() => onRemove(item)}
                aria-label={removeLabel(item)}
                className="text-description-fg hover:text-error-fg"
              >
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
