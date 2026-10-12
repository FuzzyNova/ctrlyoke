import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { SCHEMA_DESCRIPTIONS } from "@root/types/generated/SchemaDescriptions";
import {
  HARNESS_IDS,
  STATUS_LINE_HARNESS_IDS,
} from "@root/types/DashboardConstants";
import { ALL_TABS } from "@components/settings/settingsTabs";
import {
  SETTINGS_CATALOG,
  SETTINGS_CATALOG_ENTRIES,
  type SettingsCatalogKey,
} from "@components/settings/settingsCatalog";
import { SettingInputRow } from "@components/shared/SettingInputRow";
import { SettingToggleRow } from "@components/shared/SettingToggleRow";

const sources = import.meta.glob("../../../components/settings/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

const FAMILY_PARENTS = [
  "defaults.models",
  "defaults.additionalArgs",
  "ui.harnessColors.byHarness",
] as const;

interface SourceSettingKey {
  file: string;
  key: string;
  kind: "SettingInputRow" | "SettingToggleRow";
  templatePrefix?: string;
}

function sourceSettingKeys(): SourceSettingKey[] {
  const found: SourceSettingKey[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ["SettingInputRow", "SettingToggleRow"].includes(
          node.tagName.getText(sourceFile)
        )
      ) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const names = attributes.map((attribute) =>
          attribute.name.getText(sourceFile)
        );
        expect(names).toContain("settingKey");
        expect(names).not.toEqual(
          expect.arrayContaining(["label", "description", "path"])
        );

        const settingKey = attributes.find(
          (attribute) => attribute.name.getText(sourceFile) === "settingKey"
        );
        expect(settingKey?.initializer).toBeDefined();
        const initializer = settingKey!.initializer!;
        if (ts.isStringLiteral(initializer)) {
          found.push({
            file,
            key: initializer.text,
            kind: node.tagName.getText(sourceFile) as SourceSettingKey["kind"],
          });
        } else if (
          ts.isJsxExpression(initializer) &&
          initializer.expression &&
          ts.isTemplateExpression(initializer.expression)
        ) {
          const template = initializer.expression;
          found.push({
            file,
            key: template.getText(sourceFile),
            kind: node.tagName.getText(sourceFile) as SourceSettingKey["kind"],
            templatePrefix: template.head.text,
          });
        } else {
          throw new Error(`${file}: settingKey must be a string or template`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

const settingKeys = sourceSettingKeys();
const sourceKeys = new Set(settingKeys.map(({ key }) => key));
const sourceTemplates = settingKeys.flatMap(({ templatePrefix }) =>
  templatePrefix ? [templatePrefix] : []
);

describe("settings catalog drift guards", () => {
  it("places the default template and saved variable values on the Templates tab", () => {
    expect(SETTINGS_CATALOG["general.defaultTemplate"].tab).toBe("templates");
    expect(SETTINGS_CATALOG["landmark:templates.tab"].tab).toBe("templates");
    expect(SETTINGS_CATALOG["landmark:templates.savedValues"].tab).toBe(
      "templates"
    );
  });
  it("points every catalog path at a schema property, including family parents", () => {
    for (const entry of SETTINGS_CATALOG_ENTRIES) {
      if (!entry.path) continue;
      const familyParent = FAMILY_PARENTS.find((parent) =>
        entry.path!.startsWith(`${parent}.`)
      );
      const schemaPath = familyParent ?? entry.path;
      expect(
        Object.prototype.hasOwnProperty.call(SCHEMA_DESCRIPTIONS, schemaPath),
        `${entry.id} path ${schemaPath} must exist in the settings schema`
      ).toBe(true);
    }
  });

  it("keeps ids unique, tabs and pages valid, and reveal links resolvable", () => {
    const ids = SETTINGS_CATALOG_ENTRIES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);

    const tabs = new Set(ALL_TABS.map(({ id }) => id));
    for (const entry of SETTINGS_CATALOG_ENTRIES) {
      expect(tabs.has(entry.tab), `${entry.id} has a valid tab`).toBe(true);
      expect(entry.page !== undefined).toBe(entry.tab === "workflow");
      if (entry.revealedBy) {
        expect(
          SETTINGS_CATALOG_ENTRIES.find(({ id }) => id === entry.revealedBy)
            ?.path,
          `${entry.id} reveal path ${entry.revealedBy} must be catalogued`
        ).toBe(entry.revealedBy);
      }
    }
  });

  it("requires every settings row to use a catalog key and every entry to be reachable", () => {
    for (const entry of SETTINGS_CATALOG_ENTRIES) {
      if (entry.id.startsWith("landmark:")) {
        const anchored = Object.values(sources).some(
          (source) =>
            source.includes(`data-settings-search-id="${entry.id}"`) ||
            (source.includes(`data-settings-search-id={searchId}`) &&
              source.includes(`searchId = "${entry.id}"`))
        );
        expect(
          anchored,
          `${entry.id} must have an anchor (or an explicit scroll-to-top marker)`
        ).toBe(true);
        continue;
      }

      const referenced =
        sourceKeys.has(entry.id) ||
        sourceTemplates.some((prefix) => entry.id.startsWith(prefix));
      expect(
        referenced,
        `${entry.id} must be referenced by a setting row`
      ).toBe(true);
    }
  });

  it("renders referenced row ids in their catalog tab/page order", () => {
    const placementByFile: Record<string, { tab: string; page?: string }> = {
      AdvancedPermissionsSection: { tab: "permissions" },
      CommitSection: { tab: "commit" },
      CoordinationSection: { tab: "coordination" },
      DefaultsContextPage: { tab: "workflow", page: "context" },
      DefaultsHarnessPage: { tab: "workflow", page: "harness" },
      DefaultsHooksPage: { tab: "workflow", page: "hooks" },
      DefaultsMcpPage: { tab: "workflow", page: "mcp" },
      DefaultsPermissionsPage: { tab: "workflow", page: "permissions" },
      DeveloperSection: { tab: "developer" },
      ExecutionSection: { tab: "execution" },
      GeneralSection: { tab: "general" },
      HarnessesSection: { tab: "workflow", page: "harness" },
      NotificationsSection: { tab: "notifications" },
      QueueSection: { tab: "queue" },
      RunHistorySection: { tab: "general" },
      SecretsSection: { tab: "secrets" },
      ServerSection: { tab: "server" },
      StatusLineSection: { tab: "statusline" },
      StatsUsageSection: { tab: "stats" },
      StatusLineTrackingControls: { tab: "statusline" },
      TerminalControlBarEditor: { tab: "terminal" },
      TerminalSection: { tab: "terminal" },
      WorktreesSection: { tab: "worktrees" },
    };
    const catalogIndex = new Map(
      SETTINGS_CATALOG_ENTRIES.map(({ id }, index) => [id, index])
    );

    for (const [file, placement] of Object.entries(placementByFile)) {
      const rows = settingKeys.filter(({ file: rowFile }) =>
        rowFile.endsWith(`/${file}.tsx`)
      );
      if (rows.length === 0) continue;
      const renderedIds: string[] = [];
      if (file === "HarnessesSection") {
        const literalRows = rows.filter(
          ({ templatePrefix }) => !templatePrefix
        );
        for (const row of literalRows) renderedIds.push(row.key);
        const dynamicRows = rows.filter(
          (row): row is SourceSettingKey & { templatePrefix: string } =>
            row.templatePrefix !== undefined
        );
        for (const harnessId of Object.values(HARNESS_IDS)) {
          for (const row of dynamicRows) {
            const id = `${row.templatePrefix}${harnessId}`;
            if (SETTINGS_CATALOG[id as keyof typeof SETTINGS_CATALOG]) {
              renderedIds.push(id);
            }
          }
        }
      } else if (file === "StatusLineTrackingControls") {
        const dynamicRows = rows.filter(
          (row): row is SourceSettingKey & { templatePrefix: string } =>
            row.templatePrefix !== undefined
        );
        for (const harnessId of Object.values(STATUS_LINE_HARNESS_IDS)) {
          for (const row of dynamicRows) {
            const id = `${row.templatePrefix}${harnessId}`;
            if (SETTINGS_CATALOG[id as keyof typeof SETTINGS_CATALOG]) {
              renderedIds.push(id);
            }
          }
          const formatId = `statusLine.byHarness.${harnessId}.format`;
          if (SETTINGS_CATALOG[formatId as keyof typeof SETTINGS_CATALOG]) {
            renderedIds.push(formatId);
          }
        }
      } else {
        for (const row of rows) {
          const entries = row.templatePrefix
            ? SETTINGS_CATALOG_ENTRIES.filter((entry) =>
                entry.id.startsWith(row.templatePrefix!)
              )
            : [
                SETTINGS_CATALOG[row.key as keyof typeof SETTINGS_CATALOG] as
                  (typeof SETTINGS_CATALOG_ENTRIES)[number] | undefined,
              ].filter((entry) => entry !== undefined);
          expect(
            entries.length,
            `${file}: ${row.key} has catalog entries`
          ).toBeGreaterThan(0);
          for (const entry of entries) {
            expect(entry, `${file}: ${entry.id} tab/page`).toMatchObject({
              tab: placement.tab,
              ...(placement.page ? { page: placement.page } : {}),
            });
            renderedIds.push(entry.id);
          }
        }
      }

      const visibleIds = [...new Set(renderedIds)];
      const renderedRows = visibleIds.map((id) => {
        const row = rows.find(
          ({ key, templatePrefix }) =>
            key === id || (templatePrefix && id.startsWith(templatePrefix))
        );
        if (id.startsWith("statusLine.byHarness.") && id.endsWith(".format")) {
          return createElement("div", {
            key: id,
            "data-settings-search-id": id,
          });
        }
        if (row?.kind === "SettingToggleRow") {
          return createElement(SettingToggleRow, {
            key: id,
            settingKey: id as SettingsCatalogKey,
            checked: false,
            onChange: () => undefined,
          });
        }
        return createElement(SettingInputRow, {
          key: id,
          settingKey: id as SettingsCatalogKey,
          children: createElement("span"),
        });
      });
      const rendered = render(createElement("div", {}, renderedRows));
      const domIds = Array.from(
        rendered.container.querySelectorAll<HTMLElement>(
          "[data-settings-search-id]"
        )
      ).map((element) => element.getAttribute("data-settings-search-id")!);
      expect(domIds).toEqual(visibleIds);
      const positions = domIds.map((id) => catalogIndex.get(id)!);
      expect(positions, domIds.join(" → ")).toEqual(
        [...positions].sort((a, b) => a - b)
      );
    }
  });
});
