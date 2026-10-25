import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { surveyQuestionSets } from '../server/survey/questions.ts';

export interface Provider {
  name: string;
  category: string;
  logo: string;
  logoDark?: string;
  brandColor: string;
  confirmation: { name: string; date: string };
  source:
    { kind: 'url'; url: string } | { kind: 'founder-supplied'; date: string };
}

const logoDirectory = join(process.cwd(), 'public/images/providers');
const logoPath = /^\/images\/providers\/[a-z0-9-]+\.(?:svg|webp)$/u;
const maxBytes = 12 * 1024;
const categories: readonly string[] =
  surveyQuestionSets['2026-10-19'].categoryPreference;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} is required`);
  return value;
}

export async function validateProviderShowcase(
  input: unknown,
  directory = logoDirectory,
): Promise<Provider[]> {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error('Provider showcase must be a non-empty array');
  const names = new Set<string>();
  const result: Provider[] = [];
  for (const [index, item] of input.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      throw new Error(`Provider ${index} must be an object`);
    const entry = item as Record<string, unknown>;
    const name = requiredText(entry.name, 'name');
    if (names.has(name)) throw new Error(`Duplicate provider: ${name}`);
    names.add(name);
    const category = requiredText(entry.category, 'category');
    if (!categories.includes(category))
      throw new Error(`Invalid category: ${category}`);
    const brandColor = requiredText(entry.brandColor, 'brandColor');
    if (!/^#[0-9a-fA-F]{6}$/u.test(brandColor))
      throw new Error(`Invalid brand colour: ${name}`);
    const confirmation = entry.confirmation as
      Record<string, unknown> | undefined;
    requiredText(confirmation?.name, 'confirmation.name');
    const confirmed = requiredText(confirmation?.date, 'confirmation.date');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(confirmed))
      throw new Error(`Invalid confirmation date: ${name}`);
    const source = entry.source as Record<string, unknown> | undefined;
    if (source?.kind === 'url') {
      const url = requiredText(source.url, 'source.url');
      if (!/^https:\/\//u.test(url))
        throw new Error(`Invalid source URL: ${name}`);
    } else if (source?.kind === 'founder-supplied') {
      const date = requiredText(source.date, 'source.date');
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
        throw new Error(`Invalid source date: ${name}`);
    } else throw new Error(`Invalid logo source: ${name}`);
    for (const key of ['logo', 'logoDark'] as const) {
      if (key === 'logoDark' && entry[key] === undefined) continue;
      const logo = requiredText(entry[key], key);
      if (
        !logoPath.test(logo) ||
        (logo.endsWith('.webp') && (name !== 'AION2' || key !== 'logo'))
      )
        throw new Error(`Invalid logo path: ${name}`);
      const file = join(directory, logo.slice('/images/providers/'.length));
      let asset: Buffer;
      try {
        if ((await stat(file)).size > maxBytes)
          throw new Error(`Oversized logo: ${name}`);
        asset = await readFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new Error(`Missing logo: ${name}`, { cause: error });
        throw error;
      }
      if (logo.endsWith('.svg')) {
        const svg = asset.toString('utf8');
        if (!/<svg\b[^>]*\bwidth="[^"]+"[^>]*\bheight="[^"]+"/u.test(svg))
          throw new Error(`Logo lacks intrinsic dimensions: ${name}`);
        if (
          /<script\b|\bon\w+=|https?:\/\/|<foreignObject\b/iu.test(
            svg.replace(/xmlns(?::\w+)?="[^"]*"/gu, ''),
          )
        )
          throw new Error(`Unsafe SVG logo: ${name}`);
      } else {
        const meta = await sharp(asset).metadata();
        if (meta.format !== 'webp' || !meta.width || !meta.height)
          throw new Error(`Invalid WebP logo: ${name}`);
      }
    }
    result.push(entry as unknown as Provider);
  }
  return result;
}
