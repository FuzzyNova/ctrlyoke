import * as assert from "assert";
import * as path from "path";
import { Command } from "commander";
import { setup, suite, teardown, test } from "mocha";
import {
  activateLicenseCommand,
  deactivateLicenseCommand,
  LICENSE_STORAGE_KINDS,
  licenseStatusCommand,
  type CliLicenseService,
  type CliLicenseStatus,
  type LicenseCommandDependencies,
} from "../../cli/LicenseCommands";
import {
  registerLicenseCommands,
  type LicenseActivateOptions,
  type LicenseCommandHandlers,
  type LicenseDeactivateOptions,
  type LicenseStatusOptions,
} from "../../cli/LicenseCommandDefinitions";
import type { SecretCommandIo } from "../../cli/SecretCommands";
import {
  LICENSE_SOURCES,
  LICENSE_TIERS,
  type Entitlement,
} from "../../license/LicenseService";
import { FileSecretStore } from "../../platform/FileSecretStore";
import { createNodeSecretStore } from "../../platform/NodeSecretStore";
import {
  MemorySecretStore,
  SecretStoreUnavailableError,
  type SecretStore,
} from "../../platform/SecretStore";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

const LICENSE_KEY = "ABCD-1234-SECRET-KEY";
const EXPIRES_AT = Date.UTC(2027, 0, 1);

const FREE: Entitlement = {
  tier: LICENSE_TIERS.FREE,
  features: new Set(),
  expiresAt: null,
};

const PRO: Entitlement = {
  tier: LICENSE_TIERS.PRO,
  features: new Set(),
  expiresAt: EXPIRES_AT,
  licenseId: "license-123",
  source: LICENSE_SOURCES.ONLINE,
};

class FakeLicenseService implements CliLicenseService {
  entitlement: Entitlement = FREE;
  storedKey: string | undefined;
  readonly activations: string[] = [];
  deactivations = 0;

  async getEntitlement(): Promise<Entitlement> {
    return this.entitlement;
  }

  async getStoredLicenseKey(): Promise<string | undefined> {
    return this.storedKey;
  }

  async activateWithKey(key: string): Promise<Entitlement> {
    this.activations.push(key);
    this.storedKey = key;
    this.entitlement = PRO;
    return PRO;
  }

  async deactivate(): Promise<void> {
    this.deactivations++;
    this.storedKey = undefined;
    this.entitlement = FREE;
  }
}

class FakeIo implements SecretCommandIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  readonly prompts: string[] = [];
  confirmAnswer = false;

  constructor(
    readonly isInteractive: boolean,
    private readonly input = ""
  ) {}

  writeOut(message: string): void {
    this.out.push(message);
  }

  writeErr(message: string): void {
    this.err.push(message);
  }

  async confirm(question: string): Promise<boolean> {
    this.prompts.push(question);
    return this.confirmAnswer;
  }

  async readHidden(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.input;
  }

  async readStdin(): Promise<string> {
    return this.input;
  }
}

class UnavailableSecretStore implements SecretStore {
  get(): Promise<string | undefined> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }
  store(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }
  delete(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }
  keys(): Promise<string[]> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }
}

suite("LicenseCommands", () => {
  let tempDir: string;
  let filePath: string;
  let licenseService: FakeLicenseService;

  setup(() => {
    tempDir = makeTempDir("ctrlyoke-license-cli-");
    filePath = path.join(tempDir, "secrets.json");
    licenseService = new FakeLicenseService();
  });

  teardown(() => {
    removeTempDir(tempDir);
  });

  /**
   * The fake license service does not touch the store, so the status read
   * probes it here, as `LicenseService` would by reading the stored key.
   */
  async function dependencies(
    primary: SecretStore
  ): Promise<LicenseCommandDependencies> {
    const secretStore = createNodeSecretStore({
      primary,
      fallback: new FileSecretStore({ filePath }),
      warn: () => undefined,
    });
    await secretStore.keys();
    return { secretStore, licenseService, dispose: () => undefined };
  }

  test("status reports Free in the OS credential store", async () => {
    const io = new FakeIo(false);

    await licenseStatusCommand(
      { json: true },
      await dependencies(new MemorySecretStore()),
      io
    );

    const status = JSON.parse(io.out[0]) as CliLicenseStatus;
    assert.deepStrictEqual(status, {
      schemaVersion: 1,
      tier: LICENSE_TIERS.FREE,
      enterprise: false,
      licenseId: null,
      source: null,
      expiresAt: null,
      unverifiedKeyStored: false,
      storage: { kind: LICENSE_STORAGE_KINDS.CREDENTIAL_STORE, path: null },
    });
  });

  test("status names the secret file on a keyringless machine and never prints the key", async () => {
    licenseService.entitlement = PRO;
    licenseService.storedKey = LICENSE_KEY;
    const io = new FakeIo(false);

    await licenseStatusCommand(
      {},
      await dependencies(new UnavailableSecretStore()),
      io
    );

    const text = io.out.join("\n");
    assert.match(text, /Tier:\s+Pro/);
    assert.match(text, /License:\s+license-123/);
    assert.match(text, /Expires:\s+2027-01-01T00:00:00.000Z/);
    assert.ok(text.includes(filePath), text);
    assert.match(text, /unencrypted/);
    assert.ok(!text.includes(LICENSE_KEY), text);
  });

  test("status flags a stored key whose license did not verify", async () => {
    licenseService.storedKey = LICENSE_KEY;
    const io = new FakeIo(false);

    await licenseStatusCommand(
      { json: true },
      await dependencies(new MemorySecretStore()),
      io
    );

    const status = JSON.parse(io.out[0]) as CliLicenseStatus;
    assert.strictEqual(status.unverifiedKeyStored, true);
  });

  test("activate reads the key from a hidden prompt", async () => {
    const io = new FakeIo(true, LICENSE_KEY);

    await activateLicenseCommand(
      {},
      await dependencies(new MemorySecretStore()),
      io
    );

    assert.deepStrictEqual(licenseService.activations, [LICENSE_KEY]);
    assert.deepStrictEqual(io.prompts, ["License key: "]);
    assert.match(io.out[0], /Activated ctrlyoke Pro.*license-123/);
    assert.ok(!io.out.join("\n").includes(LICENSE_KEY));
  });

  test("activate reads stdin with --stdin and needs it without a TTY", async () => {
    await assert.rejects(
      activateLicenseCommand(
        {},
        await dependencies(new MemorySecretStore()),
        new FakeIo(false, LICENSE_KEY)
      ),
      /use --stdin/
    );
    assert.deepStrictEqual(licenseService.activations, []);

    await activateLicenseCommand(
      { stdin: true },
      await dependencies(new MemorySecretStore()),
      new FakeIo(false, LICENSE_KEY)
    );
    assert.deepStrictEqual(licenseService.activations, [LICENSE_KEY]);
  });

  test("deactivate does nothing when no license is active", async () => {
    const io = new FakeIo(true);

    await deactivateLicenseCommand(
      { yes: true },
      await dependencies(new MemorySecretStore()),
      io
    );

    assert.strictEqual(licenseService.deactivations, 0);
    assert.match(io.out[0], /No Pro license is active/);
  });

  test("deactivate asks first and needs --yes without a TTY", async () => {
    licenseService.entitlement = PRO;
    licenseService.storedKey = LICENSE_KEY;

    const declined = new FakeIo(true);
    await deactivateLicenseCommand(
      {},
      await dependencies(new MemorySecretStore()),
      declined
    );
    assert.strictEqual(declined.prompts.length, 1);

    await deactivateLicenseCommand(
      {},
      await dependencies(new MemorySecretStore()),
      new FakeIo(false)
    );
    assert.strictEqual(licenseService.deactivations, 0);

    const io = new FakeIo(false);
    await deactivateLicenseCommand(
      { yes: true },
      await dependencies(new MemorySecretStore()),
      io
    );
    assert.strictEqual(licenseService.deactivations, 1);
    assert.match(io.out[0], /Free tier/);
  });

  test("registers status, activate and deactivate", async () => {
    const calls: unknown[] = [];
    const handlers: LicenseCommandHandlers = {
      status: async (options: LicenseStatusOptions) => {
        calls.push(["status", options]);
      },
      activate: async (options: LicenseActivateOptions) => {
        calls.push(["activate", options]);
      },
      deactivate: async (options: LicenseDeactivateOptions) => {
        calls.push(["deactivate", options]);
      },
    };
    const program = new Command().exitOverride();
    registerLicenseCommands(program, handlers);

    await program.parseAsync(["license", "status", "--json"], {
      from: "user",
    });
    await program.parseAsync(["license", "activate", "--stdin"], {
      from: "user",
    });
    await program.parseAsync(["license", "deactivate", "--yes"], {
      from: "user",
    });

    assert.deepStrictEqual(calls, [
      ["status", { json: true }],
      ["activate", { stdin: true }],
      ["deactivate", { yes: true }],
    ]);
  });
});
