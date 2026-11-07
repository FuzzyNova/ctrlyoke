import * as path from "node:path";
import {
  getClaudeConfigDir,
  getCopilotHomeDir,
  getOpenCodeGlobalConfigDir,
} from "./HarnessHome";

export function getHomeLspConfigPath(): string {
  return path.join(getCopilotHomeDir(), "lsp-config.json");
}

export function getQwenWorkspaceLspConfigPath(root: string): string {
  return path.join(root, ".lsp.json");
}

export function getCopilotWorkspaceLspConfigPaths(root: string): string[] {
  return [path.join(root, ".github", "lsp.json"), path.join(root, "lsp.json")];
}

export function getOpenCodeWorkspaceLspConfigPath(root: string): string {
  return path.join(root, "opencode.json");
}

export function getOpenCodeUserLspConfigPath(): string {
  const configuredFile = process.env.OPENCODE_CONFIG?.trim();
  if (configuredFile) return configuredFile;
  const configuredDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  return configuredDir
    ? path.join(configuredDir, "opencode.json")
    : path.join(getOpenCodeGlobalConfigDir(), "opencode.json");
}

export function getCclspConfigPaths(root: string): string[] {
  const configured = process.env.CCLSP_CONFIG_PATH?.trim();
  return [
    path.join(root, "cclsp.json"),
    ...(configured
      ? [
          path.isAbsolute(configured)
            ? configured
            : path.resolve(root, configured),
        ]
      : []),
  ];
}

/** Claude Code records concrete plugin install directories in this manifest. */
export function getClaudeInstalledPluginsManifestPath(): string {
  return path.join(getClaudeConfigDir(), "plugins", "installed_plugins.json");
}
