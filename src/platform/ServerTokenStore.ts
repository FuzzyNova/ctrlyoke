import { randomBytes } from "crypto";

export const SERVER_TOKEN_SECRET_KEY = "flightpath.server.token";

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
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
