import { WORKSPACE_FILE_LANGUAGE_IDS } from "../types/DashboardConstants";

export const WORKSPACE_FILE_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  go: "go",
  rs: "rust",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  toml: "toml",
  ini: "ini",
  env: "properties",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  [WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE]:
    WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE,
  txt: "plaintext",
};

export function languageFromPath(filePath: string): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const basename = normalizedPath
    .slice(normalizedPath.lastIndexOf("/") + 1)
    .toLowerCase();

  if (basename === WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE) {
    return WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE;
  }
  if (basename === ".env" || basename.startsWith(".env.")) return "properties";

  const lastDot = basename.lastIndexOf(".");
  const extension = lastDot > 0 ? basename.slice(lastDot + 1) : "";
  return WORKSPACE_FILE_LANGUAGE_MAP[extension];
}
