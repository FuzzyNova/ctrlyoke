// See package.json for why this exists; remove it once
// dev/bugs/backlog/hosted-tabs-wait-for-vscode-panel-to-open.md is fixed.
// Plain CommonJS so it needs no build.
const vscode = require("vscode");

exports.activate = async () => {
  await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
};
