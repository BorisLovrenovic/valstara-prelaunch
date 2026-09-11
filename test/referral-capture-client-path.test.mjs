import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

test('repository browser code has no referral or UTM attribution path', async () => {
  const directory = new URL('../src/islands/', import.meta.url);
  const files = await readdir(directory, { withFileTypes: true });
  const browserCode = await Promise.all(
    files
      .filter((file) => file.isFile() && /\.(?:astro|ts)$/u.test(file.name))
      .map(async (file) => {
        const source = await readFile(new URL(file.name, directory), 'utf8');
        return file.name.endsWith('.astro')
          ? [...source.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
              .map(([, script]) => script)
              .join('\n')
          : source;
      }),
  );
  assert.doesNotMatch(
    browserCode.join('\n'),
    /referral_capture|searchParams|utm_|[.#]ref/u,
  );
});
