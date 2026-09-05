import { suite, test, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import { readFileSync, readdirSync } from "fs";
import * as os from "os";
import * as path from "path";
import Ajv from "ajv";
import {
  createPromotedRun,
  createRoundTripHarness,
  type RoundTripHarness,
  type RunDefinition,
} from "./helpers/propertyRoundTrip";

/**
 * Schema -> dashboard property round trip.
 *
 * `schemas/workflow-schema.json` is the source of truth for what a workflow can
 * express, but the dashboard is the surface most workflows are authored
 * through. This suite enumerates every user-authorable property in the schema
 * and drives it through the real persistence pipeline (`UPDATE_PROMPT` /
 * `UPDATE_FINAL_PROMPT` / `UPDATE_WORKFLOW_PROPERTY` -> `WorkflowOrchestrator`
 * -> `WorkingFileManager` -> disk) so a schema property that no dashboard
 * gesture can survive fails here instead of silently corrupting a user's file.
 *
 * Two invariants, deliberately independent of which controls the UI happens to
 * render today:
 *
 * 1. **Preservation** — a save that does not mention a property must not delete
 *    it. This is the invariant that matters: a property is safe only if the
 *    *persistence layer* keeps it, not because the editor currently remembers
 *    to enumerate it. `executionMode` is the proof — the prompt editor sends it
 *    and the context-menu enable/disable toggle does not, so "the UI sends it"
 *    is not a safety property.
 * 2. **Acceptance** — a property present in a save payload must land on disk.
 *    A property that fails here cannot be fixed by adding a UI control alone;
 *    the message-contract builder has to learn the key first.
 *
 * The `KNOWN_*` sets below intentionally stay empty. If a future regression
 * breaks one of these invariants, the failing test names the surface/property
 * directly instead of normalizing the loss as an expected gap.
 *
 * See `dev/implemented/WORKFLOW_SCHEMA_UI_PARITY_PLAN.md`.
 */

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../schemas/workflow-schema.json"
);

const PROMPT_TEXT = "seeded prompt text";
const SCRIPT_TEXT = "npm run seeded";

type SchemaObject = Record<string, unknown>;

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as SchemaObject;

function definition(name: string): SchemaObject {
  const definitions = schema.definitions as Record<string, SchemaObject>;
  const found = definitions[name];
  assert.ok(found, `schema definition ${name} not found`);
  return found;
}

function propertiesOf(node: SchemaObject): Record<string, SchemaObject> {
  return (node.properties ?? {}) as Record<string, SchemaObject>;
}

/**
 * The workflow-file root branch of the top-level `oneOf` — located by the
 * branch that declares `steps` rather than by index, so reordering the schema's
 * `oneOf` does not silently empty this suite.
 */
function workflowRootBranch(): SchemaObject {
  const branches = (schema.oneOf as SchemaObject[]).flatMap(
    (branch) => (branch.allOf as SchemaObject[] | undefined) ?? [branch]
  );
  const found = branches.find((branch) => "steps" in propertiesOf(branch));
  assert.ok(found, "workflow root branch declaring `steps` not found");
  return found;
}

/** The `promptStep` allOf member carrying its own (non-executionProperties) keys. */
function promptStepOwnBranch(): SchemaObject {
  const branches = definition("promptStep").allOf as SchemaObject[];
  const found = branches.find((branch) => "prompt" in propertiesOf(branch));
  assert.ok(found, "promptStep branch declaring `prompt` not found");
  return found;
}

/**
 * Not authorable properties, excluded from the matrix with a reason each.
 * Runtime blocks are written by the engine; content and identity keys travel in
 * the message's own dedicated fields (`text`, `promptName`) rather than in
 * `properties`, and are already covered by `promptPropertyRoundTrip`.
 */
const NOT_AUTHORABLE = new Map<string, string>([
  ["_runtime", "engine-written runtime block"],
  ["_templateMeta", "template-authoring surface, not a workflow property"],
  ["runtimeMetadata", "engine-written runtime block"],
  ["originalFile", "working-file bookkeeping"],
  ["workflowName", "working-file bookkeeping, renamed via its own message"],
  ["startedAt", "engine-written timestamp"],
  ["steps", "the step list itself, not a property of a step"],
  [
    "parallelGroups",
    "normalized working-file topology; authored as `parallel:` items",
  ],
  ["finalStep", "covered as its own surface below"],
  ["type", "step-kind discriminator carried by the message"],
  ["prompt", "step content carried by the message's `text`"],
  ["script", "step content carried by the message's `text`"],
  ["name", "carried by the message's dedicated `promptName` field"],
  ["enabled", "carried explicitly by every save payload; see the toggle tests"],
]);

function authorableProperties(node: SchemaObject): string[] {
  return Object.keys(propertiesOf(node))
    .filter((key) => !NOT_AUTHORABLE.has(key))
    .sort();
}

/**
 * One valid value per authorable property. A schema property with no sample
 * fails `sample coverage` below, so adding a property to the schema without
 * deciding how the dashboard round-trips it is a test failure at the moment the
 * schema changes.
 */
const SAMPLES: Record<string, unknown> = {
  color: "#123456",
  additionalArgs: "--effort high",
  agent: "seeded-agent",
  compareSource: "stdout",
  endCondition: {
    script: "npm test",
    returns: "true",
    env: { CI_TOKEN: "${secret:CI_TOKEN}" },
    maxRetries: 2,
  },
  env: { DEPLOY_TOKEN: "${secret:DEPLOY_TOKEN}" },
  errorBehavior: { onError: "retry", maxRetries: 2, retryDelayMs: 500 },
  executionMode: "headless",
  harness: "claude-cli",
  hooks: [
    {
      event: "stop",
      command: "echo done",
      env: { HOOK_TOKEN: "${secret:HOOK_TOKEN}" },
      timeoutSec: 30,
    },
  ],
  mcpServers: ["ctrlyoke"],
  model: "sonnet",
  onFail: "continue",
  onPass: "stopWorkflow",
  preCondition: {
    script: "git diff --quiet",
    onFail: "skipPrompt",
    env: { PRE_TOKEN: "${secret:PRE_TOKEN}" },
  },
  priorContext: "previous",
  resumeSession: true,
  returns: "OK",
  secrets: ["DEPLOY_TOKEN"],
  sessionId: "seeded-session-id",
  skills: ["seeded-skill"],
  timeout: 45000,
  toolPermissions: {
    mode: "custom",
    allowedTools: ["Bash"],
    deniedTools: ["Write"],
  },
  trustedExternalRoots: ["C:\\trusted\\workflow"],
  vars: { region: "us-east-1" },
  worktree: { mode: "named", branch: "feature/seeded" },
};

function sampleFor(property: string): unknown {
  assert.ok(
    property in SAMPLES,
    `No sample value for schema property "${property}". Add one to SAMPLES and decide which surfaces round-trip it.`
  );
  return JSON.parse(JSON.stringify(SAMPLES[property])) as unknown;
}

interface Surface {
  /** Stable id used in test names and in the KNOWN_* sets (`surface:property`). */
  readonly id: string;
  /** Authorable schema properties this surface can carry. */
  readonly properties: string[];
  /** Write the property into a hand-authored definition head. */
  seed(definitionHead: RunDefinition, property: string, value: unknown): void;
  /** Read back the object the property should live on. */
  read(definitionHead: RunDefinition): SchemaObject | undefined;
  /** A dashboard save that never mentions `property`. */
  saveWithout(harness: RoundTripHarness, property: string): Promise<void>;
  /** A dashboard save whose payload carries `property`. */
  saveWith(
    harness: RoundTripHarness,
    property: string,
    value: unknown
  ): Promise<void>;
  /** Build the workflow used to schema-validate this surface's sample. */
  validationDocument(property: string, value: unknown): SchemaObject;
}

const executionProperties = () =>
  authorableProperties(definition("executionProperties"));

const rootProperties = () =>
  Array.from(
    new Set([
      ...executionProperties(),
      ...authorableProperties(definition("workflowOnlyProperties")),
      ...authorableProperties(workflowRootBranch()),
    ])
  ).sort();

const promptStepProperties = () =>
  Array.from(
    new Set([
      ...executionProperties(),
      ...authorableProperties(promptStepOwnBranch()),
    ])
  ).sort();

const scriptStepProperties = () =>
  authorableProperties(definition("scriptStep"));

const promptStepSeed = () => ({ prompt: PROMPT_TEXT });
const scriptStepSeed = () => ({ type: "script", script: SCRIPT_TEXT });

const SURFACES: Surface[] = [
  {
    id: "workflow root",
    properties: rootProperties(),
    seed: (head, property, value) => {
      head[property] = value;
    },
    read: (head) => head,
    saveWithout: (harness, property) =>
      harness.routeWorkflowPropertyUpdate(
        property === "model" ? "harness" : "model",
        property === "model" ? "codex-cli" : "sonnet"
      ),
    saveWith: (harness, property, value) =>
      harness.routeWorkflowPropertyUpdate(property, value),
    validationDocument: (property, value) => ({
      steps: [promptStepSeed()],
      [property]: value,
    }),
  },
  {
    id: "prompt step",
    properties: promptStepProperties(),
    seed: (head, property, value) => {
      head.steps = [{ ...promptStepSeed(), [property]: value }];
    },
    read: (head) => head.steps?.[0],
    saveWithout: (harness) =>
      harness.routeUpdatePrompt({
        index: 0,
        text: PROMPT_TEXT,
        properties: {},
      }),
    saveWith: (harness, property, value) =>
      harness.routeUpdatePrompt({
        index: 0,
        text: PROMPT_TEXT,
        properties: { [property]: value },
      }),
    validationDocument: (property, value) => ({
      steps: [{ ...promptStepSeed(), [property]: value }],
    }),
  },
  {
    id: "script step",
    properties: scriptStepProperties(),
    seed: (head, property, value) => {
      head.steps = [{ ...scriptStepSeed(), [property]: value }];
    },
    read: (head) => head.steps?.[0],
    saveWithout: (harness) =>
      harness.routeUpdatePrompt({
        index: 0,
        text: SCRIPT_TEXT,
        properties: { type: "script" },
      }),
    saveWith: (harness, property, value) =>
      harness.routeUpdatePrompt({
        index: 0,
        text: SCRIPT_TEXT,
        properties: { type: "script", [property]: value },
      }),
    validationDocument: (property, value) => ({
      steps: [{ ...scriptStepSeed(), [property]: value }],
    }),
  },
  {
    id: "final step (prompt)",
    properties: promptStepProperties(),
    seed: (head, property, value) => {
      head.finalStep = { ...promptStepSeed(), [property]: value };
    },
    read: (head) => head.finalStep,
    saveWithout: (harness) =>
      harness.routeUpdateFinalPrompt({
        finalStep: { prompt: PROMPT_TEXT },
      }),
    saveWith: (harness, property, value) =>
      harness.routeUpdateFinalPrompt({
        finalStep: { prompt: PROMPT_TEXT, [property]: value } as never,
      }),
    validationDocument: (property, value) => ({
      steps: [promptStepSeed()],
      finalStep: { ...promptStepSeed(), [property]: value },
    }),
  },
  {
    id: "final step (script)",
    properties: scriptStepProperties(),
    seed: (head, property, value) => {
      head.finalStep = { ...scriptStepSeed(), [property]: value };
    },
    read: (head) => head.finalStep,
    saveWithout: (harness) =>
      harness.routeUpdateFinalPrompt({
        finalStep: { type: "script", script: SCRIPT_TEXT } as never,
      }),
    saveWith: (harness, property, value) =>
      harness.routeUpdateFinalPrompt({
        finalStep: {
          type: "script",
          script: SCRIPT_TEXT,
          [property]: value,
        } as never,
      }),
    validationDocument: (property, value) => ({
      steps: [promptStepSeed()],
      finalStep: { ...scriptStepSeed(), [property]: value },
    }),
  },
];

/**
 * One source-literal control id (or template-literal body) for every
 * authorable schema property. Dynamic ids deliberately use the exact
 * template-literal body from the component, so the source scan below still
 * catches a renamed or removed control without pretending to render React in
 * this extension-host suite.
 */
const UI_CONTROL_IDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["additionalArgs", ["settings-append-args"]],
  ["agent", ["settings-agent"]],
  ["compareSource", ["${idPrefix}-compare-source"]],
  ["endCondition", ["settings-end-condition-enabled"]],
  ["env", ["${idPrefix}-env"]],
  ["errorBehavior", ["settings-error"]],
  ["executionMode", ["settings-execution-mode"]],
  ["harness", ["settings-harness"]],
  ["hooks", ["hook-${index}-command"]],
  ["mcpServers", ["settings-mcp-servers"]],
  ["model", ["settings-model"]],
  ["onFail", ["${idPrefix}-on-fail"]],
  ["onPass", ["${idPrefix}-on-pass"]],
  ["preCondition", ["settings-pre-condition-enabled"]],
  ["priorContext", ["settings-prior-context"]],
  ["resumeSession", ["settings-resume-session"]],
  ["returns", ["${idPrefix}-returns"]],
  ["secrets", ["${idPrefix}-control"]],
  ["sessionId", ["settings-session-id"]],
  ["skills", ["settings-skills"]],
  ["timeout", ["${idPrefix}-timeout"]],
  ["toolPermissions", ["settings-permission-mode"]],
  ["trustedExternalRoots", ["settings-trusted-external-roots-mode"]],
  ["vars", ["settings-vars"]],
  ["worktree", ["settings-worktree-mode"]],
]);

/**
 * Properties temporarily reachable only through persisted/hand-authored data
 * may be listed here with an explanation while their editor control is staged.
 */
const UI_CONTROL_OPTOUTS = new Map<string, string>([
  [
    "color",
    "data layer landed in sequencing item 8; editor mounts are the follow-up",
  ],
]);

const WEBVIEW_SOURCE_ROOT = path.resolve(
  __dirname,
  "../../../src/ui/webview-react"
);

/**
 * Vitest suites live under `src/ui/webview-react/test/` and reference the same
 * control ids they render. Scanning them would let a deleted control keep
 * passing this guard purely because its own test still names the id, which is
 * the opposite of what the guard is for — only production source counts.
 */
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

/** Keep empty: every authorable property must survive an omitted save payload. */
const KNOWN_LOSSY_PRESERVATION = new Set<string>();

/** Keep empty: every authorable property must be accepted by its save payload. */
const KNOWN_UNACCEPTED = new Set<string>();

suite("Schema -> dashboard property round trip", () => {
  let workspace = "";

  async function seededHarness(
    surface: Surface,
    property: string,
    value: unknown,
    options: { seed: boolean } = { seed: true }
  ): Promise<RoundTripHarness> {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-parity-"));
    const run = await createPromotedRun(workspace, {
      steps: [{ prompt: PROMPT_TEXT }],
    });
    const harness = createRoundTripHarness(workspace, run);
    if (options.seed) {
      await harness.patchRunDefinition((head) =>
        surface.seed(head, property, value)
      );
      const seeded = surface.read(await harness.readRunDefinition());
      assert.deepStrictEqual(
        seeded?.[property],
        value,
        `seed did not land on disk for ${surface.id}:${property}`
      );
    }
    return harness;
  }

  teardown(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
      workspace = "";
    }
  });

  suite("sample coverage", () => {
    test("every authorable schema property has a sample value", () => {
      const missing = SURFACES.flatMap((surface) =>
        surface.properties
          .filter((property) => !(property in SAMPLES))
          .map((property) => `${surface.id}:${property}`)
      );
      assert.deepStrictEqual(
        missing,
        [],
        `Schema properties with no sample value: ${missing.join(", ")}`
      );
    });

    test("every sample value validates against the schema", () => {
      const ajv = new Ajv({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      const invalid: string[] = [];
      for (const surface of SURFACES) {
        for (const property of surface.properties) {
          const document = surface.validationDocument(
            property,
            sampleFor(property)
          );
          if (!validate(document)) {
            invalid.push(
              `${surface.id}:${property} -> ${ajv.errorsText(validate.errors)}`
            );
          }
        }
      }
      assert.deepStrictEqual(
        invalid,
        [],
        `Sample values rejected by the schema:\n${invalid.join("\n")}`
      );
    });

    test("no KNOWN_* entry names a surface/property pair that does not exist", () => {
      const known = new Set(
        SURFACES.flatMap((surface) =>
          surface.properties.map((property) => `${surface.id}:${property}`)
        )
      );
      const stale = [...KNOWN_LOSSY_PRESERVATION, ...KNOWN_UNACCEPTED].filter(
        (entry) => !known.has(entry)
      );
      assert.deepStrictEqual(
        stale,
        [],
        `KNOWN_* entries for properties that no longer exist: ${stale.join(", ")}`
      );
    });

    test("KNOWN_* regression allowances remain empty", () => {
      assert.strictEqual(
        KNOWN_LOSSY_PRESERVATION.size,
        0,
        "KNOWN_LOSSY_PRESERVATION must stay empty; fix the regression instead"
      );
      assert.strictEqual(
        KNOWN_UNACCEPTED.size,
        0,
        "KNOWN_UNACCEPTED must stay empty; fix the regression instead"
      );
    });

    test("every authorable schema property has a live UI control id", () => {
      const authorable = new Set(
        SURFACES.flatMap((surface) => surface.properties)
      );
      const registered = new Set(UI_CONTROL_IDS.keys());
      const source = webviewSource();
      const failures: string[] = [];

      for (const property of authorable) {
        if (UI_CONTROL_OPTOUTS.has(property)) continue;
        const controlIds = UI_CONTROL_IDS.get(property);
        if (!controlIds || controlIds.length === 0) {
          failures.push(
            `${property}: missing registry entry — add a UI control, register its id, or opt out with a written reason`
          );
          continue;
        }
        for (const controlId of controlIds) {
          if (!source.includes(controlId)) {
            failures.push(
              `${property}: registered control id "${controlId}" is absent from src/ui/webview-react — add the control, register its current id, or opt out with a written reason`
            );
          }
        }
      }

      for (const property of registered) {
        if (!authorable.has(property) && !UI_CONTROL_OPTOUTS.has(property)) {
          failures.push(
            `${property}: registry entry has no authorable schema property — remove it or add the property to the schema/sample table`
          );
        }
      }

      for (const [property, reason] of UI_CONTROL_OPTOUTS) {
        if (!reason.trim()) {
          failures.push(
            `${property}: UI opt-out must include a written reason`
          );
        }
        if (!authorable.has(property)) {
          failures.push(
            `${property}: UI opt-out names no authorable schema property — remove it or add the property to the schema/sample table`
          );
        }
      }

      assert.deepStrictEqual(
        failures,
        [],
        `Schema → UI control parity failures:\n${failures.join("\n")}`
      );
    });
  });

  /**
   * The matrix above states a contract. This states the user-visible symptom:
   * the exact payload `PromptEditor.handleUpdate` posts for a script step whose
   * editable controls are all at their loaded values, against a step a person
   * (or the CLI) hand-authored. Kept concrete so the regression is legible
   * without reading the surface table.
   */
  suite("user-reachable reproduction", () => {
    test("dashboard-authored condition and hook properties survive later saves", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-parity-"));
      const run = await createPromotedRun(workspace, {
        steps: [{ prompt: PROMPT_TEXT }],
      });
      const harness = createRoundTripHarness(workspace, run);
      const workflowPreCondition = {
        script: "git diff --quiet",
        env: { PRE_TOKEN: "${secret:PRE_TOKEN}" },
      };
      const workflowEndCondition = {
        script: "npm test",
        returns: "true",
        env: { END_TOKEN: "${secret:END_TOKEN}" },
      };
      const workflowHooks = [
        {
          event: "stop",
          command: "echo done",
          env: { HOOK_TOKEN: "${secret:HOOK_TOKEN}" },
          timeoutSec: 30,
        },
      ];
      const stepPreCondition = {
        script: "git diff --quiet",
        env: { STEP_PRE_TOKEN: "${secret:STEP_PRE_TOKEN}" },
      };
      const stepEndCondition = {
        script: "npm test",
        returns: "true",
        env: { STEP_END_TOKEN: "${secret:STEP_END_TOKEN}" },
      };
      const stepHooks = [
        {
          event: "stop",
          command: "echo step done",
          env: { STEP_HOOK_TOKEN: "${secret:STEP_HOOK_TOKEN}" },
          timeoutSec: 45,
        },
      ];

      await harness.routeWorkflowPropertyUpdate(
        "preCondition",
        workflowPreCondition
      );
      await harness.routeWorkflowPropertyUpdate(
        "endCondition",
        workflowEndCondition
      );
      await harness.routeWorkflowPropertyUpdate("hooks", workflowHooks);
      await harness.routeUpdatePrompt({
        index: 0,
        text: PROMPT_TEXT,
        properties: {
          preCondition: stepPreCondition,
          endCondition: stepEndCondition,
          hooks: stepHooks,
        },
      });

      // These unrelated saves model later dashboard gestures. They must not
      // replace the nested condition/hook properties written above.
      await harness.routeWorkflowPropertyUpdate("model", "sonnet");
      await harness.routeUpdatePrompt({
        index: 0,
        text: "updated prompt text",
        properties: {},
      });

      const definition = await harness.readRunDefinition();
      assert.deepStrictEqual(definition.preCondition, workflowPreCondition);
      assert.deepStrictEqual(definition.endCondition, workflowEndCondition);
      assert.deepStrictEqual(definition.hooks, workflowHooks);
      assert.deepStrictEqual(definition.steps?.[0], {
        prompt: "updated prompt text",
        preCondition: stepPreCondition,
        endCondition: stepEndCondition,
        hooks: stepHooks,
      });
    });

    test("saving a hand-authored script step preserves unenumerated properties", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-parity-"));
      const run = await createPromotedRun(workspace, {
        steps: [{ prompt: PROMPT_TEXT }],
      });
      const harness = createRoundTripHarness(workspace, run);
      await harness.patchRunDefinition((head) => {
        head.steps = [
          {
            type: "script",
            script: "npm run deploy",
            name: "Deploy",
            env: { DEPLOY_TOKEN: "${secret:DEPLOY_TOKEN}" },
            secrets: ["DEPLOY_TOKEN"],
            errorBehavior: { onError: "continue" },
            executionMode: "headless",
            timeout: 60000,
          },
        ];
      });

      // PromptEditor.handleUpdate, script branch: the user changed nothing.
      await harness.routeUpdatePrompt({
        index: 0,
        text: "npm run deploy",
        promptName: "Deploy",
        properties: {
          type: "script",
          timeout: 60000,
          executionMode: "headless",
        },
      });

      assert.deepStrictEqual((await harness.readRunDefinition()).steps?.[0], {
        type: "script",
        script: "npm run deploy",
        name: "Deploy",
        env: { DEPLOY_TOKEN: "${secret:DEPLOY_TOKEN}" },
        secrets: ["DEPLOY_TOKEN"],
        errorBehavior: { onError: "continue" },
        executionMode: "headless",
        timeout: 60000,
      });
    });

    test("dashboard-authored script properties survive a later unrelated save", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-parity-"));
      const run = await createPromotedRun(workspace, {
        steps: [{ prompt: PROMPT_TEXT }],
      });
      const harness = createRoundTripHarness(workspace, run);

      await harness.routeUpdatePrompt({
        index: 0,
        text: "npm run deploy",
        properties: {
          type: "script",
          env: { DEPLOY_TOKEN: "${secret:DEPLOY_TOKEN}" },
          secrets: ["DEPLOY_TOKEN"],
          errorBehavior: { onError: "continue" },
        },
      });

      await harness.routeUpdatePrompt({
        index: 0,
        text: "npm run deploy -- --verbose",
        properties: { type: "script" },
      });

      assert.deepStrictEqual((await harness.readRunDefinition()).steps?.[0], {
        type: "script",
        script: "npm run deploy -- --verbose",
        env: { DEPLOY_TOKEN: "${secret:DEPLOY_TOKEN}" },
        secrets: ["DEPLOY_TOKEN"],
        errorBehavior: { onError: "continue" },
      });
    });

    test("saving default script values clears previously customized fields", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-parity-"));
      const run = await createPromotedRun(workspace, {
        steps: [{ prompt: PROMPT_TEXT }],
      });
      const harness = createRoundTripHarness(workspace, run);
      await harness.patchRunDefinition((head) => {
        head.steps = [
          {
            type: "script",
            script: SCRIPT_TEXT,
            timeout: 60000,
            onPass: "stopWorkflow",
            onFail: "continue",
            compareSource: "stdout",
            returns: "OK",
            executionMode: "headless",
          },
        ];
      });

      await harness.routeUpdatePrompt({
        index: 0,
        text: SCRIPT_TEXT,
        properties: { type: "script" },
        clearProperties: [
          "timeout",
          "onPass",
          "onFail",
          "compareSource",
          "returns",
          "executionMode",
        ],
      });

      assert.deepStrictEqual((await harness.readRunDefinition()).steps?.[0], {
        type: "script",
        script: SCRIPT_TEXT,
      });
    });

    test("prompt to script changes replace the previous step wholesale", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-parity-"));
      const run = await createPromotedRun(workspace, {
        steps: [{ prompt: PROMPT_TEXT }],
      });
      const harness = createRoundTripHarness(workspace, run);
      await harness.patchRunDefinition((head) => {
        head.steps = [
          {
            prompt: PROMPT_TEXT,
            harness: "claude-cli",
            _runtime: { completedAt: 123 },
          },
        ];
      });

      await harness.routeUpdatePrompt({
        index: 0,
        text: SCRIPT_TEXT,
        properties: { type: "script", executionMode: "headless" },
      });

      assert.deepStrictEqual((await harness.readRunDefinition()).steps?.[0], {
        type: "script",
        script: SCRIPT_TEXT,
        executionMode: "headless",
      });
    });

    test("script to prompt changes replace the previous step wholesale", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-parity-"));
      const run = await createPromotedRun(workspace, {
        steps: [{ prompt: PROMPT_TEXT }],
      });
      const harness = createRoundTripHarness(workspace, run);
      await harness.patchRunDefinition((head) => {
        head.steps = [
          {
            type: "script",
            script: SCRIPT_TEXT,
            env: { DEPLOY_TOKEN: "${secret:DEPLOY_TOKEN}" },
            _runtime: { completedAt: 123 },
          },
        ];
      });

      await harness.routeUpdatePrompt({
        index: 0,
        text: PROMPT_TEXT,
        properties: {},
      });

      assert.deepStrictEqual((await harness.readRunDefinition()).steps?.[0], {
        prompt: PROMPT_TEXT,
      });
    });
  });

  for (const surface of SURFACES) {
    suite(`preservation - ${surface.id}`, () => {
      for (const property of surface.properties) {
        const key = `${surface.id}:${property}`;
        test(`saving without \`${property}\` keeps it`, async () => {
          const value = sampleFor(property);
          const harness = await seededHarness(surface, property, value);

          await surface.saveWithout(harness, property);

          const after = surface.read(await harness.readRunDefinition());
          const preserved =
            JSON.stringify(after?.[property]) === JSON.stringify(value);

          if (KNOWN_LOSSY_PRESERVATION.has(key)) {
            assert.ok(
              !preserved,
              `${key} now survives a save. Remove it from KNOWN_LOSSY_PRESERVATION.`
            );
            return;
          }
          assert.deepStrictEqual(
            after?.[property],
            value,
            `Saving deleted ${key}. Either fix the persistence path or add "${key}" to KNOWN_LOSSY_PRESERVATION with a reason.`
          );
        });
      }
    });

    suite(`acceptance - ${surface.id}`, () => {
      for (const property of surface.properties) {
        const key = `${surface.id}:${property}`;
        test(`a save payload carrying \`${property}\` persists it`, async () => {
          const value = sampleFor(property);
          const harness = await seededHarness(surface, property, value, {
            seed: false,
          });

          await surface.saveWith(harness, property, value);

          const after = surface.read(await harness.readRunDefinition());
          const accepted =
            JSON.stringify(after?.[property]) === JSON.stringify(value);

          if (KNOWN_UNACCEPTED.has(key)) {
            assert.ok(
              !accepted,
              `${key} now persists. Remove it from KNOWN_UNACCEPTED.`
            );
            return;
          }
          assert.deepStrictEqual(
            after?.[property],
            value,
            `A save payload carrying ${key} did not persist it. Either teach the message-contract builder the key or add "${key}" to KNOWN_UNACCEPTED with a reason.`
          );
        });
      }
    });
  }
});
