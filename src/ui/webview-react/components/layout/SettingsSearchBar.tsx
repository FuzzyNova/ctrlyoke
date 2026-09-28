import { useEffect, useRef } from "react";
import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import { ExitButton } from "@components/shared";
import { Icon } from "@components/shared/Icon";

interface SettingsSearchBarProps {
  query: string;
  matchCount: number;
  activeMatch: number;
  isNarrow: boolean;
  onQueryChange: (query: string) => void;
  onNavigate: (direction: 1 | -1) => void;
  onClose: () => void;
}

export function SettingsSearchBar({
  query,
  matchCount,
  activeMatch,
  isNarrow,
  onQueryChange,
  onNavigate,
  onClose,
}: SettingsSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const counter = query.trim()
    ? matchCount > 0
      ? isNarrow
        ? `${activeMatch}/${matchCount}`
        : `${activeMatch} of ${matchCount}`
      : "0"
    : "";

  return (
    <div
      role="search"
      className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-panel-border bg-panel-bg px-2"
    >
      <Icon name="search" className="shrink-0 text-description-fg" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === KEYBOARD_KEYS.ESCAPE) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        className="h-7 min-w-0 flex-1 basis-32 rounded border border-input-border bg-input-bg px-2 text-sm text-input-fg outline-none focus:border-focus-border"
      />
      <span className="w-16 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-description-fg">
        {counter}
      </span>
      <button
        type="button"
        className="icon-btn shrink-0 px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={() => onNavigate(-1)}
        title="Previous match"
        aria-label="Previous match"
      >
        <Icon name="arrow-up" />
      </button>
      <button
        type="button"
        className="icon-btn shrink-0 px-1.5 py-1 text-description-fg hover:text-foreground"
        onClick={() => onNavigate(1)}
        title="Next match"
        aria-label="Next match"
      >
        <Icon name="arrow-down" />
      </button>
      <ExitButton
        className="shrink-0"
        onClick={onClose}
        title="Close search"
        aria-label="Close search"
      />
    </div>
  );
}
