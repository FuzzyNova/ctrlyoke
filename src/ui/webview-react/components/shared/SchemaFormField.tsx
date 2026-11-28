import React from "react";
import { schemaAriaLabel, schemaFieldTitle } from "@utils/schemaPropertyLabels";

export interface SchemaFormFieldProps {
  label: string;
  schemaPath: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
  setAsDefaultButton?: React.ReactNode;
  className?: string;
  preferDescription?: boolean;
}

/**
 * A labelled form field whose tooltip and accessible name come from the
 * schema property it edits. Shared by the workflow properties panel and the
 * editors it lends to other surfaces (the worktree editor).
 */
export const SchemaFormField: React.FC<SchemaFormFieldProps> = ({
  label,
  schemaPath,
  description,
  htmlFor,
  children,
  setAsDefaultButton,
  className,
  preferDescription = false,
}) => (
  <div className={`flex flex-col gap-1${className ? ` ${className}` : ""}`}>
    <div className="flex items-center justify-between min-h-[18px]">
      <label
        htmlFor={htmlFor}
        title={schemaFieldTitle(
          label,
          schemaPath,
          description,
          preferDescription
        )}
        aria-label={schemaAriaLabel(label, schemaPath)}
        className="text-xs font-semibold uppercase text-description-fg cursor-help"
      >
        {label}
        <span className="sr-only">
          {schemaAriaLabel(label, schemaPath).slice(label.length)}
        </span>
      </label>
      {setAsDefaultButton}
    </div>
    {children}
  </div>
);
