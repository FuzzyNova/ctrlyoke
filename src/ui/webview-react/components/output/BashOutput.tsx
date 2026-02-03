import React from "react";
import { Collapsible } from "../shared";

interface BashOutputProps {
  command: string;
  output: string;
  exitCode?: number;
  className?: string;
}

export const BashOutput: React.FC<BashOutputProps> = ({
  command,
  output,
  exitCode,
  className = "",
}) => {
  const hasError = exitCode !== undefined && exitCode !== 0;

  return (
    <div className={className}>
      <Collapsible title={`$ ${command}`} defaultExpanded={hasError}>
        <div className="space-y-2">
          <div className="font-mono text-xs whitespace-pre-wrap bg-gray-900 text-gray-100 p-3 rounded-md overflow-x-auto max-h-64">
            {output || "(no output)"}
          </div>
          {exitCode !== undefined && (
            <div
              className={`text-xs font-medium ${
                exitCode === 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              Exit code: {exitCode}
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  );
};
