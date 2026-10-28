import { defineConfig } from "vitepress";
import { LAUNCHED, SITE_URL } from "../../landing/src/config.ts";

const base = process.env.DOCS_BASE ?? "/docs/";

// Root-relative links get the docs `base` prepended, so links to the landing
// site must be absolute. `_self` keeps them in the same tab, and `noIcon`
// drops the external-link arrow, since they are the same site.
const PRICING_LINK = {
  text: "Pricing",
  link: `${SITE_URL}/pricing/`,
  target: "_self",
  noIcon: true,
} as const;
const SOCIAL_PREVIEW_URL = `${SITE_URL}/assets/social-preview.png`;

export default defineConfig({
  title: "ctrlyoke",
  description: "One workflow engine for every CLI coding agent.",
  base,
  cleanUrls: true,
  // Hand-written sections that scripts/generate-schema-docs.mjs inlines into
  // the generated reference pages; they are not pages of their own.
  srcExclude: ["reference/_partials/**"],
  markdown: {
    config(md) {
      // VitePress opens every absolute markdown link in a new tab. Links to the
      // landing site are the same site, so they open in place; VitePress keeps a
      // `target` that is already set.
      md.core.ruler.after("inline", "ctrlyoke_same_site_links", (state) => {
        for (const token of state.tokens) {
          for (const child of token.children ?? []) {
            if (
              child.type === "link_open" &&
              child.attrGet("href")?.startsWith(`${SITE_URL}/`) &&
              child.attrIndex("target") < 0
            ) {
              child.attrSet("target", "_self");
            }
          }
        }
      });
    },
  },
  lastUpdated: true,
  // Same pre-launch switch as the landing pages, which the docs are merged into.
  sitemap: {
    hostname: `${SITE_URL}/docs/`,
  },
  head: [
    ...(LAUNCHED ? [] : [["meta", { name: "robots", content: "noindex" }]]),
    ["meta", { property: "og:site_name", content: "ctrlyoke" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:image", content: SOCIAL_PREVIEW_URL }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: SOCIAL_PREVIEW_URL }],
  ],
  themeConfig: {
    logo: "/ctrlyoke-icon.svg",
    // The logo returns to the landing page; Guide and each sidebar's Overview
    // lead back into the docs.
    logoLink: { link: `${SITE_URL}/`, target: "_self" },
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Harnesses", link: "/harnesses/" },
      { text: "Workflows", link: "/workflows/" },
      { text: "Reference", link: "/reference/workflow-schema" },
      { text: "CLI", link: "/cli/" },
      { text: "Pro", link: "/pro/" },
      PRICING_LINK,
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
            { text: "The prompt editor", link: "/guide/prompt-editor" },
            { text: "The output pane", link: "/guide/output" },
            { text: "The terminal", link: "/guide/terminal" },
            { text: "File changes and undo", link: "/guide/file-changes" },
            { text: "Dry Run", link: "/guide/dry-run" },
            { text: "Run history and search", link: "/guide/history" },
            { text: "Notifications", link: "/guide/notifications" },
            {
              text: "Screen readers and dictation",
              link: "/guide/accessibility",
            },
            { text: "Usage and stats", link: "/guide/usage-and-stats" },
            { text: "Commit messages", link: "/guide/commit-messages" },
            { text: "Settings", link: "/guide/settings" },
            { text: "Browser dashboard", link: "/guide/remote-dashboard" },
            { text: "Workspace viewer", link: "/guide/workspace-viewer" },
            { text: "Source control", link: "/guide/source-control" },
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
            { text: "Permissions", link: "/workflows/permissions" },
            { text: "MCP servers", link: "/workflows/mcp-servers" },
            { text: "Hooks", link: "/workflows/hooks" },
            { text: "Worktrees", link: "/workflows/worktrees" },
            { text: "Dynamic workflows", link: "/workflows/dynamic-workflows" },
            { text: "Coordination", link: "/workflows/coordination" },
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
            PRICING_LINK,
            { text: "Overview & activation", link: "/pro/" },
            { text: "Use ctrlyoke on your phone", link: "/pro/mobile-setup" },
            { text: "Connect from anywhere", link: "/pro/remote-access" },
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
