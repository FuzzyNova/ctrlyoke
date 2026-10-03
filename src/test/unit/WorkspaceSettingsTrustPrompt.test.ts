import * as assert from "assert";
import { suite, test } from "mocha";
import {
  WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS,
  WorkspaceSettingsTrustPrompter,
  promptForWorkspaceSettingsTrust,
} from "../../ui/WorkspaceSettingsTrustPrompt";
import type {
  BatchApprovalRequest,
  BatchApprovalResult,
  ChoiceRequest,
  UserInteractionPort,
} from "../../ui/UserInteractionPort";
import type { WorkspaceSensitiveSettingState } from "../../config/CtrlYokeConfigService";
import type { WorkspaceSensitiveSettingRequest } from "../../config/WorkspaceSensitiveSettings";
import type { WorkspaceSettingsTrustAccess } from "../../config/WorkspaceSettingsTrust";
import { TRUST_DECISIONS } from "../../types/DashboardConstants";

const WORKSPACE = "workspace-root";

class ScriptedPort implements UserInteractionPort {
  readonly requests: BatchApprovalRequest[] = [];

  constructor(
    private readonly respond: (
      request: BatchApprovalRequest
    ) => BatchApprovalResult | undefined,
    private readonly available = true
  ) {}

  canPrompt(): boolean {
    return this.available;
  }

  async requestBatchApproval(
    request: BatchApprovalRequest
  ): Promise<BatchApprovalResult | undefined> {
    this.requests.push(request);
    return this.respond(request);
  }

  async requestChoice(_request: ChoiceRequest): Promise<string | undefined> {
    return undefined;
  }
}

class FakeAccess implements WorkspaceSettingsTrustAccess {
  approved: string[] = [];
  denied: string[] = [];
  loads = 0;

  constructor(private readonly states: WorkspaceSensitiveSettingState[]) {}

  async loadStates(): Promise<WorkspaceSensitiveSettingState[]> {
    this.loads++;
    return this.states;
  }

  async recordDecisions(
    _workspaceRoot: string,
    approved: readonly WorkspaceSensitiveSettingRequest[],
    denied: readonly WorkspaceSensitiveSettingRequest[]
  ): Promise<void> {
    this.approved.push(...approved.map((request) => request.summary));
    this.denied.push(...denied.map((request) => request.summary));
  }
}

function state(
  summary: string,
  decision?: WorkspaceSensitiveSettingState["decision"]
): WorkspaceSensitiveSettingState {
  return {
    request: { settingPath: "defaults.hooks", fingerprint: summary, summary },
    decision,
  };
}

suite("WorkspaceSettingsTrustPrompt", () => {
  test("asks with every undecided value unchecked and records the answer", async () => {
    const access = new FakeAccess([
      state("first"),
      state("second"),
      state("old", TRUST_DECISIONS.DENY),
    ]);
    const port = new ScriptedPort((request) => ({
      approvedValues: [request.items[0]!.value],
      deniedValues: [request.items[1]!.value],
    }));

    const result = await promptForWorkspaceSettingsTrust(
      WORKSPACE,
      port,
      {},
      access
    );

    assert.strictEqual(result, WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.DECIDED);
    assert.deepStrictEqual(
      port.requests[0]!.items.map((item) => [item.label, item.checked]),
      [
        ["first", false],
        ["second", false],
      ]
    );
    assert.deepStrictEqual(access.approved, ["first"]);
    assert.deepStrictEqual(access.denied, ["second"]);
  });

  test("review mode lists decided values pre-checked by their decision", async () => {
    const access = new FakeAccess([
      state("on", TRUST_DECISIONS.ALLOW),
      state("off", TRUST_DECISIONS.DENY),
    ]);
    const port = new ScriptedPort(() => undefined);

    const result = await promptForWorkspaceSettingsTrust(
      WORKSPACE,
      port,
      { includeDecided: true },
      access
    );

    assert.strictEqual(
      result,
      WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.DISMISSED
    );
    assert.deepStrictEqual(
      port.requests[0]!.items.map((item) => item.checked),
      [true, false]
    );
    assert.deepStrictEqual(access.approved, [], "dismissing decides nothing");
    assert.deepStrictEqual(access.denied, []);
  });

  test("does nothing when there is nothing to ask or nobody to ask", async () => {
    const port = new ScriptedPort(() => undefined, false);
    assert.strictEqual(
      await promptForWorkspaceSettingsTrust(
        WORKSPACE,
        port,
        {},
        new FakeAccess([state("done", TRUST_DECISIONS.ALLOW)])
      ),
      WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.NOTHING_TO_REVIEW
    );
    assert.strictEqual(
      await promptForWorkspaceSettingsTrust(
        WORKSPACE,
        port,
        {},
        new FakeAccess([state("pending")])
      ),
      WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.CANNOT_PROMPT
    );
    assert.deepStrictEqual(port.requests, []);
  });

  test("the prompter declines while the host cannot ask", async () => {
    const access = new FakeAccess([state("pending")]);
    const prompter = new WorkspaceSettingsTrustPrompter(
      () => WORKSPACE,
      async () => {
        throw new Error("must not fetch a port");
      },
      () => false,
      access
    );
    assert.strictEqual(
      await prompter.prompt(),
      WORKSPACE_SETTINGS_TRUST_PROMPT_RESULTS.CANNOT_PROMPT
    );
    assert.strictEqual(access.loads, 0);
  });

  test("the prompter shows one prompt at a time", async () => {
    let releaseFirst!: () => void;
    const firstAnswered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let open = 0;
    let maxOpen = 0;
    const port = new ScriptedPort(() => undefined);
    port.requestBatchApproval = async (request) => {
      port.requests.push(request);
      open++;
      maxOpen = Math.max(maxOpen, open);
      if (port.requests.length === 1) await firstAnswered;
      open--;
      return undefined;
    };
    const prompter = new WorkspaceSettingsTrustPrompter(
      () => WORKSPACE,
      async () => port,
      () => true,
      new FakeAccess([state("pending")])
    );

    const first = prompter.prompt();
    const second = prompter.prompt();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(port.requests.length, 1, "second waits for the first");
    releaseFirst();
    await Promise.all([first, second]);

    assert.strictEqual(port.requests.length, 2);
    assert.strictEqual(maxOpen, 1);
  });
});
