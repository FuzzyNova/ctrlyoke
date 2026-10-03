/**
 * Extracts file extensions from globs like "**\/*.md" → ["md"] and
 * "**\/*.{md,txt}" → ["md", "txt"]. Globs that still contain metacharacters
 * after removing the optional prefix and expanding one brace group are dropped.
 */
export function extractExtensionsFromGlobs(globs: string[]): string[] {
  const globMetacharacters = /[*?\[\]{}]/;

  return globs.flatMap((glob) => {
    const hasExtensionPrefix = glob.startsWith("**/*.");
    const extension = hasExtensionPrefix ? glob.slice("**/*.".length) : glob;
    const braceGroup = hasExtensionPrefix
      ? /^(.*?)\{([^{}]*)\}(.*)$/.exec(extension)
      : null;
    const extensions = braceGroup
      ? braceGroup[2]!
          .split(",")
          .map((choice) => `${braceGroup[1]!}${choice}${braceGroup[3]!}`)
      : [extension];

    return extensions.filter(
      (candidate) => candidate.length > 0 && !globMetacharacters.test(candidate)
    );
  });
}
