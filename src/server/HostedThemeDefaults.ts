import * as fs from "fs";
import * as path from "path";

export interface HostedThemeDefaults {
  dark: string;
  light: string;
}

const THEME_DIRECTORY_CANDIDATES = [
  path.join(__dirname, "themes"),
  path.join(__dirname, "server", "themes"),
];

export function loadHostedThemeDefaults(): HostedThemeDefaults {
  const directory = THEME_DIRECTORY_CANDIDATES.find((candidate) =>
    fs.existsSync(path.join(candidate, "vscode-default-dark.css"))
  );
  if (!directory) {
    throw new Error("Hosted server theme defaults were not found");
  }
  return {
    dark: fs.readFileSync(
      path.join(directory, "vscode-default-dark.css"),
      "utf8"
    ),
    light: fs.readFileSync(
      path.join(directory, "vscode-default-light.css"),
      "utf8"
    ),
  };
}
