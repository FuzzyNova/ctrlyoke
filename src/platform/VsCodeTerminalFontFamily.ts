import * as vscode from "vscode";
import type { Disposable, TerminalFontFamilySource } from "../core/HostPorts";

const TERMINAL_CONFIG_SECTION = "terminal.integrated";
const FONT_FAMILY_KEY = "fontFamily";
const FONT_FAMILY_SETTING = `${TERMINAL_CONFIG_SECTION}.${FONT_FAMILY_KEY}`;

/**
 * VS Code's `terminal.integrated.fontFamily`, so dashboard terminals use the
 * same font as VS Code's own terminal. An empty value means VS Code's terminal
 * uses the editor font, which dashboard terminals already fall back to.
 */
export class VsCodeTerminalFontFamily implements TerminalFontFamilySource {
  get(): string {
    const value = vscode.workspace
      .getConfiguration(TERMINAL_CONFIG_SECTION)
      .get<unknown>(FONT_FAMILY_KEY);
    return typeof value === "string" ? value.trim() : "";
  }

  onDidChange(listener: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(FONT_FAMILY_SETTING)) listener();
    });
  }
}
