import React from "react";

export const BoundaryBar: React.FC = () => {
  return (
    <div className="px-3 py-2 select-none" aria-hidden="true">
      <div className="h-[3px] rounded-full bg-status-running opacity-80" />
    </div>
  );
};
