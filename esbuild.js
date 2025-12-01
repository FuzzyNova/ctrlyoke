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
 * Plugin to copy template files to output directory
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

      // Copy all template files
      if (fs.existsSync(srcTemplates)) {
        const files = fs.readdirSync(srcTemplates);
        files.forEach((file) => {
          const srcFile = path.join(srcTemplates, file);
          const outFile = path.join(outTemplates, file);
          fs.copyFileSync(srcFile, outFile);
          console.log(`[copy] ${file} -> out/templates/${file}`);
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

      // Copy all webview files
      if (fs.existsSync(srcWebview)) {
        const files = fs.readdirSync(srcWebview);
        files.forEach((file) => {
          const srcFile = path.join(srcWebview, file);
          const outFile = path.join(outWebview, file);
          fs.copyFileSync(srcFile, outFile);
          console.log(`[copy] ${file} -> out/ui/webview/${file}`);
        });
      }
    });
  },
};

async function main() {
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

  if (watch) {
    await ctx.watch();
    await constantsCtx.watch();
  } else {
    await ctx.rebuild();
    await constantsCtx.rebuild();
    await ctx.dispose();
    await constantsCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
