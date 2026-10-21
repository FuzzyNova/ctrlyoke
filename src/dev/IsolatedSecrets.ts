import { FileSecretStore } from "../platform/FileSecretStore";
import type { SecretStore } from "../platform/SecretStore";

/**
 * Set by the `media` dev host (scripts/dev-host.mjs). The OS credential store
 * belongs to the OS user, not to the fake user home the media host runs in, so
 * without this a capture would show the capturer's own license and secrets,
 * and a scripted Activate or Deactivate would change the real ones.
 */
export const ISOLATED_SECRETS_ENV = "CTRLYOKE_DEV_ISOLATED_SECRETS";

/**
 * The store that replaces the OS credential store when the environment asks
 * for isolation: a `FileSecretStore` under the host's own (fake) home, which
 * the media host resets before each capture.
 */
export function isolatedSecretStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): SecretStore | undefined {
  return environment[ISOLATED_SECRETS_ENV] === "1"
    ? new FileSecretStore()
    : undefined;
}
