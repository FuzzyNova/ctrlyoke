import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { PromptFileParser } from "../../core/PromptFileParser";
import { FileConfigBackend } from "../../config/FileConfigBackend";
import {
  BASELINE_SCHEMA_VERSIONS,
  MIGRATIONS,
  migrateToCurrent,
} from "../../utils/FormatMigrations";
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";

/**
 * Settings removed or renamed since the frozen fixtures were captured. They load
 * unchanged but now draw an `additionalProperties` warning in the editor.
 */
const RETIRED_SETTINGS: ReadonlyArray<readonly [section: string, key: string]> =
  [
    ["general", "includeFullDiffsInPriorContext"],
    ["execution", "injectMode"],
  ];

suite("FormatMigrations", () => {
  test("every store has a contiguous chain from its baseline to current", () => {
    for (const store of Object.values(PERSISTED_STORES)) {
      assert.strictEqual(
        CURRENT_SCHEMA_VERSIONS[store] - BASELINE_SCHEMA_VERSIONS[store],
        MIGRATIONS[store].length,
        store
      );
    }
  });

  test("each published schema's $id version matches its store's current format", async () => {
    const schemaStores = {
      "workflow-schema.json": PERSISTED_STORES.WORKFLOW_DEFINITION,
      "settings-schema.json": PERSISTED_STORES.SETTINGS,
    } as const;
    for (const [fileName, store] of Object.entries(schemaStores)) {
      const schema = JSON.parse(
        await fs.readFile(
          path.resolve(__dirname, "../../../schemas", fileName),
          "utf8"
        )
      );
      assert.match(
        schema.$id,
        new RegExp(`/schema/v${CURRENT_SCHEMA_VERSIONS[store]}/`),
        `${fileName} $id must match CURRENT_SCHEMA_VERSIONS; bump both with npm run schema:bump`
      );
    }
  });

  test("loads every current format fixture and preserves it through a write/read cycle", async () => {
    const fixtureRoot = path.resolve(
      __dirname,
      "../../../src/test/fixtures/formats"
    );
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-format-load-")
    );
    const workflowSchema = JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, "../../../schemas/workflow-schema.json"),
        "utf8"
      )
    );
    const settingsSchema = JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, "../../../schemas/settings-schema.json"),
        "utf8"
      )
    );
    const settingsAjv = new Ajv({ allErrors: true });
    addFormats(settingsAjv);
    settingsAjv.addSchema(workflowSchema, workflowSchema.$id);
    const validateSettings = settingsAjv.compile(settingsSchema);
    try {
      for (const store of Object.values(PERSISTED_STORES)) {
        const version = CURRENT_SCHEMA_VERSIONS[store];
        const storeFixtureRoot = path.join(fixtureRoot, store, `v${version}`);
        const fixtureNames = await fs.readdir(storeFixtureRoot);
        assert.ok(fixtureNames.length > 0, `missing fixture for ${store}`);

        for (const fixtureName of fixtureNames) {
          const fixturePath = path.join(storeFixtureRoot, fixtureName);
          const original = JSON.parse(await fs.readFile(fixturePath, "utf8"));
          const migrated = migrateToCurrent(store, original).doc;
          assert.deepStrictEqual(migrated, original, `${store}/${fixtureName}`);

          if (
            store === PERSISTED_STORES.WORKFLOW_DEFINITION ||
            store === PERSISTED_STORES.RUN_FILE
          ) {
            await new PromptFileParser().validateAndNormalize(
              migrated,
              fixturePath
            );
          } else if (store === PERSISTED_STORES.SETTINGS) {
            const loadedSettings = new FileConfigBackend(fixturePath).getAll();
            const presentRetiredSettings = RETIRED_SETTINGS.filter(
              ([section, key]) => {
                const values = (
                  loadedSettings as Record<string, object | undefined>
                )[section];
                return Boolean(values && key in values);
              }
            );
            assert.strictEqual(
              validateSettings(loadedSettings),
              presentRetiredSettings.length === 0,
              JSON.stringify(validateSettings.errors)
            );
            for (const [, key] of presentRetiredSettings) {
              assert.ok(
                validateSettings.errors?.some(
                  (error) =>
                    error.keyword === "additionalProperties" &&
                    error.params.additionalProperty === key
                ),
                `retired setting ${key} should produce an editor schema warning`
              );
            }
            assert.deepStrictEqual(loadedSettings, migrated);
          }

          const roundTripPath = path.join(tempRoot, `${store}.json`);
          await fs.writeFile(roundTripPath, JSON.stringify(migrated));
          const loaded = JSON.parse(await fs.readFile(roundTripPath, "utf8"));
          assert.deepStrictEqual(loaded, original, `${store}/${fixtureName}`);
        }
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
