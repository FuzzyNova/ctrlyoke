import * as assert from "assert";
import * as vscode from "vscode";

/**
 * End-to-End Workflow Integration Tests
 *
 * Tests complete FlightPath workflows from prompt file to execution
 */
suite("Workflow Integration Tests", () => {
  suiteSetup(async function () {
    this.timeout(30000);

    // Find FlightPath extension (might not have publisher during development)
    const allExtensions = vscode.extensions.all;
    const extension = allExtensions.find(
      (ext) =>
        ext.id === "nhickster.flightpath" ||
        ext.packageJSON.name === "flightpath"
    );

    assert.ok(extension, "FlightPath extension must be loaded");

    if (!extension.isActive) {
      await extension.activate();
    }
  });
});
