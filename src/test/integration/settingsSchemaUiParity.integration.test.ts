import { suite, test } from "mocha";
import * as assert from "assert";
import { readFileSync, readdirSync } from "fs";
import * as path from "path";

/**
 * Schema -> Global Settings dashboard control parity.
 *
 * `schemas/settings-schema.json` is the source of truth for what a person can
 * put in `.ctrlyoke/settings.json`, but most users configure ctrlyoke through
 * `GlobalSettingsDrawer.tsx` and its section components instead of hand-editing
 * JSON. This suite enumerates every leaf property the schema allows and checks
 * that the webview source actually wires a control to it, so a schema property
 * with no dashboard surface is caught here instead of only being discoverable
 * by reading `settings.json` documentation.
 *
 * Sibling to `schemaUiPropertyRoundTrip.integration.test.ts`, which does the
 * same thing for the workflow schema against the prompt/step editors. This
 * suite is pure static analysis (schema walk + source-text search) — it does
 * not exercise persistence, so it needs no temp workspace or orchestrator.
 *
 * Every settings section consistently threads a `path="dot.notation.path"`
 * prop (matching the schema's own dot path) into `SettingInputRow` /
 * `SettingToggleRow` for `sources[path]` lookup and the per-row reset button —
 * see `SettingInputRow.tsx`. That convention is what this suite searches for.
 * A handful of controls reference `SETTING_PATHS.SOME_KEY` (a shared constant
 * in `DashboardConstants.ts`) instead of writing the literal path inline
 * (e.g. `StatusLineTrackingControls.tsx`); those are matched indirectly via
 * the `SETTING_PATHS` registry. A few properties are rendered in a loop over a
 * fixed key set (per-harness model/arg maps, hook event toggles) using a
 * template-literal path (`` `defaults.models.${harnessId}` ``); those are
 * matched by the template's literal prefix instead of the fully-substituted
 * path, since the substituted value never appears verbatim in source.
 *
 * Known gaps are tracked in `PENDING_UI_PARITY` below rather than left
 * failing outright — see dev/implemented/SETTINGS_UI_PARITY_PLAN.md for the
 * disposition of each entry. As a gap gets a dashboard control, remove its
 * path from `PENDING_UI_PARITY` and re-run this suite: the second check
 * below fails if a listed path is no longer missing, so the list can't go
 * stale silently.
 */

const SETTINGS_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../schemas/settings-schema.json"
);
const DASHBOARD_CONSTANTS_PATH = path.resolve(
  __dirname,
  "../../../src/types/DashboardConstants.ts"
);
const WEBVIEW_SOURCE_ROOT = path.resolve(
  __dirname,
  "../../../src/ui/webview-react"
);

type SchemaNode = Record<string, unknown>;

const schema = JSON.parse(
  readFileSync(SETTINGS_SCHEMA_PATH, "utf8")
) as SchemaNode;

function resolveRef(node: SchemaNode): SchemaNode {
  const ref = node.$ref as string | undefined;
  if (!ref) return node;
  const match = /^#\/definitions\/(.+)$/.exec(ref);
  assert.ok(match, `Unsupported $ref: ${ref}`);
  const definitions = schema.definitions as Record<string, SchemaNode>;
  const target = definitions[match![1]];
  assert.ok(target, `$ref target not found: ${ref}`);
  return target;
}

function isPlainObjectSchema(node: SchemaNode): boolean {
  // Deliberately excludes `oneOf` nodes (the enable/disable object-or-null
  // pattern used by errorBehavior/endCondition/preCondition): those are
  // edited as one opaque object via a single dashboard control, not
  // per-subfield, so they must leaf out at their own path instead of
  // recursing into either oneOf branch.
  return node.type === "object" && !!node.properties && !node.oneOf;
}

/**
 * Schema subtrees whose properties are rendered by looping over a fixed key
 * set (HARNESS_IDS, HOOK_EVENT_ORDER) and building the dashboard `path` with a
 * template literal. Every leaf under one of these keeps its own real path in
 * the inventory (each is independently a live schema property), but is
 * matched against source by the template's literal prefix rather than the
 * fully-substituted path.
 */
const DYNAMIC_TEMPLATE_PARENTS = new Set([
  "defaults.models",
  "defaults.additionalArgs",
  "notifications.events.hookEvents",
]);

/** leaf dot-path -> literal substring to search for in webview source. */
function walk(
  node: SchemaNode,
  prefix: string,
  out: Map<string, string>,
  templateParent: string | undefined
): void {
  const resolved = resolveRef(node);
  const dynamicParent =
    templateParent ??
    (DYNAMIC_TEMPLATE_PARENTS.has(prefix) ? prefix : undefined);

  if (!isPlainObjectSchema(resolved)) {
    if (prefix) {
      out.set(prefix, dynamicParent ? `${dynamicParent}.\${` : prefix);
    }
    return;
  }

  const properties = resolved.properties as Record<string, SchemaNode>;
  for (const [key, childSchema] of Object.entries(properties)) {
    walk(
      childSchema,
      prefix ? `${prefix}.${key}` : key,
      out,
      dynamicParent
    );
  }
}

function allSettingPaths(): Map<string, string> {
  const out = new Map<string, string>();
  walk(schema, "", out, undefined);
  return out;
}

/**
 * `SETTING_PATHS` in DashboardConstants.ts is the shared registry a few
 * controls use instead of writing their dot path inline (e.g.
 * `path={SETTING_PATHS.PERMISSIONS_STATUS_LINE_TRACKING_CLAUDE_ENABLED}`).
 * Defining a value there is not itself proof of a live control — the registry
 * also backs config plumbing — so this only maps path -> constant name; the
 * caller still has to confirm the constant is referenced from webview source.
 */
function settingPathConstants(): Map<string, string> {
  const source = readFileSync(DASHBOARD_CONSTANTS_PATH, "utf8");
  const blockMatch = /export const SETTING_PATHS = \{([\s\S]*?)\n\} as const;/.exec(
    source
  );
  assert.ok(blockMatch, "SETTING_PATHS block not found in DashboardConstants.ts");
  const entries = new Map<string, string>();
  const entryPattern = /(\w+):\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(blockMatch![1])) !== null) {
    entries.set(match[2], match[1]);
  }
  return entries;
}

/**
 * Settings-schema properties intentionally excluded from the live-dashboard-
 * control check below, either because the UI work described in the plan
 * hasn't landed yet, or (for `server.standalonePort`) because the feature it
 * configures doesn't exist yet. See dev/implemented/SETTINGS_UI_PARITY_PLAN.md
 * for the disposition of each entry.
 *
 * As each gap gets a dashboard control, remove its path from this list and
 * re-run the suite — a listed path that's no longer missing a control fails
 * the "list is still accurate" check, so a forgotten removal is caught here
 * rather than silently masking future gaps in the same setting.
 */
const PENDING_UI_PARITY: readonly string[] = [
  // Copilot/Qwen statusline controls are intentionally deferred to Phase 7 of
  // STATUS_LINE_COPILOT_QWEN_PLAN.md.
  "permissions.statusLineTracking.copilot.customCommand",
  "permissions.statusLineTracking.copilot.enabled",
  "permissions.statusLineTracking.copilot.format",
  "permissions.statusLineTracking.copilot.useCtrlyokeStyle",
  "permissions.statusLineTracking.qwen.customCommand",
  "permissions.statusLineTracking.qwen.enabled",
  "permissions.statusLineTracking.qwen.format",
  "permissions.statusLineTracking.qwen.useCtrlyokeStyle",
  "server.standalonePort",
  "server.theme",
];

const WEBVIEW_TEST_DIRECTORIES = new Set(["test", "__tests__"]);

function webviewSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return WEBVIEW_TEST_DIRECTORIES.has(entry.name)
        ? []
        : webviewSourceFiles(entryPath);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function webviewSource(): string {
  return webviewSourceFiles(WEBVIEW_SOURCE_ROOT)
    .map((filePath) => readFileSync(filePath, "utf8"))
    .join("\n");
}

suite("Settings schema -> Global Settings dashboard control parity", () => {
  test("schema walk finds a non-trivial number of authorable settings", () => {
    const paths = allSettingPaths();
    assert.ok(
      paths.size > 50,
      `Expected substantially more than 50 leaf settings; found ${paths.size}. ` +
        "The schema walk may be broken (e.g. stopping recursion too early)."
    );
  });

  test("every leaf settings-schema property has a live dashboard control", () => {
    const paths = allSettingPaths();
    const pathConstants = settingPathConstants();
    const source = webviewSource();

    const missing: string[] = [];
    for (const [settingPath, searchTerm] of paths) {
      const direct = source.includes(searchTerm);
      const constantName = pathConstants.get(settingPath);
      const indirect =
        !direct &&
        constantName !== undefined &&
        source.includes(`SETTING_PATHS.${constantName}`);
      if (!direct && !indirect) {
        missing.push(settingPath);
      }
    }
    missing.sort();

    const pending = new Set(PENDING_UI_PARITY);
    const unexpectedlyMissing = missing.filter((p) => !pending.has(p));
    const resolvedButStillPending = PENDING_UI_PARITY.filter(
      (p) => !missing.includes(p)
    );

    assert.deepStrictEqual(
      unexpectedlyMissing,
      [],
      `Settings-schema properties with no live dashboard control and no entry ` +
        `in PENDING_UI_PARITY (${unexpectedlyMissing.length}):\n` +
        unexpectedlyMissing.map((p) => `  - ${p}`).join("\n") +
        "\nSee dev/implemented/SETTINGS_UI_PARITY_PLAN.md."
    );

    assert.deepStrictEqual(
      resolvedButStillPending,
      [],
      `PENDING_UI_PARITY lists paths that now have a live dashboard control ` +
        `(${resolvedButStillPending.length}):\n` +
        resolvedButStillPending.map((p) => `  - ${p}`).join("\n") +
        "\nRemove them from PENDING_UI_PARITY in this test."
    );
  });
});
