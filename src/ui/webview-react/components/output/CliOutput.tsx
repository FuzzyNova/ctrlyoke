import React from "react";

interface CliOutputProps {
  output: string;
  className?: string;
}

export const CliOutput: React.FC<CliOutputProps> = ({
  output,
  className = "",
}) => {
  // Parse ANSI color codes and convert to HTML
  const parseAnsiOutput = (text: string) => {
    // Basic ANSI color code removal for now
    // In a full implementation, you'd convert these to styled spans
    return text.replace(/\x1b\[[0-9;]*m/g, "");
  };

  return (
    <div
      className={`font-mono text-xs whitespace-pre-wrap bg-gray-900 text-gray-100 p-4 rounded-md overflow-x-auto ${className}`}
    >
      {parseAnsiOutput(output)}
    </div>
  );
};
