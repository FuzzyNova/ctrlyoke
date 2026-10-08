import { suite, test } from "mocha";
import * as assert from "assert";
import { readFileSync, readdirSync } from "fs";
import * as path from "path";
import {
  BROWSER_NOTIFICATION_MODE_OPTIONS_META,
  CODEX_APPROVAL_POLICY_OPTIONS_META,
  CODEX_SANDBOX_MODE_OPTIONS_META,
  CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
  CTRLYOKE_MCP_MODE_OPTIONS_META,
  DEFAULT_FORMAT_OPTIONS_META,
  EXECUTION_MODE_OPTIONS_META,
  NOTIFICATION_EVENT_MODE_OPTIONS_META,
  PERMISSION_MODE_OPTIONS_META,
  PRIOR_CONTEXT_KEYWORD_OPTIONS_META,
  RUN_HISTORY_LOCATION_OPTIONS_META,
  STEP_COLOR_MODE_OPTIONS_META,
  TERMINAL_CURSOR_STYLE_OPTIONS_META,
  TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META,
  TOAST_LEVEL_OPTIONS_META,
} from "../../types/SchemaUiMetadata";

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
 * Every settings section consistently threads a `settingKey="dot.notation.path"`
 * into `SettingInputRow` / `SettingToggleRow`; the catalog entry supplies the
 * schema path used for `sources[path]` and the per-row reset button. This suite
 * excludes the catalog itself and searches the section source for those keys.
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
const WORKFLOW_SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../schemas/workflow-schema.json"
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
const workflowSchema = JSON.parse(
  readFileSync(WORKFLOW_SCHEMA_PATH, "utf8")
) as SchemaNode;

interface ResolvedSchemaNode {
  node: SchemaNode;
  document: SchemaNode;
}

function resolveRef(
  node: SchemaNode,
  document: SchemaNode
): ResolvedSchemaNode {
  const ref = node.$ref as string | undefined;
  if (!ref) return { node, document };

  const hashIndex = ref.indexOf("#");
  const schemaFile = (hashIndex === -1 ? ref : ref.slice(0, hashIndex))
    .split("/")
    .pop();
  const pointer = hashIndex === -1 ? "" : ref.slice(hashIndex);
  const targetDocument = ref.startsWith("#")
    ? document
    : schemaFile === "workflow.json" || schemaFile === "workflow-schema.json"
      ? workflowSchema
      : undefined;
  assert.ok(targetDocument, `Unsupported $ref: ${ref}`);
  const target = pointer
    .slice(2)
    .split("/")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      assert.ok(
        current !== null && typeof current === "object" && key in current,
        `$ref target not found: ${ref}`
      );
      return (current as Record<string, unknown>)[key];
    }, targetDocument);
  assert.ok(target, `$ref target not found: ${ref}`);
  return {
    node: { ...(target as SchemaNode), ...node, $ref: undefined },
    document: targetDocument,
  };
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
  "ui.harnessColors.byHarness",
  "statusLine.byHarness",
  "notifications.events.hookEvents",
]);

/** leaf dot-path -> literal substring to search for in webview source. */
function walk(
  node: SchemaNode,
  prefix: string,
  out: Map<string, string>,
  templateParent: string | undefined,
  document: SchemaNode
): void {
  const { node: resolved, document: resolvedDocument } = resolveRef(
    node,
    document
  );
  const dynamicParent =
    templateParent ??
    (DYNAMIC_TEMPLATE_PARENTS.has(prefix) ? prefix : undefined);

  if (!isPlainObjectSchema(resolved)) {
    // Settings exposes tool permission values as a nullable shared workflow
    // definition, while the dashboard still edits the object branch's fields.
    if (
      prefix === "defaults.toolPermissions" &&
      Array.isArray(resolved.oneOf)
    ) {
      const objectBranch = (resolved.oneOf as SchemaNode[])
        .map((branch) => resolveRef(branch, resolvedDocument))
        .find(({ node: branch }) => isPlainObjectSchema(branch));
      if (objectBranch) {
        walk(
          objectBranch.node,
          prefix,
          out,
          dynamicParent,
          objectBranch.document
        );
        return;
      }
    }
    if (prefix) {
      out.set(prefix, dynamicParent ? `${dynamicParent}.\${` : prefix);
    }
    return;
  }

  const properties = resolved.properties as Record<string, SchemaNode>;
  for (const [key, childSchema] of Object.entries(properties)) {
    if (!prefix && key === "$schema") continue;
    walk(
      childSchema,
      prefix ? `${prefix}.${key}` : key,
      out,
      dynamicParent,
      resolvedDocument
    );
  }
}

function allSettingPaths(): Map<string, string> {
  const out = new Map<string, string>();
  walk(schema, "", out, undefined, schema);
  return out;
}

/**
 * `SETTING_PATHS` in DashboardConstants.ts is the shared registry a few
 * controls use instead of writing their dot path inline (e.g.
 * `path={SETTING_PATHS.STATUS_LINE_CLAUDE_ENABLED}`).
 * Defining a value there is not itself proof of a live control — the registry
 * also backs config plumbing — so this only maps path -> constant name; the
 * caller still has to confirm the constant is referenced from webview source.
 */
function settingPathConstants(): Map<string, string> {
  const source = readFileSync(DASHBOARD_CONSTANTS_PATH, "utf8");
  const blockMatch =
    /export const SETTING_PATHS = \{([\s\S]*?)\n\} as const;/.exec(source);
  assert.ok(
    blockMatch,
    "SETTING_PATHS block not found in DashboardConstants.ts"
  );
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
 * control check below because the UI work described in the plan hasn't
 * landed yet. See dev/implemented/SETTINGS_UI_PARITY_PLAN.md for the
 * disposition of each entry.
 *
 * As each gap gets a dashboard control, remove its path from this list and
 * re-run the suite — a listed path that's no longer missing a control fails
 * the "list is still accurate" check, so a forgotten removal is caught here
 * rather than silently masking future gaps in the same setting.
 */
const PENDING_UI_PARITY: readonly string[] = [
  "languageServers.definitions",
  "languageServers.idleShutdownMinutes",
  "languageServers.maxRunning",
  "languageServers.settings",
  "languageServers.startOnLaunch",
  "server.theme",
  "terminal.mobileBarLayout.bar",
  "terminal.mobileBarLayout.hidden",
  "terminal.mobileBarLayout.popup",
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
    .filter((filePath) => path.basename(filePath) !== "settingsCatalog.ts")
    .map((filePath) => readFileSync(filePath, "utf8"))
    .join("\n");
}

const SETTINGS_ENUM_METADATA = [
  [
    "general.defaultFormat",
    DEFAULT_FORMAT_OPTIONS_META,
    "DEFAULT_FORMAT_OPTIONS_META",
  ],
  [
    "ui.stepColorMode",
    STEP_COLOR_MODE_OPTIONS_META,
    "STEP_COLOR_MODE_OPTIONS_META",
  ],
  [
    "execution.ctrlyokeMcpMode",
    CTRLYOKE_MCP_MODE_OPTIONS_META,
    "CTRLYOKE_MCP_MODE_OPTIONS_META",
  ],
  [
    "notifications.browser.mode",
    BROWSER_NOTIFICATION_MODE_OPTIONS_META,
    "BROWSER_NOTIFICATION_MODE_OPTIONS_META",
  ],
  [
    "notifications.events.workflowComplete",
    NOTIFICATION_EVENT_MODE_OPTIONS_META,
    "NOTIFICATION_EVENT_MODE_OPTIONS_META",
  ],
  [
    "notifications.events.promptComplete",
    NOTIFICATION_EVENT_MODE_OPTIONS_META,
    "NOTIFICATION_EVENT_MODE_OPTIONS_META",
  ],
  [
    "notifications.toastLevel",
    TOAST_LEVEL_OPTIONS_META,
    "TOAST_LEVEL_OPTIONS_META",
  ],
  [
    "defaults.toolPermissions.mode",
    PERMISSION_MODE_OPTIONS_META,
    "PERMISSION_MODE_OPTIONS_META",
  ],
  [
    "defaults.executionMode",
    EXECUTION_MODE_OPTIONS_META,
    "EXECUTION_MODE_OPTIONS_META",
  ],
  [
    "permissions.codexSandboxMode",
    CODEX_SANDBOX_MODE_OPTIONS_META,
    "CODEX_SANDBOX_MODE_OPTIONS_META",
  ],
  [
    "permissions.codexApprovalPolicy",
    CODEX_APPROVAL_POLICY_OPTIONS_META,
    "CODEX_APPROVAL_POLICY_OPTIONS_META",
  ],
  [
    "terminal.cursorStyle",
    TERMINAL_CURSOR_STYLE_OPTIONS_META,
    "TERMINAL_CURSOR_STYLE_OPTIONS_META",
  ],
  [
    "terminal.mobileControlBar",
    TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META,
    "TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META",
  ],
  [
    "execution.contextResolutionFailure",
    CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
    "CONTEXT_RESOLUTION_FAILURE_OPTIONS_META",
  ],
  [
    "storage.runHistoryLocation",
    RUN_HISTORY_LOCATION_OPTIONS_META,
    "RUN_HISTORY_LOCATION_OPTIONS_META",
  ],
] as const;

function schemaNodeAtPath(dotPath: string): ResolvedSchemaNode {
  let current: ResolvedSchemaNode = { node: schema, document: schema };
  for (const segment of dotPath.split(".")) {
    const resolved = resolveRef(current.node, current.document);
    const properties = resolved.node.properties as
      Record<string, SchemaNode> | undefined;
    let child = properties?.[segment];
    if (!child) {
      for (const combinator of ["oneOf", "anyOf", "allOf"]) {
        const branches = resolved.node[combinator];
        if (!Array.isArray(branches)) continue;
        for (const branch of branches as SchemaNode[]) {
          const branchResolved = resolveRef(branch, resolved.document);
          const branchProperties = branchResolved.node.properties as
            Record<string, SchemaNode> | undefined;
          child ??= branchProperties?.[segment];
        }
      }
    }
    assert.ok(child, `Schema path not found: ${dotPath}`);
    current = resolveRef(child!, resolved.document);
  }
  return current;
}

function schemaEnumValues(node: SchemaNode, document: SchemaNode): string[] {
  const resolved = resolveRef(node, document);
  const values = Array.isArray(resolved.node.enum)
    ? (resolved.node.enum as string[])
    : [];
  return values.concat(
    ["oneOf", "anyOf", "allOf"].flatMap((key) => {
      const branches = resolved.node[key];
      return Array.isArray(branches)
        ? (branches as SchemaNode[]).flatMap((branch) =>
            schemaEnumValues(branch, resolved.document)
          )
        : [];
    })
  );
}

const CUSTOM_SELECT_ALLOWLIST: Readonly<Record<string, string>> = {
  "settings/SecretsSection.tsx#0":
    "Selects the scope for a secret editor, not a schema enum.",
  "settings/ServerSection.tsx#0":
    "Selects the display address from detected network interfaces.",
  "shared/CreateScriptModal.tsx#0":
    "Selects the script creation mode in a UI-only modal.",
  "shared/DryRunModal.tsx#0":
    "Selects a section of the dry-run preview, not a workflow property.",
  "shared/ModelPricingEditor.tsx#0":
    "Selects a harness key in a dynamic pricing map.",
  "shared/ModelPricingEditor.tsx#1":
    "Selects a model ID in a dynamic pricing map.",
};

function assertCustomSelectCoverage(): void {
  const componentRoot = path.join(WEBVIEW_SOURCE_ROOT, "components");
  const sourceDirs = ["settings", "layout", "editor", "shared"];
  const usedAllowlist = new Set<string>();
  for (const directory of sourceDirs) {
    const root = path.join(componentRoot, directory);
    for (const filePath of webviewSourceFiles(root)) {
      const relativePath = path
        .relative(componentRoot, filePath)
        .replaceAll("\\", "/");
      const source = readFileSync(filePath, "utf8");
      const tags = /<CustomSelect\b([\s\S]*?)\/>/g;
      let unannotatedIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = tags.exec(source)) !== null) {
        if (/\bschemaPath\s*=/.test(match[1])) continue;
        const allowlistKey = `${relativePath}#${unannotatedIndex++}`;
        assert.ok(
          allowlistKey && CUSTOM_SELECT_ALLOWLIST[allowlistKey],
          `${relativePath}: CustomSelect without schemaPath must have a reasoned allowlist entry (${allowlistKey})`
        );
        usedAllowlist.add(allowlistKey);
      }
    }
  }
  assert.deepStrictEqual(
    Object.keys(CUSTOM_SELECT_ALLOWLIST).filter(
      (key) => !usedAllowlist.has(key)
    ),
    [],
    "Remove stale CustomSelect allowlist entries"
  );
}

suite("Settings schema -> Global Settings dashboard control parity", () => {
  test("renamed settings keys have live controls at their new schema paths", () => {
    const expectedPaths = [
      "ui.showCostEstimates",
      "execution.contextResolutionFailure",
      "queue.maxSteps",
      "permissions.trustedExternalRoots",
      "server.autoStart",
      "commit.systemPrompt",
    ];
    const paths = allSettingPaths();
    const pathConstants = settingPathConstants();
    const source = webviewSource();

    for (const settingPath of expectedPaths) {
      assert.ok(
        paths.has(settingPath),
        `${settingPath} is missing from the schema`
      );
      const constantName = pathConstants.get(settingPath);
      assert.ok(
        source.includes(settingPath) ||
          (constantName !== undefined &&
            source.includes(`SETTING_PATHS.${constantName}`)),
        `${settingPath} has no matching settings UI control`
      );
    }
    assert.strictEqual(paths.has(["queue", "unlimitedMode"].join(".")), false);
  });

  test("schema walk finds a non-trivial number of authorable settings", () => {
    const paths = allSettingPaths();
    assert.ok(
      paths.size > 50,
      `Expected substantially more than 50 leaf settings; found ${paths.size}. ` +
        "The schema walk may be broken (e.g. stopping recursion too early)."
    );
  });

  test("settings enum metadata matches schema values and displayed labels", () => {
    const source = webviewSource().replace(/\s+/g, " ");
    for (const [
      settingPath,
      metadata,
      metadataName,
    ] of SETTINGS_ENUM_METADATA) {
      const resolved = schemaNodeAtPath(settingPath);
      const schemaValues = schemaEnumValues(resolved.node, resolved.document);
      assert.ok(schemaValues.length > 0, `${settingPath} must remain an enum`);
      const entries = Object.values(metadata);
      assert.deepStrictEqual(
        entries.map(({ value }) => value).sort(),
        [...schemaValues].sort(),
        `${settingPath}: metadata enum values must match the settings schema`
      );
      assert.ok(entries.every(({ label }) => label.trim().length > 0));
      assert.ok(
        source.includes(metadataName),
        `${settingPath}: settings UI must use ${metadataName} for displayed labels`
      );
      assert.ok(
        new RegExp(
          `toSelectOptions\\s*\\(\\s*${metadataName},\\s*["']${settingPath}["']\\s*\\)`
        ).test(source),
        `${settingPath}: CustomSelect must render labels from ${metadataName}`
      );
      assert.ok(
        source.includes(`schemaPath="${settingPath}"`),
        `${settingPath}: settings UI must pass its settings-relative path to CustomSelect`
      );
    }
  });

  // defaults.priorContext is not a plain enum (it also takes [1, 3] and
  // { previous: N }), so it renders through PriorContextSelect instead of a
  // CustomSelect; its keyword options must still match the schema enum.
  test("defaults.priorContext keywords match the schema and use the shared select", () => {
    const resolved = schemaNodeAtPath("defaults.priorContext");
    assert.deepStrictEqual(
      Object.values(PRIOR_CONTEXT_KEYWORD_OPTIONS_META)
        .map(({ value }) => value)
        .sort(),
      schemaEnumValues(resolved.node, resolved.document).sort()
    );
    const page = readFileSync(
      path.join(
        WEBVIEW_SOURCE_ROOT,
        "components",
        "settings",
        "defaults",
        "DefaultsContextPage.tsx"
      ),
      "utf8"
    ).replace(/\s+/g, " ");
    assert.ok(page.includes("<PriorContextSelect"));
    assert.ok(page.includes('schemaPath="defaults.priorContext"'));
  });

  test("CustomSelect controls have a schema path or a reasoned UI-only exception", () => {
    assertCustomSelectCoverage();
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
