import { versionSatisfies } from "../../../utils/HarnessVersion";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { OPENCODE_V2_MIN_VERSION } from "./OpenCodeProtocolConstants";

/** `opencode --version`: `1.19.5` on OpenCode 1, `opencode v2.2.5` on OpenCode 2. */
export const OPENCODE_VERSION_COMMAND = "opencode --version";

/** Returns the raw `opencode --version` output, or undefined when unknown. */
export type OpenCodeVersionProbe = () => Promise<string | undefined>;

const installedVersionProbe: OpenCodeVersionProbe = () =>
  CliProviderUtils.getCliVersion(OPENCODE_VERSION_COMMAND, { timeoutMs: 5000 });

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

/** Whether a raw `opencode --version` string is an OpenCode 2 release. */
export function isOpenCodeV2Version(rawVersion: string | undefined): boolean {
  return (
    rawVersion !== undefined &&
    versionSatisfies(rawVersion, `>=${OPENCODE_V2_MIN_VERSION}`)
  );
}

/**
 * Whether the installed CLI is OpenCode 2.
 *
 * OpenCode 2 changed the launch surface (`--standalone`, no TUI `-m`,
 * `session export`, directory plugins), which output shape cannot reveal before
 * the process starts, so these are the version branches the harness rules
 * allow. The `--version` probe is cached per extension-host session by
 * `CliProviderUtils`. An unknown version is treated as OpenCode 1, which keeps
 * the long-standing behaviour.
 */
export async function detectOpenCodeV2(): Promise<boolean> {
  return isOpenCodeV2Version(await versionProbe());
}
