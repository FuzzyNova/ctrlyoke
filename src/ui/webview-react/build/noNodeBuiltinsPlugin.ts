import { builtinModules } from "node:module";
import type { Plugin } from "vite";

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);
const NODE_PREFIX = "node:";

/**
 * Return the Node built-in that `source` names when a ctrlyoke source file
 * imports it, or `undefined` when the import is fine. Imports made inside
 * `node_modules` and by virtual modules are left to Vite, since packages
 * often guard a Node import behind a runtime check.
 */
export function findForbiddenNodeBuiltin(
  source: string,
  importer: string | undefined
): string | undefined {
  if (!importer || importer.startsWith("\0")) return undefined;
  if (importer.replace(/\\/g, "/").includes("/node_modules/")) return undefined;
  const name = source.startsWith(NODE_PREFIX)
    ? source.slice(NODE_PREFIX.length)
    : source;
  const root = name.split("/")[0];
  return NODE_BUILTINS.has(name) || NODE_BUILTINS.has(root)
    ? source
    : undefined;
}

/**
 * Fail the dashboard build when ctrlyoke's own code imports a Node built-in.
 * Vite would otherwise replace the module with an empty browser stub and only
 * warn, so the build succeeds and the dashboard throws when that code runs.
 */
export function noNodeBuiltinsPlugin(): Plugin {
  return {
    name: "ctrlyoke:no-node-builtins",
    enforce: "pre",
    apply: "build",
    resolveId(source, importer) {
      const builtin = findForbiddenNodeBuiltin(source, importer);
      if (builtin === undefined) return null;
      this.error(
        `${importer} imports the Node built-in "${builtin}", which the dashboard ` +
          `bundle cannot use. Move what the dashboard needs into a module that ` +
          `does not import Node built-ins (for example src/utils/SecretName.ts ` +
          `beside platform/SecretKey.ts), or import the browser global instead.`
      );
    },
  };
}
