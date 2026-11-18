import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { z } from 'zod';

import { approvalsFile, approvalsFileSchema } from '../schema/approvals.ts';
import {
  configFiles,
  configIssues,
  type ConfigFileKey,
  type ConfigIssue,
  type ConfigSet,
} from '../schema/config.ts';
import {
  manualOverridesFile,
  manualOverridesFileSchema,
} from '../schema/manual-overrides.ts';
import {
  latestFileSchema,
  snapshotFileSchema,
} from '../schema/price-index-files.ts';
import {
  priceIndexSettingsFile,
  priceIndexSettingsFileSchema,
  type PriceIndexSettingsFile,
} from '../schema/price-index-settings.ts';
import {
  runIdPattern,
  runLogDirectory,
  runLogFileSchema,
} from '../schema/run-files.ts';

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

export interface LoadedConfig {
  /** The three catalogue files, when they are all valid. */
  config?: ConfigSet;
  /** The tool's settings, when they are valid. */
  settings?: PriceIndexSettingsFile;
  issues: ConfigIssue[];
}

/**
 * Reads the configuration files under `root` and checks them against their
 * schemas: the three catalogue files against each other, and the tool's
 * settings (`config/price-index.json`, E11.6-04) on their own. A file that is
 * missing or is not JSON is reported as an issue, never thrown.
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
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
  let parsedSettings: PriceIndexSettingsFile | undefined;
  if ('issue' in settings) {
    readIssues.push(settings.issue);
  } else {
    const parsed = priceIndexSettingsFileSchema.safeParse(settings.value);
    if (parsed.success) {
      parsedSettings = parsed.data;
    } else {
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
    return { issues: readIssues };
  }
  const { config, issues } = configIssues(
    input as Record<ConfigFileKey, unknown>,
  );
  return {
    config,
    settings: parsedSettings,
    issues: [...issues, ...settingsIssues],
  };
}

/** Every problem in the configuration files under `root`. */
export async function validateConfig(root: string): Promise<ConfigIssue[]> {
  return (await loadConfig(root)).issues;
}

/** The committed data directory, relative to the repository root. */
export const priceIndexDataDirectory = 'data/price-index';
export const latestFile = `${priceIndexDataDirectory}/latest.json`;
export const snapshotsDirectory = `${priceIndexDataDirectory}/snapshots`;

const snapshotNamePattern =
  /^\d{4}-\d{2}-\d{2}(?:-(?:[2-9]|[1-9][0-9]+))?\.json$/u;

function schemaIssues(
  file: string,
  schema: z.ZodType,
  value: unknown,
): ConfigIssue[] {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        file,
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
}

/** One file against its schema; a missing file is fine when `optional`. */
async function fileIssues(
  root: string,
  file: string,
  schema: z.ZodType,
  options: { optional: boolean },
): Promise<ConfigIssue[]> {
  const result = await readJsonFile(root, file);
  if ('issue' in result) {
    return options.optional && result.issue.message === 'file not found'
      ? []
      : [result.issue];
  }
  return schemaIssues(file, schema, result.value);
}

/** The names in a directory, sorted; none when it does not exist. */
async function directoryNames(root: string, directory: string) {
  try {
    return (await readdir(resolve(root, directory))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Every problem in the data files under `root` (E11.6-07): latest.json and
 * each snapshot, manual-overrides.json, approvals.json, and each run log
 * under reports/runs/. latest.json, the snapshots and the run logs may not
 * exist yet; the two seeded files must. Files are read one at a time. A
 * temporary file a crashed write left behind (`.<name>.tmp`) is ignored, as
 * git ignores it.
 */
export async function validateDataFiles(root: string): Promise<ConfigIssue[]> {
  const issues: ConfigIssue[] = [
    ...(await fileIssues(root, latestFile, latestFileSchema, {
      optional: true,
    })),
  ];
  for (const name of await directoryNames(root, snapshotsDirectory)) {
    const file = `${snapshotsDirectory}/${name}`;
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      continue;
    }
    if (!snapshotNamePattern.test(name)) {
      issues.push({
        file,
        path: '',
        message:
          'is not named like a snapshot (YYYY-MM-DD.json or YYYY-MM-DD-N.json)',
      });
      continue;
    }
    issues.push(
      ...(await fileIssues(root, file, snapshotFileSchema, {
        optional: false,
      })),
    );
  }
  issues.push(
    ...(await fileIssues(root, manualOverridesFile, manualOverridesFileSchema, {
      optional: false,
    })),
    ...(await fileIssues(root, approvalsFile, approvalsFileSchema, {
      optional: false,
    })),
  );
  for (const name of await directoryNames(root, runLogDirectory)) {
    const file = `${runLogDirectory}/${name}`;
    const runId = name.replace(/\.json$/u, '');
    if (!name.endsWith('.json') || !runIdPattern.test(runId)) {
      issues.push({
        file,
        path: '',
        message: 'is not named like a run log (<run_id>.json)',
      });
      continue;
    }
    const result = await readJsonFile(root, file);
    if ('issue' in result) {
      issues.push(result.issue);
      continue;
    }
    const logIssues = schemaIssues(file, runLogFileSchema, result.value);
    issues.push(...logIssues);
    if (
      logIssues.length === 0 &&
      (result.value as { run_id: string }).run_id !== runId
    ) {
      issues.push({
        file,
        path: 'run_id',
        message: `must be ${runId}, the file's name`,
      });
    }
  }
  return issues;
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues
    .map(
      ({ file, path, message }) =>
        `${file}${path ? ` (${path})` : ''}: ${message}`,
    )
    .join('\n');
}
