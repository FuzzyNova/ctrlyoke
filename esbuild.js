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
 * Plugin to copy server static files to output directory
 * @type {import('esbuild').Plugin}
 */
const copyServerPlugin = {
  name: "copy-server",

  setup(build) {
    build.onEnd(() => {
      const srcServer = path.join(__dirname, "src", "server");
      const outServer = path.join(__dirname, "out", "server");

      if (!fs.existsSync(outServer)) {
        fs.mkdirSync(outServer, { recursive: true });
      }

      const serverStaticFiles = [
        "standalone-shim.js",
        "flightpath-service-worker.js",
      ];

      for (const fileName of serverStaticFiles) {
        const srcFile = path.join(srcServer, fileName);
        if (!fs.existsSync(srcFile)) {
          continue;
        }

        fs.copyFileSync(srcFile, path.join(outServer, fileName));
        console.log(`[copy] ${fileName} -> out/server/${fileName}`);
      }
    });
  },
};

/**
 * Plugin to copy the resvg WASM file to the output directory.
 * Required so PngIconService can load it at runtime via __dirname.
 * @type {import('esbuild').Plugin}
 */
const copyWasmPlugin = {
  name: "copy-wasm",

  setup(build) {
    build.onEnd(() => {
      const src = path.join(
        __dirname,
        "node_modules",
        "@resvg",
        "resvg-wasm",
        "index_bg.wasm"
      );
      const dest = path.join(__dirname, "out", "resvg.wasm");
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log("[copy] resvg.wasm -> out/resvg.wasm");
      } else {
        console.warn("[copy] resvg.wasm source not found, skipping");
      }
    });
  },
};

async function main() {
  // Build webview inline scripts (bootstrap + module loader)
  // These run in the browser webview context and are read/injected by FlightPathWebviewProvider.
  const webviewScriptsCtx = await esbuild.context({
    entryPoints: [
      "src/ui/webview-react/scripts/bootstrapScript.ts",
      "src/ui/webview-react/scripts/moduleLoaderScript.ts",
    ],
    bundle: false,
    format: "iife",
    minify: production,
    platform: "browser",
    target: "es2020",
    outdir: "out/ui/webview-scripts",
    outbase: "src/ui/webview-react/scripts",
    logLevel: "error",
  });

  // Prefer the ESM entry point for packages that expose both ESM and UMD/CJS.
  // Packages like jsonc-parser use a UMD factory that passes `require` as a parameter,
  // which defeats esbuild's static analysis and leaves relative requires unbundled.
  // The ESM version uses static imports that esbuild always bundles correctly.
  const mainFields = ["module", "main"];

  // Build main extension
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    mainFields,
    outfile: "out/extension.js",
    external: ["vscode", "node-pty"],
    logLevel: "silent",
    define: defineConstants,
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
      copyTemplatesPlugin,
      copySchemasPlugin,
      copyScriptsPlugin,
      copyServerPlugin,
      copyWasmPlugin,
    ],
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
    mainFields,
    outfile: "out/mcp-server.js",
    logLevel: "silent",
  });

  // Build standalone CLI binary
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "package.json"), "utf-8")
  );
  const cliCtx = await esbuild.context({
    entryPoints: ["src/cli.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "node22",
    mainFields,
    outfile: "out/cli.js",
    // vscode is intentionally NOT in externals — the shim below satisfies all vscode imports
    // with no-op stubs so the CLI binary can run in plain Node.js without VS Code present.
    external: ["node-pty"], // optional native dep; not used by CLI paths
    alias: {
      // Redirect all `import ... from 'vscode'` in the CLI bundle to the no-op shim.
      // The real vscode module is only available inside the VS Code extension host.
      vscode: path.resolve(__dirname, "src/platform/vscode-shim.ts"),
    },
    logLevel: "silent",
    banner: {
      js: "#!/usr/bin/env node",
    },
    define: {
      ...defineConstants,
      VERSION: JSON.stringify(packageJson.version || "0.0.0"),
      IS_DEV_MODE: "false", // CLI is always production-like
    },
  });

  if (watch) {
    await webviewScriptsCtx.watch();
    await ctx.watch();
    await mcpCtx.watch();
    await cliCtx.watch();
  } else {
    await webviewScriptsCtx.rebuild();
    await ctx.rebuild();
    await mcpCtx.rebuild();
    await cliCtx.rebuild();
    await webviewScriptsCtx.dispose();
    await ctx.dispose();
    await mcpCtx.dispose();
    await cliCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
