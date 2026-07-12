import React from "react";
import { ExitButton } from "@components/shared";

interface WorkflowDropdownHeaderProps {
  icon: string;
  title: string;
  onClose?: () => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  showSearch?: boolean;
  showFilters?: boolean;
  filtersOpen?: boolean;
  filtersActive?: boolean;
  onToggleFilters?: () => void;
  filterControls?: React.ReactNode;
}

export const WorkflowDropdownHeader: React.FC<WorkflowDropdownHeaderProps> = ({
  icon,
  title,
  onClose,
  searchValue = "",
  onSearchChange,
  showSearch = false,
  showFilters = false,
  filtersOpen = false,
  filtersActive = false,
  onToggleFilters,
  filterControls,
}) => {
  return (
    <div className="workflow-menu-header px-3 py-2 text-xs font-semibold text-description-fg uppercase tracking-wider border-b border-dropdown-border bg-editor-bg flex-shrink-0">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <div className="flex items-center gap-1.5">
          <i className={`codicon ${icon} text-sm`} />
          <span className="whitespace-nowrap">{title}</span>
        </div>

        {showSearch && onSearchChange ? (
          <div className="flex w-full max-w-[360px] justify-self-center items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <i className="codicon codicon-search absolute left-2 top-1/2 -translate-y-1/2 text-xs text-description-fg pointer-events-none" />
              <input
                type="search"
                aria-label="Search workflows"
                placeholder="Search workflows"
                value={searchValue}
                onChange={(event) => onSearchChange(event.target.value)}
                className="w-full h-6 pl-7 pr-2 text-xs font-normal normal-case tracking-normal bg-input-bg text-input-fg border border-input-border rounded outline-none focus:border-focus-border"
              />
            </div>
            {showFilters && onToggleFilters && (
              <button
                type="button"
                onClick={onToggleFilters}
                title={
                  filtersOpen ? "Close workflow filters" : "Filter workflows"
                }
                aria-label={
                  filtersOpen ? "Close workflow filters" : "Filter workflows"
                }
                aria-expanded={filtersOpen}
                className={`control-button flex h-6 w-6 items-center justify-center rounded border transition-colors ${
                  filtersOpen || filtersActive
                    ? "border-focus-border bg-btn-bg text-btn-fg"
                    : "border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                }`}
              >
                <span
                  className="codicon codicon-filter leading-none"
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
        ) : (
          <div />
        )}

        <div className="flex justify-end">
          {onClose && (
            <ExitButton
              onClick={onClose}
              title="Close workflow menu"
              aria-label="Close workflow menu"
            />
          )}
        </div>
      </div>

      {showFilters && filtersOpen && filterControls && (
        <div className="mt-2 pt-2 border-t border-dropdown-border normal-case tracking-normal">
          {filterControls}
        </div>
      )}
    </div>
  );
};
