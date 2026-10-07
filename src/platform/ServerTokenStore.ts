import { randomBytes } from "crypto";
import type { SecretStore } from "./SecretStore";

export type { SecretStore } from "./SecretStore";

export const SERVER_TOKEN_SECRET_KEY = "ctrlyoke.server.token";

export function resolveServerToken(
  envToken: string | undefined,
  persistedToken: string
): string {
  return envToken ?? persistedToken;
}

export class ServerTokenStore {
  constructor(
    private readonly secrets: SecretStore,
    private readonly createToken: () => string = () =>
      randomBytes(32).toString("hex")
  ) {}

  async getOrCreate(): Promise<string> {
    const storedToken = await this.secrets.get(SERVER_TOKEN_SECRET_KEY);
    if (storedToken) {
      return storedToken;
    }

    const token = this.createToken();
    await this.secrets.store(SERVER_TOKEN_SECRET_KEY, token);
    return token;
  }

  async regenerate(): Promise<string> {
    const token = this.createToken();
    await this.secrets.store(SERVER_TOKEN_SECRET_KEY, token);
    return token;
  }
}
