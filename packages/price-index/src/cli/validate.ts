import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  configFiles,
  configIssues,
  type ConfigFileKey,
  type ConfigIssue,
} from '../schema/config.ts';

/**
 * Reads the three configuration files under `root` and checks them against
 * their schemas and against each other. A file that is missing or is not JSON
 * is reported as an issue, never thrown.
 */
export async function validateConfig(root: string): Promise<ConfigIssue[]> {
  const input: Partial<Record<ConfigFileKey, unknown>> = {};
  const readIssues: ConfigIssue[] = [];

  for (const [key, file] of Object.entries(configFiles) as [
    ConfigFileKey,
    string,
  ][]) {
    let text: string;
    try {
      text = await readFile(resolve(root, file), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      readIssues.push({
        file,
        path: '',
        message: code === 'ENOENT' ? 'file not found' : `unreadable (${code})`,
      });
      continue;
    }
    try {
      input[key] = JSON.parse(text);
    } catch (error) {
      readIssues.push({
        file,
        path: '',
        message: `not valid JSON: ${(error as Error).message}`,
      });
    }
  }

  if (readIssues.length > 0) {
    return readIssues;
  }
  return configIssues(input as Record<ConfigFileKey, unknown>).issues;
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues
    .map(
      ({ file, path, message }) =>
        `${file}${path ? ` (${path})` : ''}: ${message}`,
    )
    .join('\n');
}
