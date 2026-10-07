const FORBIDDEN_PACKAGE_IMPORTS = new Set([
  "vscode",
  "@vscode/extension-telemetry",
]);

function findNodeBundleVscodeViolations(metafile) {
  const violations = new Set();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    if (/node_modules[\\/]vscode([\\/]|$)/i.test(input)) {
      violations.add(input);
    }
    if (/node_modules[\\/]@vscode[\\/]extension-telemetry([\\/]|$)/i.test(input)) {
      violations.add(input);
    }
    if (/(^|[\\/])src[\\/]platform[\\/]VsCode[^\\/]*\.(?:[cm]?js|tsx?)$/i.test(input)) {
      violations.add(input);
    }
  }

  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (FORBIDDEN_PACKAGE_IMPORTS.has(imported.path)) {
        violations.add(imported.path);
      }
    }
  }
  return [...violations].sort();
}

function nodeBundleVscodeGuardPlugin(bundleName) {
  return {
    name: `node-bundle-vscode-guard-${bundleName}`,
    setup(build) {
      build.onEnd((result) => {
        if (!result.metafile) return;
        const violations = findNodeBundleVscodeViolations(result.metafile);
        if (violations.length === 0) return;
        return {
          errors: [
            {
              text: `${bundleName} includes forbidden VS Code runtime dependencies: ${violations.join(", ")}`,
            },
          ],
        };
      });
    },
  };
}

module.exports = { findNodeBundleVscodeViolations, nodeBundleVscodeGuardPlugin };
