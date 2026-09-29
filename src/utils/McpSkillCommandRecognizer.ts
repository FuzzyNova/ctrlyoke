export interface RecognizedMcpSkillCommand {
  tool: string;
  parameters: Record<string, unknown>;
}

function tokenizeCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (
        character === "\\" &&
        (command[index + 1] === '"' || command[index + 1] === "\\")
      ) {
        token += command[++index];
      } else {
        token += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\" && index + 1 < command.length) {
      const next = command[index + 1];
      if (/\s/.test(next) || next === "'" || next === '"') {
        token += next;
        index++;
      } else {
        token += character;
      }
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote) {
    return undefined;
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  return tokens;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).split("\\").pop() ?? path;
}

/** Recognize the command form documented by the ctrlyoke MCP skill. */
export function recognizeMcpSkillCommand(
  command: string
): RecognizedMcpSkillCommand | undefined {
  const tokens = tokenizeCommand(command);
  if (!tokens) {
    return undefined;
  }

  const scriptIndex = tokens.findIndex(
    (token, index) =>
      index > 0 &&
      basename(token).toLowerCase() === "mcp-server.js" &&
      /^(?:node|node\.exe)$/i.test(basename(tokens[index - 1]))
  );
  if (scriptIndex < 0) {
    return undefined;
  }

  let tool: string | undefined;
  let args: string | undefined;
  for (let index = scriptIndex + 1; index < tokens.length; index++) {
    if (tokens[index] === "--tool" && tool === undefined) {
      tool = tokens[index + 1];
      index++;
    } else if (tokens[index] === "--args" && args === undefined) {
      args = tokens[index + 1];
      index++;
    }
  }
  if (!tool || args === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return { tool, parameters: parsed as Record<string, unknown> };
  } catch {
    return undefined;
  }
}
