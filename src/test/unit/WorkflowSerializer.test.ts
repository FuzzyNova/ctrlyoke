import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { WorkflowSerializer } from "../../ui/WorkflowSerializer";
import { configService } from "../../config/FlightPathConfigService";
import { CONFIG_KEYS } from "../../utils/ConfigurationUtils";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";

suite("WorkflowSerializer", () => {
  suite("handleSetDefaultTemplate", () => {
    test("should write general.defaultTemplate and notify the webview", async () => {
      const originalSet = configService.set.bind(configService);
      const setCalls: Array<{ key: string; value: unknown; scope: string }> =
        [];
      const messages: any[] = [];

      try {
        configService.set = (async (key, value, scope) => {
          setCalls.push({ key, value, scope });
        }) as typeof configService.set;

        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined
        );

        await serializer.handleSetDefaultTemplate("blank");

        assert.deepStrictEqual(setCalls, [
          {
            key: CONFIG_KEYS.GENERAL_DEFAULT_TEMPLATE,
            value: "blank",
            scope: "user",
          },
        ]);
        assert.deepStrictEqual(messages, [
          {
            type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
            templateId: "blank",
          },
        ]);
      } finally {
        configService.set = originalSet;
      }
    });
  });

  suite("handleSaveWorkflow", () => {
    test("should persist errorBehavior at workflow and step level", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "flightpath-serializer-")
      );
      const workingFilePath = path.join(tempDir, "input.flightpath.json");
      const outputPath = path.join(tempDir, "saved.flightpath.json");
      const messages: any[] = [];

      try {
        await fs.writeFile(
          workingFilePath,
          JSON.stringify(
            {
              workflowName: "serializer-test",
              startedAt: Date.now(),
              errorBehavior: {
                onError: "retry",
                maxRetries: 2,
                retryDelayMs: 2500,
              },
              steps: [
                {
                  prompt: "Step one",
                  errorBehavior: { onError: "continue" },
                  _runtime: { startedAt: 1 },
                },
              ],
              _runtime: { currentIndex: 0, executionState: "idle" },
            },
            null,
            2
          ),
          "utf8"
        );

        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
            }) as any,
          () => undefined
        );

        await serializer.handleSaveWorkflow(outputPath, "json");

        const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
        assert.deepStrictEqual(saved.errorBehavior, {
          onError: "retry",
          maxRetries: 2,
          retryDelayMs: 2500,
        });
        assert.deepStrictEqual(saved.steps[0].errorBehavior, {
          onError: "continue",
        });
        assert.strictEqual(saved.steps[0]._runtime, undefined);
        assert.ok(
          messages.some((message) => message.type === MESSAGE_TYPES.WORKFLOW_SAVED)
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
