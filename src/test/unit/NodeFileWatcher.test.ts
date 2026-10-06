import { NodeFileWatcherFactory } from "../../platform/NodeFileWatcher";
import { registerFileWatcherContractTests } from "../helpers/fileWatcherContract";

registerFileWatcherContractTests(
  "Node file watcher",
  new NodeFileWatcherFactory()
);
