import { defineConfig } from "vitepress";
import { LAUNCHED } from "../../landing/src/config.ts";

const base = process.env.DOCS_BASE ?? "/docs/";

export default defineConfig({
  title: "ctrlyoke",
  description: "One workflow engine for every CLI coding agent.",
  base,
  cleanUrls: true,
  // Hand-written sections that scripts/generate-schema-docs.mjs inlines into
  // the generated reference pages; they are not pages of their own.
  srcExclude: ["reference/_partials/**"],
  lastUpdated: true,
  // Same pre-launch switch as the landing pages, which the docs are merged into.
  head: LAUNCHED ? [] : [["meta", { name: "robots", content: "noindex" }]],
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
            { text: "Privacy and telemetry", link: "/guide/privacy" },
          ],
        },
        {
          text: "Using the dashboard",
          items: [
            { text: "Dashboard tour", link: "/guide/dashboard" },
            { text: "Settings", link: "/guide/settings" },
            { text: "Browser dashboard", link: "/guide/remote-dashboard" },
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
            {
              text: "Files ctrlyoke writes",
              link: "/harnesses/files-ctrlyoke-writes",
            },
          ],
        },
      ],
      "/workflows/": [
        {
          text: "Formats",
          items: [
            { text: "Overview", link: "/workflows/" },
            {
              text: "Workflow properties panel",
              link: "/workflows/properties-panel",
            },
            { text: "YAML format", link: "/workflows/yaml-format" },
            { text: "JSON format", link: "/workflows/json-format" },
            {
              text: "Prompt Markdown format",
              link: "/workflows/prompt-md-format",
            },
          ],
        },
        {
          text: "Steps",
          items: [
            { text: "Script steps", link: "/workflows/script-steps" },
            { text: "Parallel steps", link: "/workflows/parallel-steps" },
            { text: "End conditions", link: "/workflows/end-conditions" },
            { text: "Variables", link: "/workflows/variables" },
            { text: "Error handling", link: "/workflows/error-handling" },
          ],
        },
        {
          text: "Context and sessions",
          items: [
            {
              text: "Session management",
              link: "/workflows/session-management",
            },
            { text: "Context references", link: "/workflows/context-files" },
            { text: "Agents and skills", link: "/workflows/agents-and-skills" },
            { text: "Templates", link: "/workflows/templates" },
          ],
        },
        {
          text: "Integrations",
          items: [
            { text: "Secrets", link: "/workflows/secrets" },
            { text: "Worktrees", link: "/workflows/worktrees" },
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
            { text: "Run files", link: "/reference/run-files" },
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
            { text: "Standalone server", link: "/cli/server" },
            { text: "CLI in CI", link: "/cli/ci" },
            { text: "ctrlyoke-mcp", link: "/cli/ctrlyoke-mcp" },
          ],
        },
      ],
      "/pro/": [
        {
          text: "ctrlyoke Pro",
          items: [
            { text: "Overview & activation", link: "/pro/" },
            { text: "Use ctrlyoke on your phone", link: "/pro/mobile-setup" },
          ],
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
            {
              text: "Investigating a run",
              link: "/troubleshooting/investigating-a-run",
            },
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
