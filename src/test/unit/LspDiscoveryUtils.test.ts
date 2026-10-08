import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { safeDiscoverLocalLanguageServers } from "../../utils/LspDiscoveryUtils";
import { LSP_DISCOVERY_FORMATS } from "../../types/DashboardConstants";

suite("LspDiscoveryUtils", () => {
  let tempRoot: string;
  let workspace: string;
  let home: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalCclspPath: string | undefined;
  let originalOpenCodeConfig: string | undefined;
  let originalOpenCodeConfigDir: string | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-lsp-discovery-"));
    workspace = path.join(tempRoot, "workspace");
    home = path.join(tempRoot, "home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(home, ".copilot"), { recursive: true });
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
    await fs.mkdir(path.join(home, ".claude", "plugins"), { recursive: true });
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalCclspPath = process.env.CCLSP_CONFIG_PATH;
    originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
    originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CCLSP_CONFIG_PATH;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_DIR;
  });

  teardown(async () => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
    if (originalCclspPath === undefined) delete process.env.CCLSP_CONFIG_PATH; else process.env.CCLSP_CONFIG_PATH = originalCclspPath;
    if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
    if (originalOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("discovers Qwen, Claude plugins, Copilot, opencode, and cclsp definitions", async () => {
    const pluginDir = path.join(tempRoot, "plugin-installed-here");
    const pluginRoot = path.join(tempRoot, "plugin-root-manifest");
    await fs.mkdir(path.join(workspace, ".github"), { recursive: true });
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".lsp.json"), JSON.stringify({ qwen: { command: "qwen-lsp", args: ["--stdio"], extensionToLanguage: { ".py": "python" } } }));
    await fs.writeFile(path.join(workspace, ".github", "lsp.json"), JSON.stringify({ lspServers: { copilot: { command: "copilot-lsp", args: ["--stdio"], fileExtensions: { ".ts": "typescript" } } } }));
    await fs.writeFile(path.join(workspace, "lsp.json"), JSON.stringify({ lspServers: { copilotRoot: { command: "root-lsp", args: [], fileExtensions: { ".js": "javascript" } } } }));
    await fs.writeFile(path.join(home, ".copilot", "lsp-config.json"), JSON.stringify({ lspServers: { copilotUser: { command: "user-lsp", fileExtensions: { ".go": "go" } } } }));
    await fs.writeFile(path.join(workspace, "opencode.json"), JSON.stringify({ lsp: { rust: { command: ["rust-analyzer"], extensions: [".rs"] } } }));
    await fs.writeFile(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ lsp: { markdown: { command: ["marksman", "server"], extensions: ["md"] } } }));
    await fs.writeFile(path.join(workspace, "cclsp.json"), JSON.stringify({ servers: [{ name: "ccls", command: ["ccls"], extensions: [".cpp"] }] }));
    const customCclsp = path.join(tempRoot, "custom-cclsp.json");
    await fs.writeFile(customCclsp, JSON.stringify({ servers: [{ name: "custom", command: ["custom-lsp"], extensions: [".rs"] }] }));
    process.env.CCLSP_CONFIG_PATH = customCclsp;
    await fs.writeFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { example: [{ installPath: pluginDir }], manifest: [{ installPath: pluginRoot }] } }));
    await fs.writeFile(path.join(pluginDir, ".lsp.json"), JSON.stringify({ go: { command: "gopls", extensionToLanguage: { ".go": "go" } } }));
    await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({ lspServers: { lua: { command: "lua-ls", extensionToLanguage: { ".lua": "lua" } } } }));
    await fs.writeFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "manifest-plugin", lspServers: "./servers.json" }));
    await fs.writeFile(path.join(pluginRoot, "servers.json"), JSON.stringify({ lsp: { command: "manifest-lsp", extensionToLanguage: { ".lsp": "lsp" } } }));

    const result = await safeDiscoverLocalLanguageServers(workspace);
    assert.strictEqual(result.error, undefined);
    const ids = new Set(result.servers.map((entry) => entry.id));
    for (const id of [LSP_DISCOVERY_FORMATS.QWEN, "copilot", "copilotRoot", "copilotUser", "rust", "markdown", "ccls", "custom", "go", "lua", "lsp"]) assert.ok(ids.has(id), `expected ${id}`);
    const py = result.servers.find((entry) => entry.id === LSP_DISCOVERY_FORMATS.QWEN)!;
    assert.deepStrictEqual(py.definition.command, ["qwen-lsp", "--stdio"]);
    assert.deepStrictEqual(py.definition.extensions, ["py"]);
    assert.deepStrictEqual(py.definition.languages, ["python"]);
    assert.ok(result.servers.some((entry) => entry.id === "go" && entry.path === path.join(pluginDir, ".lsp.json")));
  });

  test("resolves a relative cclsp override under the workspace root", async () => {
    const relativePath = path.join(workspace, "config", "cclsp.json");
    await fs.mkdir(path.dirname(relativePath), { recursive: true });
    await fs.writeFile(relativePath, JSON.stringify({ servers: [{ name: "relative", command: ["relative-lsp"], extensions: ["rel"] }] }));
    process.env.CCLSP_CONFIG_PATH = path.join("config", "cclsp.json");
    const result = await safeDiscoverLocalLanguageServers(workspace);
    assert.ok(result.servers.some((entry) => entry.id === "relative" && entry.path === relativePath));
  });
});
