import assert from 'node:assert/strict';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
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
  const fullCopy = section
    .split('### Page copy\n\n', 2)[1]
    ?.split('\n### Source notes', 1)[0]
    ?.trim()
    .replace(
      /^\*Pre-launch paragraph, removed at the storefront port:\* /gmu,
      '',
    );
  assert.ok(fullCopy);
  assert.match(section, /### Source notes\n\n1\./u);
  if (slug !== 'legit') return { title, description, copy: fullCopy };
  return { title, description, copy: fullCopy };
}

test('trust content transcribes the founder-approved pages with source notes', async () => {
  for (const slug of pages) {
    const { title, description, copy } = approvedPage(slug);
    for (const [name, prose] of [[slug, copy]]) {
      const content = await readFile(
        join(root, `src/content/${name}.md`),
        'utf8',
      );
      const expected = await format(
        `---\nportTarget: /${slug}\ntitle: ${title}\ndescription: ${description}\n---\n\n${prose}\n`,
        { parser: 'markdown' },
      );
      assert.equal(
        content,
        expected,
        `/${name} must match its approved, sourced copy`,
      );
      assert.doesNotMatch(
        content,
        /\b(?:TODO|TBD|lorem ipsum|placeholder|dummy copy)\b/iu,
        `/${name} contains a placeholder marker`,
      );
    }
  }
});

test(
  'the two unchanged trust URLs build as static pages with only the approved page-view script',
  { timeout: 120_000 },
  async () => {
    await ensureAppBuild();
    // E9-08 exercises /legit at runtime.
    for (const slug of ['guarantee', 'about']) {
      const { title, description } = approvedPage(slug);
      const html = await readFile(
        join(root, `dist/client/${slug}/index.html`),
        'utf8',
      );
      assert.match(html, new RegExp(`<title>${title}</title>`, 'u'));
      assert.ok(html.includes(`content="${description}"`));
      assert.match(html, /<h1[^>]*>/u);
      const dataBlocks = [
        ...html.matchAll(
          /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu,
        ),
      ];
      assert.equal(dataBlocks.length, 1);
      assert.equal(JSON.parse(dataBlocks[0][1])['@type'], 'Organization');
      const emitter = html.match(
        /<script defer src="\/page-view\.js" data-website-id="[a-f0-9-]{36}"><\/script>/u,
      );
      assert.ok(emitter, `/${slug} needs the approved page-view emitter`);
      assert.doesNotMatch(
        html.replace(dataBlocks[0][0], '').replace(emitter[0], ''),
        /<script\b|\.js(?:["?]|$)/iu,
      );
      assert.doesNotMatch(
        html,
        /\b(?:TODO|TBD|lorem ipsum|placeholder|dummy copy)\b/iu,
      );
      assert.doesNotMatch(html, /Source notes/u);
    }
  },
);
