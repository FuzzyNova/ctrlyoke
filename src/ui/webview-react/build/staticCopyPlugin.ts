import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/** A source copied verbatim into the webview build output. */
export interface StaticCopyTarget {
  /** A file, or a directory whose contents are copied recursively. Relative to the Vite root. */
  readonly src: string;
  /** Destination directory, relative to the build `outDir`. */
  readonly dest: string;
}

/** One concrete file to copy, with its forward-slash path inside the output directory. */
export interface StaticCopyFile {
  readonly sourcePath: string;
  readonly outputPath: string;
}

// Only the extensions the targets actually serve; anything else falls back to a
// generic binary type, which `fetch()` consumers (the Typo.js dictionaries) accept.
const DEV_SERVER_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
};
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function toOutputPath(dest: string, relativePath: string): string {
  return path.posix.join(dest, relativePath.split(path.sep).join("/"));
}

/**
 * Expands copy targets into individual files. A missing source throws, so a
 * renamed asset fails the build instead of silently shipping without it.
 */
export function resolveStaticCopyFiles(
  targets: readonly StaticCopyTarget[],
  root: string
): StaticCopyFile[] {
  return targets.flatMap((target) => {
    const sourcePath = path.resolve(root, target.src);
    if (!fs.statSync(sourcePath).isDirectory()) {
      return [
        {
          sourcePath,
          outputPath: toOutputPath(target.dest, path.basename(sourcePath)),
        },
      ];
    }
    return fs
      .readdirSync(sourcePath, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(entry.parentPath, entry.name);
        return {
          sourcePath: filePath,
          outputPath: toOutputPath(
            target.dest,
            path.relative(sourcePath, filePath)
          ),
        };
      });
  });
}

/**
 * Copies fixed assets (dictionaries, codicons, icons, `typo.js`) next to the
 * bundle on build, and serves them at the same paths from the dev server.
 */
export function staticCopyPlugin(targets: readonly StaticCopyTarget[]): Plugin {
  let config: ResolvedConfig | undefined;
  const resolveFiles = (): StaticCopyFile[] => {
    if (!config) {
      throw new Error("staticCopyPlugin used before Vite resolved its config");
    }
    return resolveStaticCopyFiles(targets, config.root);
  };

  return {
    name: "ctrlyoke:static-copy",

    configResolved(resolved) {
      config = resolved;
    },

    // Lets `vite build --watch` rebuild (and so re-copy) when a source changes.
    buildStart() {
      for (const file of resolveFiles()) {
        this.addWatchFile(file.sourcePath);
      }
    },

    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) {
        throw new Error("staticCopyPlugin requires a build output directory");
      }
      for (const file of resolveFiles()) {
        const destination = path.join(outDir, file.outputPath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file.sourcePath, destination);
      }
    },

    configureServer(server) {
      const sourceByUrl = new Map(
        resolveFiles().map((file) => [`/${file.outputPath}`, file.sourcePath])
      );
      server.middlewares.use((req, res, next) => {
        const pathname = decodeURIComponent((req.url ?? "").split("?")[0]);
        const sourcePath = sourceByUrl.get(pathname);
        if (!sourcePath) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          DEV_SERVER_CONTENT_TYPES[path.extname(sourcePath)] ??
            DEFAULT_CONTENT_TYPE
        );
        fs.createReadStream(sourcePath).pipe(res);
      });
    },
  };
}
