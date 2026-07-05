import * as fs from "fs";
import * as path from "path";

const RUNTIME_NODE_MODULES_DIR = path.join(
  __dirname,
  "runtime-deps",
  "node_modules"
);

export function resolveRuntimePackageDir(packageName: string): string {
  return path.join(RUNTIME_NODE_MODULES_DIR, ...packageName.split("/"));
}

export function resolveRuntimePackageFile(
  packageName: string,
  ...segments: string[]
): string {
  return path.join(resolveRuntimePackageDir(packageName), ...segments);
}

export function requireRuntimePackage<T>(packageName: string): T {
  const packageDir = resolveRuntimePackageDir(packageName);
  if (!fs.existsSync(packageDir)) {
    throw new Error(
      `Missing isolated runtime dependency '${packageName}' at ${packageDir}. Rebuild ctrlyoke to restore packaged runtime dependencies.`
    );
  }

  return require(packageDir) as T;
}
