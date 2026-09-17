import { defineConfig } from "vitepress";

const base = process.env.DOCS_BASE ?? "/docs/";

export default defineConfig({
  title: "ctrlyoke",
  description: "AI workflow automation for VS Code and the command line.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: "/ctrlyoke-icon.svg",
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Harnesses", link: "/harnesses/" },
      { text: "Workflows", link: "/workflows/" },
      { text: "Reference", link: "/reference/workflow-schema" },
      { text: "CLI", link: "/cli/" },
      { text: "Pro", link: "/pro/" },
      { text: "GitHub", link: "https://github.com/FuzzyNova/ctrlyoke" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick start", link: "/guide/quick-start" },
            { text: "Core concepts", link: "/guide/concepts" },
            { text: "Your first workflow", link: "/guide/your-first-workflow" },
          ],
        },
      ],
      "/harnesses/": [
        {
          text: "Harnesses",
          items: [
            { text: "Overview", link: "/harnesses/" },
            {
              text: "Compatibility matrix",
              link: "/harnesses/compatibility",
            },
            { text: "Copilot CLI", link: "/harnesses/copilot-cli" },
            { text: "Claude CLI", link: "/harnesses/claude-cli" },
            { text: "Codex CLI", link: "/harnesses/codex-cli" },
            { text: "OpenCode CLI", link: "/harnesses/opencode-cli" },
            { text: "Qwen CLI", link: "/harnesses/qwen-cli" },
            { text: "Antigravity CLI", link: "/harnesses/antigravity-cli" },
          ],
        },
      ],
      "/workflows/": [
        {
          text: "Writing workflows",
          items: [
            { text: "Overview", link: "/workflows/" },
            { text: "YAML format", link: "/workflows/yaml-format" },
            { text: "JSON format", link: "/workflows/json-format" },
            {
              text: "Prompt Markdown format",
              link: "/workflows/prompt-md-format",
            },
            {
              text: "Session management",
              link: "/workflows/session-management",
            },
            { text: "Context references", link: "/workflows/context-files" },
            { text: "Agents and skills", link: "/workflows/agents-and-skills" },
            { text: "Templates", link: "/workflows/templates" },
            { text: "End conditions", link: "/workflows/end-conditions" },
            { text: "Dynamic queue", link: "/workflows/dynamic-queue" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Workflow schema", link: "/reference/workflow-schema" },
            { text: "Settings", link: "/reference/settings" },
            { text: "Commands", link: "/reference/commands" },
            { text: "MCP tools", link: "/reference/mcp-tools" },
          ],
        },
      ],
      "/cli/": [
        {
          text: "CLI",
          items: [
            { text: "Overview", link: "/cli/" },
            { text: "ctrlyoke", link: "/cli/ctrlyoke" },
            { text: "ctrlyoke-mcp", link: "/cli/ctrlyoke-mcp" },
          ],
        },
      ],
      "/pro/": [
        {
          text: "ctrlyoke Pro",
          items: [{ text: "Overview & activation", link: "/pro/" }],
        },
      ],
      "/examples/": [
        {
          text: "Examples",
          items: [{ text: "Workflow examples", link: "/examples/" }],
        },
      ],
      "/troubleshooting/": [
        {
          text: "Troubleshooting",
          items: [
            { text: "Overview", link: "/troubleshooting/" },
            { text: "Common errors", link: "/troubleshooting/common-errors" },
            { text: "FAQ", link: "/troubleshooting/faq" },
          ],
        },
      ],
    },
    search: {
      provider: "local",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/FuzzyNova/ctrlyoke" },
    ],
    editLink: {
      pattern: "https://github.com/FuzzyNova/ctrlyoke/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Source-available under the ctrlyoke Commercial License.",
      copyright: "Copyright © Fuzzy Nova LLC",
    },
  },
});
