import { useCompatibilityDiagnostics } from "../../hooks/useCompatibilityDiagnostics";
import { permissionCapabilitySummary } from "../../utils/compatibilityDiagnostics";
import { FieldDiagnostic } from "./FieldDiagnostic";

interface Props {
  id: string;
  field: "allowedTools" | "deniedTools";
}

/** Shared cross-harness summary for settings that have no concrete consumer. */
export function PermissionCapabilitySummary({ id, field }: Props) {
  const { capabilitySnapshot, isChecking } = useCompatibilityDiagnostics();

  if (isChecking || !capabilitySnapshot) return null;

  return (
    <FieldDiagnostic
      id={id}
      diagnostics={permissionCapabilitySummary(capabilitySnapshot, field)}
      className="mt-1"
    />
  );
}
