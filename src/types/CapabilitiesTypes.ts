/** The model option shape persisted in `.ctrlyoke/capabilities.json`. */
export interface CapabilitiesModel {
  value: string;
  label: string;
}

/** The harness availability and model data persisted in capabilities.json. */
export interface CapabilitiesHarness {
  id: string;
  displayName: string;
  available: boolean;
  models: CapabilitiesModel[];
}

/** Cross-process contract written by the extension and read by the MCP server. */
export interface CapabilitiesFile {
  generatedAt: number;
  harnesses: CapabilitiesHarness[];
}
