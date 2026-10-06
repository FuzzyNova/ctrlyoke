import * as fs from "fs/promises";

/**
 * Read a JSON file and parse it.
 * Throws if the file cannot be read or the content is not valid JSON.
 *
 * @param filePath Absolute path to JSON file
 * @returns Parsed JSON data
 */
export async function readJsonFile(filePath: string): Promise<any> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content);
}
