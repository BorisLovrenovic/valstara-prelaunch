import { readFile } from 'node:fs/promises';
import { validateProviderShowcase } from '../../src/content/provider-showcase.ts';

const entries: unknown = JSON.parse(
  await readFile('src/content/provider-showcase.json', 'utf8'),
);
await validateProviderShowcase(entries);
