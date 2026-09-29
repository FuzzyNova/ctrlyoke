const CROSS_SCHEMA_REF_PATTERN =
  /(\"\$ref\":\s*\")(?:\.\.\/v\d+\/)?([\w.-]+\.json)#/g;

/** Rewrite cross-schema references while preserving their fragment. */
function rewriteCrossSchemaRefs(text, resolvePath) {
  return text.replace(CROSS_SCHEMA_REF_PATTERN, (whole, prefix, fileName) => {
    const targetPath = resolvePath(fileName);
    return targetPath === undefined ? whole : `${prefix}${targetPath}#`;
  });
}

module.exports = { rewriteCrossSchemaRefs };
