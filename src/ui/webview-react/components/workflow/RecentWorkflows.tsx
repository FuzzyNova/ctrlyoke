import React from "react";

interface RecentWorkflow {
  name: string;
  path: string;
  lastModified: number;
}

interface RecentWorkflowsProps {
  workflows: RecentWorkflow[];
  onSelect: (path: string) => void;
  onClear: () => void;
  className?: string;
}

export const RecentWorkflows: React.FC<RecentWorkflowsProps> = ({
  workflows,
  onSelect,
  onClear,
  className = "",
}) => {
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      return "Today";
    } else if (days === 1) {
      return "Yesterday";
    } else if (days < 7) {
      return `${days} days ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  if (workflows.length === 0) {
    return (
      <div
        className={`text-sm text-gray-500 dark:text-gray-400 italic p-4 ${className}`}
      >
        No recent workflows
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="space-y-1">
        {workflows.map((workflow) => (
          <button
            key={workflow.path}
            onClick={() => onSelect(workflow.path)}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                  {workflow.name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {workflow.path}
                </div>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                {formatDate(workflow.lastModified)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {workflows.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClear}
            className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900 dark:hover:bg-opacity-20 transition-colors"
          >
            Clear History
          </button>
        </div>
      )}
    </div>
  );
};
