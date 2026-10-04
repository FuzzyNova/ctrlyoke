import * as yaml from "js-yaml";

/** Shared schema for workflow YAML, including YAML 1.1 merge keys. */
export const WORKFLOW_YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);
