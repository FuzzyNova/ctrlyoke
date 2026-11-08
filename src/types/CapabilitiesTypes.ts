/** The model option shape persisted in `.ctrlyoke/capabilities.json`. */
export interface CapabilitiesModel {
  value: string;
  label: string;
  /**
   * The harness keeps this model out of its own default picker (Codex's
   * `model/list` `hidden` flag; Claude's pinned versions, which its picker
   * puts behind "More models"). It can still be selected; dashboard pickers
   * start it in their hidden section until the user unhides it.
   */
  hidden?: boolean;
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
