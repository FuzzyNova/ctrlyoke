/**
 * Check whether a position is inside the block-scalar value of a YAML key.
 * The line reader keeps this helper independent of VS Code document types.
 */
export function isPositionInsideYamlBlockScalar(
  getLineText: (line: number) => string,
  currentLine: number,
  currentCharacter: number,
  key: string
): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(
    `^(\\s*)(?:-\\s+)?(${escapedKey})\\s*:\\s*(.*)$`
  );

  for (let line = currentLine; line >= 0; line--) {
    const text = getLineText(line);
    const match = keyPattern.exec(text);
    if (!match) continue;

    const scalarHeader = /^[|>][+-]?\d*[+-]?\s*(#.*)?$/.test(match[3].trim());
    if (!scalarHeader) {
      if (line === currentLine) continue;
      return false;
    }

    const keyIndent = text.indexOf(match[2]);
    if (line === currentLine) {
      const valueStart = match[0].indexOf(match[3]);
      return currentCharacter > valueStart;
    }

    for (
      let contentLine = line + 1;
      contentLine <= currentLine;
      contentLine++
    ) {
      const content = getLineText(contentLine);
      if (content.trim() === "") continue;
      const contentIndent = content.search(/\S/);
      if (contentIndent <= keyIndent) return false;
    }
    return true;
  }

  return false;
}
