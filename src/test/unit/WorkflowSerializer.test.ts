import * as assert from "assert";
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
});
