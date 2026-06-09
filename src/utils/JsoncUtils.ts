/**
 * Strips single-line (//) and block (/* *\/) comments from a JSON string,
 * producing valid JSON that can be passed to JSON.parse().
 *
 * VS Code config files (mcp.json, settings.json) use JSONC format.
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let i = 0;

  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        result += text[i]! + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i]!;
      i++;
    } else if (text[i] === '"') {
      inString = true;
      result += text[i]!;
      i++;
    } else if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
    } else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2;
    } else {
      result += text[i]!;
      i++;
    }
  }

  return result;
}
