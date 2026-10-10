import { randomBytes } from "crypto";
import { projectKey } from "../utils/ProjectStatePaths";
import type { SecretStore } from "./SecretStore";

export type { SecretStore } from "./SecretStore";

const SERVER_TOKEN_SECRET_KEY_PREFIX = "ctrlyoke.server.token";

/**
 * Secret key for one workspace's server token. Keyed by the same
 * `projectKey` the hosted server uses for browser storage, so a workspace
 * keeps its link whichever host serves it, and regenerating one workspace's
 * token leaves every other workspace's links working.
 */
export function serverTokenSecretKey(workspaceRoot: string): string {
  return `${SERVER_TOKEN_SECRET_KEY_PREFIX}.${projectKey(workspaceRoot)}`;
}

/**
 * The token a server should use: a non-empty `CTRLYOKE_SERVER_TOKEN` wins, and
 * while it is set the persisted token is never read or created, so scripted
 * and test launches leave no credential behind. An empty or whitespace-only
 * value is treated as unset. `regenerate` still rotates the persisted token
 * even when the env value is what this launch uses.
 */
export async function resolveServerToken(
  store: ServerTokenStore,
  envToken: string | undefined,
  regenerate = false
): Promise<string> {
  const regenerated = regenerate ? await store.regenerate() : undefined;
  const configuredToken = envToken?.trim() ? envToken : undefined;
  return configuredToken ?? regenerated ?? (await store.getOrCreate());
}

export class ServerTokenStore {
  private readonly secretKey: string;

  constructor(
    private readonly secrets: SecretStore,
    workspaceRoot: string,
    private readonly createToken: () => string = () =>
      randomBytes(32).toString("hex")
  ) {
    this.secretKey = serverTokenSecretKey(workspaceRoot);
  }

  async getOrCreate(): Promise<string> {
    const storedToken = await this.secrets.get(this.secretKey);
    if (storedToken) {
      return storedToken;
    }

    const token = this.createToken();
    await this.secrets.store(this.secretKey, token);
    return token;
  }

  async regenerate(): Promise<string> {
    const token = this.createToken();
    await this.secrets.store(this.secretKey, token);
    return token;
  }
}
