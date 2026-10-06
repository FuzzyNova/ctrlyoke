import { VsCodeFileWatcherFactory } from "../../platform/VsCodeFileWatcher";
import { registerFileWatcherContractTests } from "../helpers/fileWatcherContract";

registerFileWatcherContractTests(
  "VS Code file watcher",
  new VsCodeFileWatcherFactory()
);
