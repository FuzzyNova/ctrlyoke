import * as assert from "assert";
import { suite, test } from "mocha";
import {
  ensureWorkspaceSettingsDecided,
  trustWorkspaceSettingsCommand,
} from "../../cli/WorkspaceSettingsTrustCommands";
import type { WorkspaceSensitiveSettingState } from "../../config/CtrlYokeConfigService";
import type { WorkspaceSensitiveSettingRequest } from "../../config/WorkspaceSensitiveSettings";
import type { WorkspaceSettingsTrustAccess } from "../../config/WorkspaceSettingsTrust";
import { TRUST_DECISIONS } from "../../types/DashboardConstants";
import { RecordingCliTrustIo } from "../helpers/RecordingCliTrustIo";

const WORKSPACE = "workspace-root";

function state(
  summary: string,
  decision?: WorkspaceSensitiveSettingState["decision"]
): WorkspaceSensitiveSettingState {
  return {
    request: {
      settingPath: "terminal.shellExecutable",
      fingerprint: summary,
      summary,
    },
    decision,
  };
}

class RecordingDependencies implements WorkspaceSettingsTrustAccess {
  approved: string[] = [];
  denied: string[] = [];

  constructor(private readonly states: WorkspaceSensitiveSettingState[]) {}

  async loadStates(): Promise<WorkspaceSensitiveSettingState[]> {
    return this.states;
  }

  async recordDecisions(
    workspaceRoot: string,
    approved: readonly WorkspaceSensitiveSettingRequest[],
    denied: readonly WorkspaceSensitiveSettingRequest[]
  ): Promise<void> {
    assert.strictEqual(workspaceRoot, WORKSPACE);
    this.approved.push(...approved.map((request) => request.summary));
    this.denied.push(...denied.map((request) => request.summary));
  }
}

suite("WorkspaceSettingsTrustCommands", () => {
  suite("ensureWorkspaceSettingsDecided", () => {
    test("proceeds silently when nothing is undecided", async () => {
      const io = new RecordingCliTrustIo(false);
      const result = await ensureWorkspaceSettingsDecided(
        WORKSPACE,
        io,
        new RecordingDependencies([state("a", TRUST_DECISIONS.DENY)])
      );
      assert.strictEqual(result, undefined);
      assert.deepStrictEqual(io.err, []);
    });

    test("fails closed with exit code 2 when it cannot ask", async () => {
      const io = new RecordingCliTrustIo(false);
      const dependencies = new RecordingDependencies([state("shell: ./evil")]);
      const result = await ensureWorkspaceSettingsDecided(
        WORKSPACE,
        io,
        dependencies
      );
      assert.strictEqual(result, 2);
      assert.ok(io.err.some((line) => line.includes("shell: ./evil")));
      assert.ok(
        io.err.some((line) => line.includes("trust-workspace-settings"))
      );
      assert.deepStrictEqual(dependencies.approved, []);
      assert.deepStrictEqual(dependencies.denied, []);
    });

    test("asks about each undecided value in a terminal and continues", async () => {
      const io = new RecordingCliTrustIo(true, [true, false]);
      const dependencies = new RecordingDependencies([
        state("first"),
        state("decided", TRUST_DECISIONS.ALLOW),
        state("second"),
      ]);
      const result = await ensureWorkspaceSettingsDecided(
        WORKSPACE,
        io,
        dependencies
      );
      assert.strictEqual(result, undefined);
      assert.strictEqual(io.questions.length, 2);
      assert.deepStrictEqual(dependencies.approved, ["first"]);
      assert.deepStrictEqual(dependencies.denied, ["second"]);
    });
  });

  suite("trustWorkspaceSettingsCommand", () => {
    test("reports nothing to review", async () => {
      const io = new RecordingCliTrustIo(true);
      const code = await trustWorkspaceSettingsCommand(
        WORKSPACE,
        {},
        io,
        new RecordingDependencies([state("a", TRUST_DECISIONS.ALLOW)])
      );
      assert.strictEqual(code, 0);
      assert.ok(io.out[0]!.includes("--all"));
    });

    test("--yes allows every undecided value without asking", async () => {
      const io = new RecordingCliTrustIo(false);
      const dependencies = new RecordingDependencies([
        state("a"),
        state("b", TRUST_DECISIONS.DENY),
      ]);
      const code = await trustWorkspaceSettingsCommand(
        WORKSPACE,
        { yes: true },
        io,
        dependencies
      );
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(dependencies.approved, ["a"]);
      assert.deepStrictEqual(io.questions, []);
    });

    test("--all re-asks about decided values, showing the current answer", async () => {
      const io = new RecordingCliTrustIo(true, [true]);
      const dependencies = new RecordingDependencies([
        state("b", TRUST_DECISIONS.DENY),
      ]);
      const code = await trustWorkspaceSettingsCommand(
        WORKSPACE,
        { all: true },
        io,
        dependencies
      );
      assert.strictEqual(code, 0);
      assert.ok(io.questions[0]!.includes("[denied]"));
      assert.deepStrictEqual(dependencies.approved, ["b"]);
    });

    test("refuses to guess without a terminal", async () => {
      const io = new RecordingCliTrustIo(false);
      const code = await trustWorkspaceSettingsCommand(
        WORKSPACE,
        {},
        io,
        new RecordingDependencies([state("a")])
      );
      assert.strictEqual(code, 2);
    });
  });
});
