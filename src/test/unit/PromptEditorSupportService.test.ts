import * as assert from "assert";
import * as fs from "fs/promises";
import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import { PromptEditorSupportService } from "../../ui/PromptEditorSupportService";
import { createWebviewClientContext } from "../../ui/WebviewClientContext";
import { CliProviderUtils } from "../../core/harness/shared/CliProviderUtils";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import {
  ATOMIC_REFERENCE_KINDS,
  HARNESS_IDS,
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
  MAX_CONTENT_SIZE,
} from "../../types/DashboardConstants";
import { pathsEqual } from "../../utils/PathCasing";
import { CompletionCore } from "../../completions/CompletionCore";
import {
  symbolCompletionGolden,
  symbolCompletionGoldenResult,
} from "../fixtures/SymbolCompletionGolden";

suite("PromptEditorSupportService", () => {
  let workspaceRoot: string;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-editor-support-")
    );
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("estimates oversized excerpt token counts without reading file contents", async () => {
    const filePath = path.join(workspaceRoot, "large.log");
    await fs.writeFile(filePath, "small fixture", "utf8");
    const mutableFs = nodeFs.promises as unknown as {
      stat: typeof nodeFs.promises.stat;
      readFile: typeof nodeFs.promises.readFile;
    };
    const originalStat = mutableFs.stat;
    const originalReadFile = mutableFs.readFile;
    mutableFs.stat = (async (target: string, ...args: unknown[]) => {
      if (path.resolve(String(target)) === filePath) {
        return { size: MAX_CONTENT_SIZE + 1, mtimeMs: 0 } as import("fs").Stats;
      }
      return (
        originalStat as (...values: unknown[]) => Promise<import("fs").Stats>
      )(target, ...args);
    }) as typeof fs.stat;
    mutableFs.readFile = (async (target: string, ...args: unknown[]) => {
      if (path.resolve(String(target)) === filePath)
        throw new Error("unexpected readFile");
      return (originalReadFile as (...values: unknown[]) => Promise<Buffer>)(
        target,
        ...args
      );
    }) as typeof fs.readFile;
    try {
      const emitted: unknown[] = [];
      const service = new PromptEditorSupportService(
        () => workspaceRoot,
        () => undefined,
        () => undefined
      );
      await service.handleAttachmentTokenCountRequest(
        createWebviewClientContext("test-client", (message) =>
          emitted.push(message)
        ),
        ["#selection:large.log:1-1"]
      );
      const response = emitted[0] as { counts: Record<string, number> };
      assert.ok(response.counts["#selection:large.log:1-1"] > 0);
    } finally {
      mutableFs.stat = originalStat;
      mutableFs.readFile = originalReadFile;
    }
  });

  test("reports empty prompt files with the request sequence and resolved path", async () => {
    const promptFile = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "prompts",
      "empty.prompt.md"
    );
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, " \n\t ", "utf8");

    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );
    await service.handleFileRefValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      "./.ctrlyoke/prompts/empty.prompt.md",
      42,
      { workflowKey: "test", kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT }
    );

    const validation = emitted[0] as {
      type: string;
      seq: number;
      filePath: string;
      exists: boolean;
      isEmpty: boolean;
      resolvedPath: string;
    };
    assert.strictEqual(validation.type, MESSAGE_TYPES.FILE_REF_VALIDATION);
    assert.strictEqual(validation.seq, 42);
    assert.strictEqual(
      validation.filePath,
      "./.ctrlyoke/prompts/empty.prompt.md"
    );
    assert.strictEqual(validation.exists, true);
    assert.strictEqual(validation.isEmpty, true);
    assert.ok(
      pathsEqual(validation.resolvedPath, promptFile),
      `expected ${validation.resolvedPath} to resolve to ${promptFile}`
    );
  });

  test("returns current editor selections in the panel's partial # response", async () => {
    const core = new CompletionCore({
      getFiles: async () => [],
      isMultiRoot: () => false,
      symbols: {
        workspaceSymbols: async () => [symbolCompletionGolden],
        documentSymbols: async () => [symbolCompletionGolden],
      },
      editorContext: {
        getSelections: () => [
          {
            viewerPath: "src/Widget.ts",
            startLine: 4,
            endLine: 8,
            text: "class Widget {}",
            isOutput: false,
          },
        ],
        getVisibleOutputChannels: () => [],
      },
    });
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined,
      undefined,
      undefined,
      () => [],
      () => [],
      undefined,
      core
    );
    const responses: Array<{
      partial: boolean;
      items: Array<{ insertText: string }>;
    }> = [];
    await service.handleCompletionRequest(
      createWebviewClientContext("test-client", (message) => {
        if (message.type === MESSAGE_TYPES.COMPLETIONS_RESPONSE)
          responses.push(message as (typeof responses)[number]);
      }),
      "#",
      "#",
      1,
      7
    );
    assert.strictEqual(responses[0]?.partial, true);
    assert.strictEqual(
      responses[0]?.items[0]?.insertText,
      "selection:src/Widget.ts:4-8"
    );
    assert.strictEqual(responses[1]?.partial, false);
  });

  test("reports zero-byte prompt files as empty too", async () => {
    const promptFile = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "prompts",
      "zero.prompt.md"
    );
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, "", "utf8");

    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );
    await service.handleFileRefValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      "./.ctrlyoke/prompts/zero.prompt.md",
      43
    );

    assert.strictEqual((emitted[0] as { exists: boolean }).exists, true);
    assert.strictEqual((emitted[0] as { isEmpty: boolean }).isEmpty, true);
    assert.strictEqual((emitted[0] as { seq: number }).seq, 43);
  });

  test("validates relocated workflow-relative context references", async () => {
    const workflowPath = path.join(
      workspaceRoot,
      "bundles",
      "workflow.ctrlyoke.yaml"
    );
    const assetPath = path.join(
      workspaceRoot,
      "bundles",
      "workflow.assets",
      "shot.png"
    );
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.writeFile(assetPath, "asset", "utf8");

    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () =>
        ({
          getViewSourceDefinitionPath: async () => workflowPath,
        }) as any,
      () => undefined
    );

    await service.handleContextRefsValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      [{ id: "asset", type: "file", path: "./workflow.assets/shot.png" }]
    );

    const result = emitted[0] as {
      results: Array<{ exists: boolean; message?: string }>;
    };
    assert.deepStrictEqual(result.results, [{ id: "asset", exists: true }]);
  });

  test("resolves #sym: kinds for the dashboard but not when the caller opts out", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "Widget.ts"),
      "\n".repeat(20),
      "utf8"
    );
    let symbolQueries = 0;
    const core = new CompletionCore({
      getFiles: async () => [],
      isMultiRoot: () => false,
      symbols: {
        workspaceSymbols: async () => {
          symbolQueries++;
          return [symbolCompletionGolden];
        },
        documentSymbols: async () => {
          symbolQueries++;
          return [symbolCompletionGolden];
        },
      },
    });
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined,
      undefined,
      undefined,
      () => [],
      () => [],
      undefined,
      core
    );
    const reference = {
      id: "sym",
      type: ATOMIC_REFERENCE_KINDS.SYMBOL,
      path: "src/Widget.ts",
      symbolName: "Widget",
      lineStart: "4",
      lineEnd: "18",
    };

    assert.deepStrictEqual(
      await service.validateContextReferences(
        [{ ...reference, from: 0, to: 1 }],
        undefined,
        { resolveSymbolKind: false }
      ),
      [{ id: "sym", exists: true }]
    );
    assert.strictEqual(symbolQueries, 0, "no symbol provider was queried");

    const emitted: Array<{ results: Array<{ symbolKind?: number }> }> = [];
    await service.handleContextRefsValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message as (typeof emitted)[number]);
      }),
      [reference]
    );
    assert.strictEqual(
      emitted[0]?.results[0]?.symbolKind,
      symbolCompletionGoldenResult.completionKind
    );
    assert.ok(symbolQueries > 0);
  });

  test("explains when a relative context reference has no workflow location", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );

    await service.handleContextRefsValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      [{ id: "asset", type: "file", path: "./workflow.assets/shot.png" }]
    );

    const result = emitted[0] as {
      results: Array<{ exists: boolean; message?: string }>;
    };
    assert.strictEqual(result.results[0].exists, false);
    assert.match(
      result.results[0].message ?? "",
      /relative to the workflow file, which has no known location/i
    );
  });

  test("guides old workspace run-history refs to path-independent priorContext", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );

    await service.handleContextRefsValidation(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      [
        {
          id: "old-run",
          type: "file",
          path: "@.ctrlyoke/.runs/workflow/run/manifest.json",
        },
      ]
    );

    const result = emitted[0] as {
      results: Array<{ exists: boolean; message?: string }>;
    };
    assert.strictEqual(result.results[0].exists, false);
    assert.match(result.results[0].message ?? "", /priorContext/);
    assert.match(
      result.results[0].message ?? "",
      /priorContext: \{ workflow, run \}/
    );
  });

  test("emits script completions through the requesting client context", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );

    await service.handleScriptCompletionRequest(
      createWebviewClientContext("browser:1", (message) => {
        emitted.push(message);
      }),
      "git st",
      6,
      101
    );

    const response = emitted[0] as {
      type: string;
      items: Array<{ insertText: string }>;
      from: number;
      seq: number;
    };
    assert.strictEqual(
      response.type,
      MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE
    );
    assert.strictEqual(response.from, 0);
    assert.strictEqual(response.seq, 101);
    assert.ok(response.items.some((item) => item.insertText === "git status"));
  });

  test("emits empty script items when the completion source fails", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => {
        throw new Error("workspace lookup failed");
      },
      () => undefined,
      () => undefined
    );
    await service.handleScriptCompletionRequest(
      createWebviewClientContext("test-client", (message) => {
        emitted.push(message);
      }),
      "npm ",
      4,
      102
    );

    const response = emitted[0] as {
      type: string;
      items: unknown[];
      from: number;
      seq: number;
    };
    assert.strictEqual(
      response.type,
      MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE
    );
    assert.deepStrictEqual(response.items, []);
    assert.strictEqual(response.from, 4);
    assert.strictEqual(response.seq, 102);
  });

  test("emits harness flag completions from the selected CLI help output", async () => {
    const emitted: unknown[] = [];
    const originalRunHelpCommand = CliProviderUtils.runHelpCommand;
    let requestedCommand: string | undefined;
    CliProviderUtils.runHelpCommand = async (command) => {
      requestedCommand = command;
      return [
        "Options:",
        "  --reasoning-effort <level>  Select reasoning effort",
        "  --model <model>  Model to use",
      ].join("\n");
    };

    try {
      const service = new PromptEditorSupportService(
        () => workspaceRoot,
        () => undefined,
        () => undefined
      );
      await service.handleHarnessFlagCompletionRequest(
        createWebviewClientContext("browser:1", (message) => {
          emitted.push(message);
        }),
        HARNESS_IDS.COPILOT_CLI,
        "--",
        2,
        201
      );
    } finally {
      CliProviderUtils.runHelpCommand = originalRunHelpCommand;
    }

    const response = emitted[0] as {
      type: string;
      items: Array<{ flag: string }>;
      from: number;
      seq: number;
    };
    assert.strictEqual(requestedCommand, CopilotCliProvider.CLI_HELP_COMMAND);
    assert.strictEqual(
      response.type,
      MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_RESPONSE
    );
    assert.deepStrictEqual(
      response.items.map((item) => item.flag),
      ["--reasoning-effort", "--model"]
    );
    assert.strictEqual(response.from, 0);
    assert.strictEqual(response.seq, 201);
  });

  test("emits empty harness flag items when the help command fails", async () => {
    const emitted: unknown[] = [];
    const originalRunHelpCommand = CliProviderUtils.runHelpCommand;
    CliProviderUtils.runHelpCommand = async () => {
      throw new Error("CLI not installed");
    };

    try {
      const service = new PromptEditorSupportService(
        () => workspaceRoot,
        () => undefined,
        () => undefined
      );
      await service.handleHarnessFlagCompletionRequest(
        createWebviewClientContext("test-client", (message) => {
          emitted.push(message);
        }),
        HARNESS_IDS.COPILOT_CLI,
        "--rea",
        5,
        202
      );
    } finally {
      CliProviderUtils.runHelpCommand = originalRunHelpCommand;
    }

    const response = emitted[0] as {
      type: string;
      items: unknown[];
      from: number;
      seq: number;
    };
    assert.strictEqual(
      response.type,
      MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_RESPONSE
    );
    assert.deepStrictEqual(response.items, []);
    assert.strictEqual(response.from, 0);
    assert.strictEqual(response.seq, 202);
  });

  test("filters harness flags by the token containing the cursor", async () => {
    const emitted: unknown[] = [];
    const originalRunHelpCommand = CliProviderUtils.runHelpCommand;
    CliProviderUtils.runHelpCommand = async () =>
      [
        "Options:",
        "  --model <model>  Model to use",
        "  --reasoning-effort <level>  Select reasoning effort",
        "  --safe-mode  Safe mode",
      ].join("\n");

    const text = "--model value --rea";
    try {
      const service = new PromptEditorSupportService(
        () => workspaceRoot,
        () => undefined,
        () => undefined
      );
      await service.handleHarnessFlagCompletionRequest(
        createWebviewClientContext("test-client", (message) => {
          emitted.push(message);
        }),
        HARNESS_IDS.COPILOT_CLI,
        text,
        text.length,
        203
      );
    } finally {
      CliProviderUtils.runHelpCommand = originalRunHelpCommand;
    }

    const response = emitted[0] as {
      items: Array<{ flag: string }>;
      from: number;
      seq: number;
    };
    assert.deepStrictEqual(
      response.items.map((item) => item.flag),
      ["--reasoning-effort"]
    );
    assert.strictEqual(response.from, 14);
    assert.strictEqual(response.seq, 203);
  });

  test("emits branch completions through the requesting client context", async () => {
    const emitted: unknown[] = [];
    const service = new PromptEditorSupportService(
      () => workspaceRoot,
      () => undefined,
      () => undefined
    );

    await service.handleBranchListRequest(
      createWebviewClientContext("browser:1", (message) => {
        emitted.push(message);
      }),
      "feat/",
      103
    );

    const response = emitted[0] as {
      type: string;
      items: unknown[];
      seq: number;
    };
    assert.strictEqual(response.type, MESSAGE_TYPES.BRANCH_LIST_RESPONSE);
    assert.deepStrictEqual(response.items, []);
    assert.strictEqual(response.seq, 103);
  });
});
