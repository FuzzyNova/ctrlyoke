import * as fs from "node:fs/promises";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Creates a private directory and tightens its permissions if it exists. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}
