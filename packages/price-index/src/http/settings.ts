import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  priceIndexSettingsFile,
  priceIndexSettingsFileSchema,
  type FetcherSettings,
} from '../schema/price-index-settings.ts';

/** The fetcher's settings from `config/price-index.json` under `root`, validated. */
export async function readFetcherSettings(
  root: string,
): Promise<FetcherSettings> {
  const text = await readFile(resolve(root, priceIndexSettingsFile), 'utf8');
  return priceIndexSettingsFileSchema.parse(JSON.parse(text)).fetcher;
}
