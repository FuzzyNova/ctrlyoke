const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Build-time constants for conditional compilation
// In production: dev commands are stripped via dead code elimination
const buildDate = new Date().toISOString();
const defineConstants = {
  __DEV_MODE__: production ? "false" : "true",
  __BUILD_DATE__: JSON.stringify(buildDate),
};

console.log(
  `[build] Mode: ${production ? "PRODUCTION" : "DEVELOPMENT"}, DEV_MODE: ${!production}`
);

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location === null) {
          return;
        }
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`
        );
      });
      console.log("[watch] build finished");
    });
  },
};

/**
 * Recursively copy a directory
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 */
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    return;
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Plugin to copy template files to output directory (including subdirectories)
 * @type {import('esbuild').Plugin}
 */
const copyTemplatesPlugin = {
  name: "copy-templates",

  setup(build) {
    build.onEnd(() => {
      const srcTemplates = path.join(__dirname, "src", "templates");
      const outTemplates = path.join(__dirname, "out", "templates");

      // Create output templates directory if it doesn't exist
      if (!fs.existsSync(outTemplates)) {
        fs.mkdirSync(outTemplates, { recursive: true });
      }

      // Copy all template files and subdirectories
      if (fs.existsSync(srcTemplates)) {
        const entries = fs.readdirSync(srcTemplates, { withFileTypes: true });
        entries.forEach((entry) => {
          const srcPath = path.join(srcTemplates, entry.name);
          const outPath = path.join(outTemplates, entry.name);

          if (entry.isDirectory()) {
            copyDirRecursive(srcPath, outPath);
            console.log(
              `[copy] ${entry.name}/ -> out/templates/${entry.name}/`
            );
          } else {
            fs.copyFileSync(srcPath, outPath);
            console.log(`[copy] ${entry.name} -> out/templates/${entry.name}`);
          }
        });
      }
    });
  },
};

/**
 * Plugin to copy schema files to output directory
 * @type {import('esbuild').Plugin}
 */
const copySchemasPlugin = {
  name: "copy-schemas",

  setup(build) {
    build.onEnd(() => {
      const srcSchemas = path.join(__dirname, "schemas");
      const outSchemas = path.join(__dirname, "out", "schemas");

      // Create output schemas directory if it doesn't exist
      if (!fs.existsSync(outSchemas)) {
        fs.mkdirSync(outSchemas, { recursive: true });
      }

      // Copy all schema files
      if (fs.existsSync(srcSchemas)) {
        const files = fs.readdirSync(srcSchemas);
        files.forEach((file) => {
          const srcFile = path.join(srcSchemas, file);
          const outFile = path.join(outSchemas, file);
          fs.copyFileSync(srcFile, outFile);
          console.log(`[copy] ${file} -> out/schemas/${file}`);
        });
      }
    });
  },
};

/**
 * Plugin to copy webview files to output directory
 * @type {import('esbuild').Plugin}
 */
const copyWebviewPlugin = {
  name: "copy-webview",

  setup(build) {
    build.onEnd(() => {
      const srcWebview = path.join(__dirname, "src", "ui", "webview");
      const outWebview = path.join(__dirname, "out", "ui", "webview");

      // Create output webview directory if it doesn't exist
      if (!fs.existsSync(outWebview)) {
        fs.mkdirSync(outWebview, { recursive: true });
      }

      // Copy all webview files and directories
      if (fs.existsSync(srcWebview)) {
        const entries = fs.readdirSync(srcWebview, { withFileTypes: true });
        entries.forEach((entry) => {
          const srcPath = path.join(srcWebview, entry.name);
          const outPath = path.join(outWebview, entry.name);

          if (entry.isDirectory()) {
            copyDirRecursive(srcPath, outPath);
            console.log(
              `[copy] ${entry.name}/ -> out/ui/webview/${entry.name}/`
            );
          } else {
            fs.copyFileSync(srcPath, outPath);
            console.log(`[copy] ${entry.name} -> out/ui/webview/${entry.name}`);
          }
        });
      }

      // Copy codicon files from node_modules to webview directory
      const codiconsSource = path.join(
        __dirname,
        "node_modules",
        "@vscode",
        "codicons",
        "dist"
      );
      const codiconsOut = path.join(outWebview, "codicons");

      if (fs.existsSync(codiconsSource)) {
        if (!fs.existsSync(codiconsOut)) {
          fs.mkdirSync(codiconsOut, { recursive: true });
        }

        // Copy only the files we need (CSS and font)
        const codiconFiles = ["codicon.css", "codicon.ttf"];
        codiconFiles.forEach((file) => {
          const srcFile = path.join(codiconsSource, file);
          const outFile = path.join(codiconsOut, file);
          if (fs.existsSync(srcFile)) {
            fs.copyFileSync(srcFile, outFile);
            console.log(`[copy] ${file} -> out/ui/webview/codicons/${file}`);
          }
        });
      }
    });
  },
};

/**
 * Plugin to copy script files to output directory
 * @type {import('esbuild').Plugin}
 */
const copyScriptsPlugin = {
  name: "copy-scripts",

  setup(build) {
    build.onEnd(() => {
      const srcScripts = path.join(__dirname, "src", "scripts");
      const outScripts = path.join(__dirname, "out", "scripts");

      // Create output scripts directory if it doesn't exist
      if (!fs.existsSync(outScripts)) {
        fs.mkdirSync(outScripts, { recursive: true });
      }

      // Copy all script files
      if (fs.existsSync(srcScripts)) {
        const files = fs.readdirSync(srcScripts);
        files.forEach((file) => {
          const srcFile = path.join(srcScripts, file);
          const outFile = path.join(outScripts, file);
          fs.copyFileSync(srcFile, outFile);
          console.log(`[copy] ${file} -> out/scripts/${file}`);
        });
      }
    });
  },
};

/**
 * Bundle CodeMirror for webview use
 */
async function buildCodeMirror() {
  const outDir = path.join(__dirname, "out", "ui", "webview", "lib");

  // Ensure lib directory exists
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  await esbuild.build({
    entryPoints: ["src/ui/webview/codemirror-bundle-source.js"],
    bundle: true,
    format: "esm",
    outfile: "out/ui/webview/lib/codemirror.bundle.js",
    platform: "browser",
    external: [], // Bundle everything
    minify: production,
    sourcemap: !production,
    target: ["es2020"],
    logLevel: "info",
  });

  console.log("✓ CodeMirror bundle created");
}

async function main() {
  // Build CodeMirror bundle first
  await buildCodeMirror();

  // Build main extension
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "out/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    define: defineConstants,
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
      copyTemplatesPlugin,
      copySchemasPlugin,
      copyWebviewPlugin,
      copyScriptsPlugin,
    ],
  });

  // Build constants for webview (separate bundle to avoid VS Code API dependency)
  const constantsCtx = await esbuild.context({
    entryPoints: ["src/types/DashboardConstants.ts"],
    bundle: true,
    format: "iife", // Immediately Invoked Function Expression for browser
    globalName: "FlightPathConstants",
    minify: production,
    sourcemap: !production,
    outfile: "out/ui/webview/DashboardConstants.js",
    logLevel: "silent",
  });

  // Build MCP server (separate executable for CLI tools)
  const mcpCtx = await esbuild.context({
    entryPoints: ["src/mcp-server.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "out/mcp-server.js",
    external: ["@modelcontextprotocol/sdk"], // External dependency - used at runtime via node_modules
    logLevel: "silent",
  });

  if (watch) {
    await ctx.watch();
    await constantsCtx.watch();
    await mcpCtx.watch();
  } else {
    await ctx.rebuild();
    await constantsCtx.rebuild();
    await mcpCtx.rebuild();
    await ctx.dispose();
    await constantsCtx.dispose();
    await mcpCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
