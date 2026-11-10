import { HarnessAdapterUtils } from "../shared/HarnessAdapterUtils";
import {
  isOpenCodeV2Version,
  OPENCODE_VERSION_COMMAND,
} from "./OpenCodeProtocolConstants";

export { isOpenCodeV2Version, OPENCODE_VERSION_COMMAND };

/** Returns the raw `opencode --version` output, or undefined when unknown. */
export type OpenCodeVersionProbe = () => Promise<string | undefined>;

const installedVersionProbe: OpenCodeVersionProbe = () =>
  HarnessAdapterUtils.getCliVersion(OPENCODE_VERSION_COMMAND, {
    timeoutMs: 5000,
  });

let versionProbe: OpenCodeVersionProbe = installedVersionProbe;

/**
 * Replace the version probe and return a function that restores the previous
 * one. The extension-host test runner pins it so results do not depend on
 * which OpenCode the developer has installed; tests that cover OpenCode 2
 * select it explicitly.
 */
export function setOpenCodeVersionProbe(
  probe: OpenCodeVersionProbe
): () => void {
  const previous = versionProbe;
  versionProbe = probe;
  return () => {
    versionProbe = previous;
  };
}

/**
 * Whether the installed CLI is OpenCode 2.
 *
 * OpenCode 2 changed the launch surface (`--standalone`, no TUI `-m`,
 * `session export`, directory plugins), which output shape cannot reveal before
 * the process starts, so these are the version branches the harness rules
 * allow. The `--version` probe is cached per extension-host session by
 * `HarnessAdapterUtils`. An unknown version is treated as OpenCode 1, which keeps
 * the long-standing behaviour.
 */
export async function detectOpenCodeV2(): Promise<boolean> {
  return isOpenCodeV2Version(await versionProbe());
}
