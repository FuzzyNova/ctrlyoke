import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CommunityTemplateClient,
  CommunityTemplateError,
  getCommunityTemplateFormat,
  parseCommunityTemplateIndex,
} from "../../utils/CommunityTemplateClient";
import {
  CommunityTemplateService,
  type CommunityTemplateInstaller,
} from "../../ui/CommunityTemplateService";
import { createDashboardClientContext } from "../../ui/DashboardClientContext";
import {
  COMMUNITY_TEMPLATES,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  WORKFLOW_FILE_FORMATS,
  type WorkflowFileFormat,
} from "../../types/DashboardConstants";
import type { SettingWriteScope } from "../../types/WebviewMessageTypes";

const BASE_URL = "https://example.test/library";

function index(templates: unknown[], schemaVersion: unknown = 1) {
  return { schemaVersion, templates };
}

const REVIEW_ENTRY = {
  id: "octocat-review-branch",
  name: "Review Branch",
  description: "Review the current branch",
  author: "octocat",
  tags: ["review"],
  file: "octocat-review-branch.ctrlyoke.yaml",
};

/** A fetch stub serving fixed bodies by URL and recording every request. */
function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, requested };
}

suite("CommunityTemplateClient", () => {
  suite("parseCommunityTemplateIndex", () => {
    test("keeps valid entries, sanitizes text, and sorts by name", () => {
      const entries = parseCommunityTemplateIndex(
        index([
          REVIEW_ENTRY,
          {
            id: "alice-fix-tests",
            name: "Fix\u001b[31m Tests\n",
            description: "Loop\runtil green",
            tags: ["testing", 7, ""],
            file: "alice-fix-tests.ctrlyoke.json",
          },
        ])
      );
      assert.deepStrictEqual(entries, [
        {
          id: "alice-fix-tests",
          name: "Fix Tests",
          description: "Loop until green",
          tags: ["testing"],
          file: "alice-fix-tests.ctrlyoke.json",
        },
        REVIEW_ENTRY,
      ]);
    });

    test("skips entries whose id or file could escape the templates folder", () => {
      const entries = parseCommunityTemplateIndex(
        index([
          { ...REVIEW_ENTRY, id: "../evil", file: "../evil.ctrlyoke.yaml" },
          { ...REVIEW_ENTRY, id: "a", file: "b.ctrlyoke.yaml" },
          { ...REVIEW_ENTRY, file: "octocat-review-branch.sh" },
          { ...REVIEW_ENTRY, id: "Upper", file: "Upper.ctrlyoke.yaml" },
          REVIEW_ENTRY,
          { ...REVIEW_ENTRY, name: "Duplicate" },
        ])
      );
      assert.deepStrictEqual(
        entries.map((entry) => entry.name),
        ["Review Branch"]
      );
    });

    test("refuses an unknown index format instead of guessing", () => {
      assert.throws(
        () => parseCommunityTemplateIndex(index([REVIEW_ENTRY], 2)),
        /format 2/
      );
      assert.throws(
        () => parseCommunityTemplateIndex({ templates: "nope" }),
        CommunityTemplateError
      );
    });

    test("maps file extensions to formats", () => {
      assert.strictEqual(
        getCommunityTemplateFormat("a-b", "a-b.ctrlyoke.yml"),
        WORKFLOW_FILE_FORMATS.YAML
      );
      assert.strictEqual(
        getCommunityTemplateFormat("a-b", "a-b.ctrlyoke.json"),
        WORKFLOW_FILE_FORMATS.JSON
      );
      assert.strictEqual(
        getCommunityTemplateFormat("a-b", "c.ctrlyoke.json"),
        undefined
      );
    });
  });

  test("downloads the index and a template from the base URL", async () => {
    const { fetchFn, requested } = fakeFetch({
      [`${BASE_URL}/${COMMUNITY_TEMPLATES.indexFile}`]: {
        body: JSON.stringify(index([REVIEW_ENTRY])),
      },
      [`${BASE_URL}/templates/${REVIEW_ENTRY.file}`]: { body: "steps: []\n" },
    });
    const client = new CommunityTemplateClient({
      fetch: fetchFn,
      baseUrl: `${BASE_URL}/`,
    });

    assert.deepStrictEqual(await client.fetchIndex(), [REVIEW_ENTRY]);
    assert.strictEqual(await client.fetchTemplate(REVIEW_ENTRY), "steps: []\n");
    assert.deepStrictEqual(requested, [
      `${BASE_URL}/index.json`,
      `${BASE_URL}/templates/${REVIEW_ENTRY.file}`,
    ]);
  });

  test("reports a missing index and an oversized template", async () => {
    const { fetchFn } = fakeFetch({
      [`${BASE_URL}/templates/${REVIEW_ENTRY.file}`]: {
        body: "x".repeat(300 * 1024),
      },
    });
    const client = new CommunityTemplateClient({
      fetch: fetchFn,
      baseUrl: BASE_URL,
    });
    await assert.rejects(client.fetchIndex(), /not found \(HTTP 404\)/);
    await assert.rejects(client.fetchTemplate(REVIEW_ENTRY), /larger than/);
  });
});

suite("CommunityTemplateService", () => {
  function setup(routes: Record<string, { status?: number; body: string }>) {
    const { fetchFn, requested } = fakeFetch(routes);
    const posted: any[] = [];
    const installs: Array<{
      name: string;
      scope: SettingWriteScope;
      format: WorkflowFileFormat;
      content: string;
    }> = [];
    const uninstalls: Array<{ name: string; scope: SettingWriteScope }> = [];
    const cleared: string[] = [];
    let refreshes = 0;
    let uninstallError: Error | undefined;
    const installer: CommunityTemplateInstaller = {
      installTemplateContent: async (name, scope, format, content) => {
        installs.push({ name, scope, format, content });
        return { path: `/t/${name}`, templateId: `custom:${scope}:${name}` };
      },
      uninstallTemplate: async (name, scope) => {
        if (uninstallError) throw uninstallError;
        uninstalls.push({ name, scope });
        return `/t/${name}`;
      },
      clearSavedValues: async (templateId) => {
        cleared.push(templateId);
      },
      refreshTemplateCatalog: async () => {
        refreshes++;
      },
    };
    const service = new CommunityTemplateService(
      installer,
      new CommunityTemplateClient({ fetch: fetchFn, baseUrl: BASE_URL })
    );
    const ctx = createDashboardClientContext("test-client", (message) => {
      posted.push(message);
    });
    return {
      service,
      ctx,
      posted,
      installs,
      uninstalls,
      cleared,
      requested,
      refreshes: () => refreshes,
      failUninstall: (error: Error) => {
        uninstallError = error;
      },
    };
  }

  const routes = {
    [`${BASE_URL}/index.json`]: { body: JSON.stringify(index([REVIEW_ENTRY])) },
    [`${BASE_URL}/templates/${REVIEW_ENTRY.file}`]: { body: "content" },
  };

  test("answers index requests from the session cache until refreshed", async () => {
    const { service, ctx, posted, requested } = setup(routes);
    const request = { type: MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX };

    await service.handleRequestIndex(ctx, request);
    await service.handleRequestIndex(ctx, request);
    await service.handleRequestIndex(ctx, { ...request, refresh: true });

    assert.strictEqual(
      requested.filter((url) => url.endsWith("index.json")).length,
      2
    );
    assert.deepStrictEqual(posted[0], {
      type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INDEX_RESULT,
      templates: [REVIEW_ENTRY],
    });
  });

  test("reports an index failure and retries on the next request", async () => {
    const { service, ctx, posted, requested } = setup({});
    const request = { type: MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX };

    await service.handleRequestIndex(ctx, request);
    await service.handleRequestIndex(ctx, request);

    assert.strictEqual(requested.length, 2);
    assert.strictEqual(posted[0].templates.length, 0);
    assert.match(posted[0].error, /HTTP 404/);
  });

  test("installs an indexed template and refreshes the catalog", async () => {
    const { service, ctx, posted, installs, refreshes } = setup(routes);

    await service.handleInstall(ctx, {
      type: MESSAGE_TYPES.INSTALL_COMMUNITY_TEMPLATE,
      id: REVIEW_ENTRY.id,
      scope: SETTING_SCOPES.WORKSPACE,
    });

    assert.deepStrictEqual(installs, [
      {
        name: REVIEW_ENTRY.id,
        scope: SETTING_SCOPES.WORKSPACE,
        format: WORKFLOW_FILE_FORMATS.YAML,
        content: "content",
      },
    ]);
    assert.deepStrictEqual(posted, [
      {
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INSTALL_RESULT,
        id: REVIEW_ENTRY.id,
        scope: SETTING_SCOPES.WORKSPACE,
        success: true,
        localTemplateId: `custom:workspace:${REVIEW_ENTRY.id}`,
      },
    ]);
    assert.strictEqual(refreshes(), 1);
  });

  test("refuses to install an id the index does not list", async () => {
    const { service, ctx, posted, installs, requested } = setup(routes);

    await service.handleInstall(ctx, {
      type: MESSAGE_TYPES.INSTALL_COMMUNITY_TEMPLATE,
      id: "someone-else",
      scope: SETTING_SCOPES.USER,
    });

    assert.strictEqual(installs.length, 0);
    assert.ok(!requested.some((url) => url.includes("/templates/")));
    assert.strictEqual(posted[0].success, false);
    assert.match(posted[0].error, /not in the community template index/);
  });

  test("uninstalls from one scope without touching the network or saved values", async () => {
    const { service, ctx, posted, uninstalls, cleared, requested, refreshes } =
      setup(routes);

    await service.handleUninstall(ctx, {
      type: MESSAGE_TYPES.UNINSTALL_COMMUNITY_TEMPLATE,
      id: REVIEW_ENTRY.id,
      scope: SETTING_SCOPES.USER,
      clearSavedValues: false,
    });

    assert.deepStrictEqual(uninstalls, [
      { name: REVIEW_ENTRY.id, scope: SETTING_SCOPES.USER },
    ]);
    assert.deepStrictEqual(cleared, []);
    assert.deepStrictEqual(requested, []);
    assert.deepStrictEqual(posted, [
      {
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_UNINSTALL_RESULT,
        id: REVIEW_ENTRY.id,
        scope: SETTING_SCOPES.USER,
        success: true,
      },
    ]);
    assert.strictEqual(refreshes(), 1);
  });

  test("clears the uninstalled template's saved values when asked", async () => {
    const { service, ctx, cleared } = setup(routes);

    await service.handleUninstall(ctx, {
      type: MESSAGE_TYPES.UNINSTALL_COMMUNITY_TEMPLATE,
      id: REVIEW_ENTRY.id,
      scope: SETTING_SCOPES.WORKSPACE,
      clearSavedValues: true,
    });

    assert.deepStrictEqual(cleared, [`custom:workspace:${REVIEW_ENTRY.id}`]);
  });

  test("reports a failed uninstall and keeps the saved values", async () => {
    const { service, ctx, posted, cleared, refreshes, failUninstall } =
      setup(routes);
    failUninstall(new Error("Template is not installed: x"));

    await service.handleUninstall(ctx, {
      type: MESSAGE_TYPES.UNINSTALL_COMMUNITY_TEMPLATE,
      id: REVIEW_ENTRY.id,
      scope: SETTING_SCOPES.USER,
      clearSavedValues: true,
    });

    assert.deepStrictEqual(cleared, []);
    assert.strictEqual(refreshes(), 0);
    assert.strictEqual(posted[0].success, false);
    assert.match(posted[0].error, /not installed/);
  });
});
