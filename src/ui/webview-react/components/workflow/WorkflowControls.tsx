import React from "react";
import { SplitButton } from "../shared";

interface WorkflowControlsProps {
  onNew: () => void;
  onLoad: () => void;
  onQueue: () => void;
  disabled?: boolean;
}

export const WorkflowControls: React.FC<WorkflowControlsProps> = ({
  onNew,
  onLoad,
  onQueue,
  disabled = false,
}) => {
  const options = [
    { label: "Load Workflow", value: "load", onClick: onLoad },
    { label: "View Queue", value: "queue", onClick: onQueue },
  ];

  return (
    <div className="flex items-center gap-2">
      <SplitButton
        mainLabel="New Workflow"
        mainAction={onNew}
        options={options}
        variant="primary"
        disabled={disabled}
      />
    </div>
  );
};
