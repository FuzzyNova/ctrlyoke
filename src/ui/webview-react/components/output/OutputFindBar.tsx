import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { OutputFindState } from "@hooks/useOutputFind";

interface OutputFindBarProps {
  state: OutputFindState;
  onQueryChange: (query: string) => void;
  onNavigate: (direction: 1 | -1) => void;
  onToggleCaseSensitive: () => void;
  onClose: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}

export function OutputFindBar({
  state,
  onQueryChange,
  onNavigate,
  onToggleCaseSensitive,
  onClose,
  onKeyDown,
}: OutputFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [state.isOpen]);

  const counterLabel =
    state.matchCount > 0
      ? `${state.currentMatch} of ${state.matchCount}`
      : "No results";

  return (
    <div
      className="absolute right-6 top-2 z-20 flex items-center gap-2 rounded border border-widget-border bg-editor-bg/95 px-2 py-1 shadow-md backdrop-blur-[1px]"
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        value={state.query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Find in output"
        aria-label="Find in output"
        className="h-7 w-52 rounded border border-input-border bg-input-bg px-2 text-sm text-input-fg outline-none focus:border-focus-border"
      />
      <span className="min-w-16 text-right text-xs text-description-fg">
        {counterLabel}
      </span>
      <button
        type="button"
        className="icon-btn px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={() => onNavigate(-1)}
        title="Previous match"
        aria-label="Previous match"
      >
        <i className="codicon codicon-arrow-up" />
      </button>
      <button
        type="button"
        className="icon-btn px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={() => onNavigate(1)}
        title="Next match"
        aria-label="Next match"
      >
        <i className="codicon codicon-arrow-down" />
      </button>
      <button
        type="button"
        className={`icon-btn px-1.5 py-1 ${
          state.caseSensitive
            ? "text-foreground"
            : "text-description-fg hover:text-foreground"
        }`}
        onClick={onToggleCaseSensitive}
        title="Match case"
        aria-label="Match case"
        aria-pressed={state.caseSensitive}
      >
        <i className="codicon codicon-case-sensitive" />
      </button>
      <button
        type="button"
        className="icon-btn px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={onClose}
        title="Close find"
        aria-label="Close find"
      >
        <i className="codicon codicon-close" />
      </button>
    </div>
  );
}
