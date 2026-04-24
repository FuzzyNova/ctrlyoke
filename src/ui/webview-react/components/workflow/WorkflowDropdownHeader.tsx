import React from "react";

interface WorkflowDropdownHeaderProps {
  icon: string;
  title: string;
  onClose?: () => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  showSearch?: boolean;
}

export const WorkflowDropdownHeader: React.FC<WorkflowDropdownHeaderProps> = ({
  icon,
  title,
  onClose,
  searchValue = "",
  onSearchChange,
  showSearch = false,
}) => {
  return (
    <div className="workflow-menu-header px-3 py-2 text-xs font-semibold text-description-fg uppercase tracking-wider border-b border-dropdown-border bg-editor-bg flex-shrink-0 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
      <div className="flex items-center gap-1.5">
        <i className={`codicon ${icon} text-sm`} />
        <span className="whitespace-nowrap">{title}</span>
      </div>

      {showSearch && onSearchChange ? (
        <div className="relative w-full max-w-[320px] justify-self-center">
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
      ) : (
        <div />
      )}

      <div className="flex justify-end">
        {onClose && (
          <button
            type="button"
            className="control-button flex items-center justify-center w-5 h-5 rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
            onClick={onClose}
            title="Close workflow menu"
            aria-label="Close workflow menu"
          >
            <span className="codicon codicon-close" />
          </button>
        )}
      </div>
    </div>
  );
};
