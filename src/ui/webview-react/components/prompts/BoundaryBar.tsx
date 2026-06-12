import React from "react";

export const BoundaryBar: React.FC = () => {
  return (
    <div className="px-1 py-1 select-none" aria-hidden="true">
      <div className="h-[2px] bg-indicator-success" />
    </div>
  );
};
