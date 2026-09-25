import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findInlineProse,
  runSecurityGates,
} from '../scripts/ci/security-gates.mjs';
import { collections } from '../src/content.config.ts';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expectedTargets = new Map([
  ['legit.md', '/legit'],
  ['guarantee.md', '/guarantee'],
  ['about.md', '/about'],
  ['terms.md', '/terms'],
  ['privacy.md', '/privacy'],
  ['VAL-GW-LAUNCH-20260925-r1.md', '/giveaway/rules'],
]);

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    }),
  );
  return nested.flat();
}

async function assertPortTargets(directory) {
  const files = await markdownFiles(directory);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
      source,
    )?.[1];
    assert.ok(frontmatter, `${file} must have frontmatter`);
    const target = /^portTarget:\s*['"]?(\/[a-z0-9/-]+)['"]?\s*$/mu.exec(
      frontmatter,
    )?.[1];
    assert.ok(target, `${file} must declare a storefront portTarget`);
    const expected = expectedTargets.get(basename(file));
    if (expected) {
      assert.equal(target, expected, `${file} must keep its permanent route`);
    }
  }
  return files;
}

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'valstara-content-'));
  try {
    await mkdir(join(root, 'src', 'content'), { recursive: true });
    await mkdir(join(root, 'src', 'pages'), { recursive: true });
    await mkdir(join(root, 'src', 'server', 'giveaway'), {
      recursive: true,
    });
    await cp(
      join(projectRoot, 'astro.config.mjs'),
      join(root, 'astro.config.mjs'),
    );
    await cp(
      join(projectRoot, 'src', 'content.config.ts'),
      join(root, 'src', 'content.config.ts'),
    );
    await cp(
      join(projectRoot, 'src', 'server', 'giveaway', 'rules.ts'),
      join(root, 'src', 'server', 'giveaway', 'rules.ts'),
    );
    await symlink(
      join(projectRoot, 'node_modules'),
      join(root, 'node_modules'),
    );
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(root, 'src', 'pages', 'index.astro'),
      "---\nimport { getCollection, render } from 'astro:content';\nexport const prerender = true;\nconst trust = await getCollection('trust');\nconst legal = await getCollection('legal');\nconst { Content: TrustContent } = await render(trust[0]);\nconst { Content: LegalContent } = await render(legal[0]);\n---\n<main><TrustContent /><LegalContent /></main>\n",
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function build(root) {
  const result = spawnSync(
    join(projectRoot, 'node_modules', '.bin', 'astro'),
    ['build'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      timeout: 60_000,
    },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

test('the port checklist is complete for every production content file', async () => {
  await assertPortTargets(join(projectRoot, 'src', 'content'));
});

test('content collection schemas require a port target in their own route set', () => {
  assert.deepEqual(Object.keys(collections).sort(), [
    'giveawayRules',
    'legal',
    'trust',
  ]);
  for (const [collection, valid, invalid] of [
    [collections.trust, '/legit', '/privacy'],
    [collections.legal, '/privacy', '/about'],
  ]) {
    assert.equal(
      collection.schema.safeParse({ portTarget: valid }).success,
      true,
    );
    assert.equal(
      collection.schema.safeParse({ portTarget: invalid }).success,
      false,
    );
    assert.equal(collection.schema.safeParse({}).success, false);
  }
});

test(
  'missing frontmatter fails the Astro build',
  { timeout: 75_000 },
  async () => {
    await withFixture(async (root) => {
      await writeFile(
        join(root, 'src', 'content', 'legit.md'),
        '---\nportTarget: /legit\n---\nTrust prose.\n',
      );
      await writeFile(
        join(root, 'src', 'content', 'terms.md'),
        '---\n---\nLegal prose.\n',
      );
      const result = build(root);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /terms\.md|terms/u);
      assert.match(result.output, /portTarget/u);
    });
  },
);

test(
  'valid trust and legal content renders with no client JavaScript',
  { timeout: 75_000 },
  async () => {
    await withFixture(async (root) => {
      await writeFile(
        join(root, 'src', 'content', 'legit.md'),
        '---\nportTarget: /legit\n---\nTrust prose.\n',
      );
      await writeFile(
        join(root, 'src', 'content', 'terms.md'),
        '---\nportTarget: /terms\n---\nLegal prose.\n',
      );
      const files = await assertPortTargets(join(root, 'src', 'content'));
      assert.equal(files.length, 2);
      const result = build(root);
      assert.equal(result.status, 0, result.output);
      const html = await readFile(
        join(root, 'dist', 'client', 'index.html'),
        'utf8',
      );
      assert.match(html, /Trust prose/u);
      assert.match(html, /Legal prose/u);
      assert.doesNotMatch(html, /<script\b/iu);
      const assets = await readdir(join(root, 'dist', 'client'), {
        recursive: true,
      });
      assert.ok(
        !assets.some((asset) => asset.endsWith('.js')),
        `unexpected browser JavaScript: ${assets.join(', ')}`,
      );
    });
  },
);

test('the inline-prose gate rejects a planted block and the source tree is clean', async () => {
  const hits = await findInlineProse(
    '<section><p>Planted prose block</p></section>',
  );
  assert.equal(hits.length, 1);
  const issues = await runSecurityGates({ audit: false });
  assert.deepEqual(
    issues.filter((issue) => issue.scan === 'inline-prose'),
    [],
  );
});
