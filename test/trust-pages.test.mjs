import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const root = fileURLToPath(new URL('..', import.meta.url));
const prerequisite = await readFile(
  join(root, 'docs/prerequisites/p3b-trust-pages-copy.md'),
  'utf8',
);
const pages = ['legit', 'guarantee', 'about'];

function approvedPage(slug) {
  const section = prerequisite
    .split(`## /${slug}\n`, 2)[1]
    ?.split('\n---\n', 1)[0];
  assert.ok(section, `missing approved /${slug} copy`);
  const title = /^\*\*Title:\*\* (.+)$/mu.exec(section)?.[1];
  const description = /^\*\*Description:\*\* (.+)$/mu.exec(section)?.[1];
  assert.ok(title && description);
  const copy = section
    .split('### Page copy\n\n', 2)[1]
    ?.split('\n### Source notes', 1)[0]
    ?.trim()
    .replace(
      /^\*Pre-launch paragraph, removed at the storefront port:\* /gmu,
      '',
    );
  assert.ok(copy);
  assert.match(section, /### Source notes\n\n1\./u);
  return { title, description, copy };
}

test('trust content transcribes the founder-approved pages with source notes', async () => {
  for (const slug of pages) {
    const { title, description, copy } = approvedPage(slug);
    const content = await readFile(
      join(root, `src/content/${slug}.md`),
      'utf8',
    );
    const expected = await format(
      `---\nportTarget: /${slug}\ntitle: ${title}\ndescription: ${description}\n---\n\n${copy}\n`,
      { parser: 'markdown' },
    );
    assert.equal(
      content,
      expected,
      `/${slug} must match its approved, sourced copy`,
    );
    assert.doesNotMatch(
      content,
      /\b(?:TODO|TBD|lorem ipsum|placeholder|dummy copy)\b/iu,
      `/${slug} contains a placeholder marker`,
    );
  }
});

test(
  'the three permanent URLs build as static pages with no client JavaScript',
  { timeout: 120_000 },
  async () => {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 110_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const slug of pages) {
      const { title, description } = approvedPage(slug);
      const html = await readFile(
        join(root, `dist/client/${slug}/index.html`),
        'utf8',
      );
      assert.match(html, new RegExp(`<title>${title}</title>`, 'u'));
      assert.ok(html.includes(`content="${description}"`));
      assert.match(html, /<h1[^>]*>/u);
      assert.doesNotMatch(html, /<script\b|\.js(?:["?]|$)/iu);
      assert.doesNotMatch(
        html,
        /\b(?:TODO|TBD|lorem ipsum|placeholder|dummy copy)\b/iu,
      );
      assert.doesNotMatch(html, /Source notes/u);
    }
  },
);
