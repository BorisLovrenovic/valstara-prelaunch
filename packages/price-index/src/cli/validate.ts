import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  configFiles,
  configIssues,
  type ConfigFileKey,
  type ConfigIssue,
} from '../schema/config.ts';
import {
  priceIndexSettingsFile,
  priceIndexSettingsFileSchema,
} from '../schema/price-index-settings.ts';

type ReadResult = { value: unknown } | { issue: ConfigIssue };

/** Reads and parses one JSON file, reporting a problem instead of throwing. */
async function readJsonFile(root: string, file: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(resolve(root, file), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      issue: {
        file,
        path: '',
        message: code === 'ENOENT' ? 'file not found' : `unreadable (${code})`,
      },
    };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return {
      issue: {
        file,
        path: '',
        message: `not valid JSON: ${(error as Error).message}`,
      },
    };
  }
}

/**
 * Reads the configuration files under `root` and checks them against their
 * schemas: the three catalogue files against each other, and the tool's
 * settings (`config/price-index.json`, E11.6-04) on their own. A file that is
 * missing or is not JSON is reported as an issue, never thrown.
 */
export async function validateConfig(root: string): Promise<ConfigIssue[]> {
  const input: Partial<Record<ConfigFileKey, unknown>> = {};
  const readIssues: ConfigIssue[] = [];

  for (const [key, file] of Object.entries(configFiles) as [
    ConfigFileKey,
    string,
  ][]) {
    const result = await readJsonFile(root, file);
    if ('issue' in result) {
      readIssues.push(result.issue);
    } else {
      input[key] = result.value;
    }
  }

  const settings = await readJsonFile(root, priceIndexSettingsFile);
  const settingsIssues: ConfigIssue[] = [];
  if ('issue' in settings) {
    readIssues.push(settings.issue);
  } else {
    const parsed = priceIndexSettingsFileSchema.safeParse(settings.value);
    if (!parsed.success) {
      settingsIssues.push(
        ...parsed.error.issues.map((issue) => ({
          file: priceIndexSettingsFile,
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }
  }

  if (readIssues.length > 0) {
    return readIssues;
  }
  return [
    ...configIssues(input as Record<ConfigFileKey, unknown>).issues,
    ...settingsIssues,
  ];
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues
    .map(
      ({ file, path, message }) =>
        `${file}${path ? ` (${path})` : ''}: ${message}`,
    )
    .join('\n');
}
