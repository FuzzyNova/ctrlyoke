import { VarSubstitutor } from "../utils/VarSubstitutor";

export interface PromptTextFileResolver {
  looksLikePromptFilePath(promptValue: string): boolean;
  resolvePromptValue(
    promptValue: string,
    sourceDefinitionPath?: string
  ): Promise<string>;
}

export const PASSTHROUGH_PROMPT_FILE_RESOLVER: PromptTextFileResolver = {
  looksLikePromptFilePath: () => false,
  resolvePromptValue: async (promptValue) => promptValue,
};

/**
 * Substitute variables in a prompt path, resolve the file when it is a
 * standalone reference, then substitute variables in the loaded prompt text.
 */
export async function resolvePromptTextWithVariables(
  promptText: string,
  variables: Readonly<Record<string, string>>,
  resolver: PromptTextFileResolver = PASSTHROUGH_PROMPT_FILE_RESOLVER,
  sourceDefinitionPath?: string
): Promise<string> {
  const substitutedPath = VarSubstitutor.applyToPromptText(promptText, {
    ...variables,
  });
  const isPromptFile = resolver.looksLikePromptFilePath(substitutedPath);
  const resolvedText = await resolver.resolvePromptValue(
    substitutedPath,
    sourceDefinitionPath
  );
  return isPromptFile
    ? VarSubstitutor.applyToPromptText(resolvedText, { ...variables })
    : resolvedText;
}
