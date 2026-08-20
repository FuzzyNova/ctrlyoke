import { suite, test, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import { readFileSync } from "fs";
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
 * Properties known to violate an invariant are listed in the `KNOWN_*` sets
 * below with a reason. Those entries are asserted to *still* fail, so fixing
 * one turns this suite red until the entry is removed — the list can only
 * shrink by accident, never grow.
 *
 * See `dev/backlog/WORKFLOW_SCHEMA_UI_PARITY_PLAN.md`.
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
 * `surface:property` pairs where a save that does not mention the property
 * deletes it. Every entry is a live persistence bug, not a design decision —
 * see `dev/backlog/WORKFLOW_SCHEMA_UI_PARITY_PLAN.md`. The list can only
 * shrink: an entry that starts passing fails the matching test until removed.
 *
 * Whether a given entry is *reachable today* depends on which payload builder
 * the gesture goes through, and that is exactly the fragility. `executionMode`
 * is the proof: the prompt editor enumerates it, the context-menu enable /
 * disable toggle does not, and the persistence layer protects neither.
 */
const KNOWN_LOSSY_PRESERVATION = new Set<string>([
  // Script steps are replaced, never merged. `WorkflowInstance.updatePromptInQueue`
  // and `buildPromptStepChange` rebuild the step from the save payload alone
  // (`PromptQueue.replaceStep` / `nextSteps[index] = change.replace`), so every
  // property the payload omits is deleted. The replace itself is deliberate — it
  // is what makes a prompt -> script type change clean — but it must merge over
  // the existing step when the step is already a script step.
  "script step:compareSource",
  "script step:env",
  "script step:errorBehavior",
  "script step:executionMode",
  "script step:onFail",
  "script step:onPass",
  "script step:returns",
  "script step:secrets",
  "script step:timeout",

  // `finalStep` is written as one whole property, so the stored step is only ever
  // as complete as the editor's outgoing object: `WorkflowInstance.updateFinalStepInQueue`
  // rebuilds a prompt final step as `prompt` + `name` + `buildPromptStepProperties(...)`,
  // and `WorkflowOrchestrator.updateFinalStepInQueue` does the same on the
  // addressed path. Nothing merges against what is already on disk.
  "final step (prompt):additionalArgs",
  "final step (prompt):agent",
  "final step (prompt):endCondition",
  "final step (prompt):errorBehavior",
  "final step (prompt):executionMode",
  "final step (prompt):harness",
  "final step (prompt):hooks",
  "final step (prompt):mcpServers",
  "final step (prompt):model",
  "final step (prompt):preCondition",
  "final step (prompt):priorContext",
  "final step (prompt):resumeSession",
  "final step (prompt):secrets",
  "final step (prompt):sessionId",
  "final step (prompt):skills",
  "final step (prompt):toolPermissions",

  // Script final steps take the same replace path, via
  // `stripViewOnlyWorkflowStepFields(finalStep)` — whatever the editor enumerated,
  // verbatim.
  "final step (script):compareSource",
  "final step (script):env",
  "final step (script):errorBehavior",
  "final step (script):executionMode",
  "final step (script):onFail",
  "final step (script):onPass",
  "final step (script):returns",
  "final step (script):secrets",
  "final step (script):timeout",
]);

/**
 * `surface:property` pairs the save payload cannot carry: the message-contract
 * builder has no case for the key, so a UI control alone would not persist it.
 */
const KNOWN_UNACCEPTED = new Set<string>([
  // `buildPromptStepProperties` has no `secrets` case, so a prompt step's secret
  // grant cannot be written through UPDATE_PROMPT / UPDATE_FINAL_PROMPT at all.
  // Harmless today only because the prompt-step path merges and therefore never
  // destroys an existing grant — but the step-drawer `secrets` control the parity
  // plan calls for will silently do nothing until that builder learns the key.
  // The script-step builder (`buildScriptStepFromProperties`) already handles it.
  "prompt step:secrets",
  "final step (prompt):secrets",
]);

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
  });

  /**
   * The matrix above states a contract. This states the user-visible symptom:
   * the exact payload `PromptEditor.handleUpdate` posts for a script step whose
   * editable controls are all at their loaded values, against a step a person
   * (or the CLI) hand-authored. Kept concrete so the regression is legible
   * without reading the surface table.
   */
  suite("user-reachable reproduction", () => {
    test("KNOWN BUG: saving a hand-authored script step deletes env, secrets and errorBehavior", async () => {
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

      // Invert this assertion once the script path merges instead of replacing.
      assert.deepStrictEqual((await harness.readRunDefinition()).steps?.[0], {
        type: "script",
        script: "npm run deploy",
        executionMode: "headless",
        name: "Deploy",
        timeout: 60000,
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
