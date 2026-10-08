import {
  LANGUAGE_SERVER_INSTALL_KINDS,
  type LanguageServerInstallKind,
} from "../../types/DashboardConstants";

export interface LanguageServerNpmInstallRecipe {
  kind: typeof LANGUAGE_SERVER_INSTALL_KINDS.NPM;
  packages: string[];
  bin: string;
}

export interface LanguageServerCommandInstallRecipe {
  kind: typeof LANGUAGE_SERVER_INSTALL_KINDS.COMMAND;
  commands: Partial<Record<"win32" | "darwin" | "linux", string>>;
}

export type LanguageServerInstallRecipe =
  LanguageServerNpmInstallRecipe | LanguageServerCommandInstallRecipe;

export interface LanguageServerCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  homepage: string;
  /** SPDX expression. */
  license: string;
  masonName: string;
  /** Executable followed by its LSP launch arguments. */
  command: string[];
  languages: string[];
  extensions: string[];
  /** Exact extension-to-LSP-language pairing for native harness exports. */
  extensionToLanguage?: Record<string, string>;
  rootMarkers: string[];
  /** Opens one project anchor after startup for servers that need a loaded project. */
  warmup?: { anchorExtensions: string[]; configMarkers: string[] };
  install: LanguageServerInstallRecipe;
}

const npmInstall = (
  packages: string[],
  bin: string
): LanguageServerNpmInstallRecipe => ({
  kind: LANGUAGE_SERVER_INSTALL_KINDS.NPM,
  packages,
  bin,
});

const commandInstall = (
  commands: LanguageServerCommandInstallRecipe["commands"]
): LanguageServerCommandInstallRecipe => ({
  kind: LANGUAGE_SERVER_INSTALL_KINDS.COMMAND,
  commands,
});

/**
 * Curated built-ins in preference order. Launch commands and arguments are
 * checked against Helix's languages.toml and the upstream server docs.
 * https://github.com/helix-editor/helix/blob/master/languages.toml
 */
export const LANGUAGE_SERVER_CATALOG: readonly LanguageServerCatalogEntry[] = [
  {
    id: "typescript-language-server",
    displayName: "TypeScript Language Server",
    description: "TypeScript and JavaScript language intelligence.",
    homepage:
      "https://github.com/typescript-language-server/typescript-language-server",
    license: "MIT",
    masonName: "typescript-language-server",
    command: ["typescript-language-server", "--stdio"],
    languages: [
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
    ],
    extensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
    extensionToLanguage: {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      mts: "typescript",
      cts: "typescript",
      mjs: "javascript",
      cjs: "javascript",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    warmup: {
      anchorExtensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
      configMarkers: ["tsconfig.json", "jsconfig.json"],
    },
    install: npmInstall(
      ["typescript-language-server", "typescript"],
      "typescript-language-server"
    ),
  },
  {
    id: "vtsls",
    displayName: "vtsls",
    description: "TypeScript and JavaScript language server built on tsserver.",
    homepage: "https://github.com/yioneko/vtsls",
    license: "MIT",
    masonName: "vtsls",
    command: ["vtsls", "--stdio"],
    languages: [
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
    ],
    extensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
    extensionToLanguage: {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      mts: "typescript",
      cts: "typescript",
      mjs: "javascript",
      cjs: "javascript",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    warmup: {
      anchorExtensions: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
      configMarkers: ["tsconfig.json", "jsconfig.json"],
    },
    install: npmInstall(["@vtsls/language-server", "typescript"], "vtsls"),
  },
  {
    id: "pyright",
    displayName: "Pyright",
    description: "Static type checking and language features for Python.",
    homepage: "https://github.com/microsoft/pyright",
    license: "MIT",
    masonName: "pyright",
    command: ["pyright-langserver", "--stdio"],
    languages: ["python"],
    extensions: ["py", "pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
    install: npmInstall(["pyright"], "pyright-langserver"),
  },
  {
    id: "vscode-json-language-server",
    displayName: "JSON Language Server",
    description: "JSON and JSON with comments validation and editing.",
    homepage:
      "https://github.com/microsoft/vscode/tree/main/extensions/json-language-features/server",
    license: "MIT",
    masonName: "json-lsp",
    command: ["vscode-json-language-server", "--stdio"],
    languages: ["json", "jsonc"],
    extensions: ["json", "jsonc", "json5"],
    extensionToLanguage: { json: "json", jsonc: "jsonc", json5: "json" },
    rootMarkers: ["package.json", ".git"],
    install: npmInstall(
      ["vscode-langservers-extracted"],
      "vscode-json-language-server"
    ),
  },
  {
    id: "vscode-css-language-server",
    displayName: "CSS Language Server",
    description: "CSS, SCSS, and Less language features.",
    homepage:
      "https://github.com/microsoft/vscode/tree/main/extensions/css-language-features/server",
    license: "MIT",
    masonName: "css-lsp",
    command: ["vscode-css-language-server", "--stdio"],
    languages: ["css", "scss", "less"],
    extensions: ["css", "scss", "less"],
    extensionToLanguage: { css: "css", scss: "scss", less: "less" },
    rootMarkers: ["package.json", ".git"],
    install: npmInstall(
      ["vscode-langservers-extracted"],
      "vscode-css-language-server"
    ),
  },
  {
    id: "vscode-html-language-server",
    displayName: "HTML Language Server",
    description: "HTML editing and language features.",
    homepage:
      "https://github.com/microsoft/vscode/tree/main/extensions/html-language-features/server",
    license: "MIT",
    masonName: "html-lsp",
    command: ["vscode-html-language-server", "--stdio"],
    languages: ["html"],
    extensions: ["html", "htm", "xhtml"],
    rootMarkers: ["package.json", ".git"],
    install: npmInstall(
      ["vscode-langservers-extracted"],
      "vscode-html-language-server"
    ),
  },
  {
    id: "yaml-language-server",
    displayName: "YAML Language Server",
    description: "YAML validation, completion, and navigation.",
    homepage: "https://github.com/redhat-developer/yaml-language-server",
    license: "MIT",
    masonName: "yaml-language-server",
    command: ["yaml-language-server", "--stdio"],
    languages: ["yaml"],
    extensions: ["yaml", "yml"],
    rootMarkers: [".yamllint", ".git"],
    install: npmInstall(["yaml-language-server"], "yaml-language-server"),
  },
  {
    id: "bash-language-server",
    displayName: "Bash Language Server",
    description: "Language features for Bash scripts and shell files.",
    homepage: "https://github.com/bash-lsp/bash-language-server",
    license: "MIT",
    masonName: "bash-language-server",
    command: ["bash-language-server", "start"],
    languages: ["bash", "shellscript"],
    extensions: ["sh", "bash", "zsh", "ksh"],
    extensionToLanguage: {
      sh: "shellscript",
      bash: "bash",
      zsh: "shellscript",
      ksh: "shellscript",
    },
    rootMarkers: [".bashrc", ".git"],
    install: npmInstall(["bash-language-server"], "bash-language-server"),
  },
  {
    id: "marksman",
    displayName: "Marksman",
    description: "Markdown authoring and cross-file navigation.",
    homepage: "https://github.com/artempyanykh/marksman",
    license: "MIT",
    masonName: "marksman",
    command: ["marksman", "server"],
    languages: ["markdown"],
    extensions: ["md", "markdown"],
    rootMarkers: [".marksman.toml", "_index.md", ".git"],
    install: commandInstall({
      win32: "scoop install marksman",
      darwin: "brew install marksman",
      linux: "See https://github.com/artempyanykh/marksman/releases",
    }),
  },
  {
    id: "gopls",
    displayName: "gopls",
    description: "Official Go language server.",
    homepage: "https://pkg.go.dev/golang.org/x/tools/gopls",
    license: "BSD-3-Clause",
    masonName: "gopls",
    command: ["gopls"],
    languages: ["go", "gomod", "gowork", "gotmpl"],
    extensions: ["go"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    install: commandInstall({
      win32: "go install golang.org/x/tools/gopls@latest",
      darwin: "go install golang.org/x/tools/gopls@latest",
      linux: "go install golang.org/x/tools/gopls@latest",
    }),
  },
  {
    id: "rust-analyzer",
    displayName: "rust-analyzer",
    description: "Language server for Rust.",
    homepage: "https://rust-analyzer.github.io/",
    license: "MIT OR Apache-2.0",
    masonName: "rust-analyzer",
    command: ["rust-analyzer"],
    languages: ["rust"],
    extensions: ["rs"],
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    install: commandInstall({
      win32: "rustup component add rust-analyzer",
      darwin: "rustup component add rust-analyzer",
      linux: "rustup component add rust-analyzer",
    }),
  },
  {
    id: "clangd",
    displayName: "clangd",
    description: "C and C++ language server from LLVM.",
    homepage: "https://clangd.llvm.org/",
    license: "Apache-2.0 WITH LLVM-exception",
    masonName: "clangd",
    command: ["clangd"],
    languages: ["c", "cpp", "objective-c", "objective-cpp"],
    extensions: ["c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx"],
    extensionToLanguage: {
      c: "c",
      h: "c",
      cc: "cpp",
      cpp: "cpp",
      cxx: "cpp",
      hh: "cpp",
      hpp: "cpp",
      hxx: "cpp",
    },
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".git"],
    install: commandInstall({
      win32: "winget install LLVM.LLVM",
      darwin: "brew install llvm",
      linux: "Install clangd from your distribution's LLVM packages",
    }),
  },
  {
    id: "csharp-ls",
    displayName: "C# Language Server",
    description: "C# language server built on Roslyn.",
    homepage: "https://github.com/razzmatazz/csharp-language-server",
    license: "MIT",
    masonName: "csharp-language-server",
    command: ["csharp-ls"],
    languages: ["csharp"],
    extensions: ["cs"],
    rootMarkers: ["*.sln", "*.csproj", ".git"],
    install: commandInstall({
      win32: "dotnet tool install --global csharp-ls",
      darwin: "dotnet tool install --global csharp-ls",
      linux: "dotnet tool install --global csharp-ls",
    }),
  },
  {
    id: "jdtls",
    displayName: "Eclipse JDT Language Server",
    description: "Java language server from the Eclipse JDT project.",
    homepage: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
    license: "EPL-2.0",
    masonName: "jdtls",
    command: ["jdtls"],
    languages: ["java"],
    extensions: ["java"],
    rootMarkers: ["pom.xml", "build.gradle", "settings.gradle", ".git"],
    install: commandInstall({
      win32: "scoop install jdtls",
      darwin: "brew install jdtls",
      linux: "Install Eclipse JDT Language Server from your distribution",
    }),
  },
  {
    id: "lua-language-server",
    displayName: "Lua Language Server",
    description: "Language server for Lua.",
    homepage: "https://github.com/LuaLS/lua-language-server",
    license: "MIT",
    masonName: "lua-language-server",
    command: ["lua-language-server"],
    languages: ["lua"],
    extensions: ["lua"],
    rootMarkers: [".luarc.json", ".luacheckrc", ".git"],
    install: commandInstall({
      win32: "scoop install lua-language-server",
      darwin: "brew install lua-language-server",
      linux: "Install lua-language-server from your distribution",
    }),
  },
  {
    id: "taplo",
    displayName: "Taplo",
    description: "TOML language server and formatter.",
    homepage: "https://taplo.tamasfe.dev/",
    license: "MIT OR Apache-2.0",
    masonName: "taplo",
    command: ["taplo", "lsp", "stdio"],
    languages: ["toml"],
    extensions: ["toml"],
    rootMarkers: ["Cargo.toml", "pyproject.toml", ".git"],
    install: commandInstall({
      win32: "cargo install taplo-cli --locked",
      darwin: "brew install taplo",
      linux: "cargo install taplo-cli --locked",
    }),
  },
  {
    id: "docker-language-server",
    displayName: "Docker Language Server",
    description: "Dockerfile and Compose language features.",
    homepage: "https://github.com/docker/docker-language-server",
    license: "Apache-2.0",
    masonName: "docker-language-server",
    command: ["docker-language-server", "start", "--stdio"],
    languages: ["dockerfile", "yaml"],
    extensions: ["Dockerfile", "dockerfile"],
    rootMarkers: ["Dockerfile", "compose.yaml", "docker-compose.yml", ".git"],
    install: npmInstall(["@docker/language-server"], "docker-language-server"),
  },
];

export type { LanguageServerInstallKind };
