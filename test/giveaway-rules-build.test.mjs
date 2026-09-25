import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rulesVersion = 'VAL-GW-LAUNCH-20260925-r1';
const contentPath = join(
  'src',
  'content',
  'giveaway-rules',
  `${rulesVersion}.md`,
);
const buildPath = join(projectRoot, 'node_modules', '.bin', 'astro');

async function buildFixture(changeContent) {
  const root = await mkdtemp(join(tmpdir(), 'valstara-rules-'));
  try {
    await cp(join(projectRoot, 'src'), join(root, 'src'), { recursive: true });
    await cp(join(projectRoot, 'public'), join(root, 'public'), {
      recursive: true,
    });
    await cp(
      join(projectRoot, 'astro.config.mjs'),
      join(root, 'astro.config.mjs'),
    );
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await symlink(
      join(projectRoot, 'node_modules'),
      join(root, 'node_modules'),
    );
    const file = join(root, contentPath);
    const original = await readFile(file, 'utf8');
    await writeFile(file, changeContent(original));
    const result = spawnSync(buildPath, ['build'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      timeout: 120_000,
    });
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  'a prize over the per-prize limit fails the Astro build',
  { timeout: 150_000 },
  async () => {
    const result = await buildFixture((content) =>
      content.replace(
        'prizeApproxRetailValueEur: 300',
        'prizeApproxRetailValueEur: 450',
      ),
    );
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /exceeds €449/u);
  },
);

test(
  'a placeholder in the published rules fails the Astro build',
  { timeout: 150_000 },
  async () => {
    const result = await buildFixture(
      (content) => `${content}\nTODO: choose a prize\n`,
    );
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /placeholder marker/u);
  },
);

test(
  'a pool at or above US$5,000 fails the Astro build',
  { timeout: 150_000 },
  async () => {
    const result = await buildFixture((content) =>
      content.replace('conservativeUsdPerEur: 2', 'conservativeUsdPerEur: 4'),
    );
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /below US\$5,000/u);
  },
);

test(
  'editing a published revision under the same hash fails the Astro build',
  { timeout: 150_000 },
  async () => {
    const result = await buildFixture((content) =>
      content.replace(
        'You can enter from any country',
        'You can enter from everywhere',
      ),
    );
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /SHA-256 mismatch/u);
  },
);

test(
  'current and versioned URLs serve identical immutable rules HTML and matching SHA-256',
  { timeout: 30_000 },
  async () => {
    const port = 43_762;
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn('node', ['dist/server/entry.mjs'], {
      cwd: projectRoot,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    server.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    try {
      let current;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          current = await globalThis.fetch(`${origin}/giveaway/rules`, {
            redirect: 'manual',
          });
          break;
        } catch {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
        }
      }
      assert.ok(current, `Rules server did not start: ${output}`);
      const permanent = await globalThis.fetch(
        `${origin}/giveaway/rules/${rulesVersion}`,
        { redirect: 'manual' },
      );
      assert.equal(current.status, 200, output);
      assert.equal(permanent.status, 200, output);
      assert.doesNotMatch(current.url, new RegExp(`${rulesVersion}$`, 'u'));
      assert.match(permanent.url, new RegExp(`${rulesVersion}$`, 'u'));
      const currentPage = await current.text();
      const permanentPage = await permanent.text();
      const articlePattern =
        /<article\b[^>]*data-rules-version="([^"]+)"[^>]*data-rules-sha256="([a-f0-9]{64})"[^>]*>([\s\S]*?)<\/article>/u;
      const currentArticle = articlePattern.exec(currentPage);
      const permanentArticle = articlePattern.exec(permanentPage);
      assert.ok(currentArticle);
      assert.ok(permanentArticle);
      assert.equal(currentArticle[1], rulesVersion);
      assert.equal(permanentArticle[1], rulesVersion);
      assert.equal(currentArticle[2], permanentArticle[2]);
      assert.equal(currentArticle[3], permanentArticle[3]);
      assert.equal(
        createHash('sha256').update(currentArticle[3], 'utf8').digest('hex'),
        currentArticle[2],
      );
      assert.match(currentArticle[3], /country of residence/u);
      assert.match(currentArticle[3], /don.t need your postal address/u);
      assert.match(currentArticle[3], /No purchase or payment is necessary/u);
      assert.match(currentArticle[3], /approximate retail value of €300/u);
      assert.match(
        currentArticle[3],
        /goods in the bundle will be listed on this page before the draw/iu,
      );
      assert.doesNotMatch(currentArticle[3], /dummy product|TODO|TBD/iu);
      assert.doesNotMatch(currentArticle[3], /<script\b|<iframe\b/iu);
    } finally {
      server.kill();
      await once(server, 'exit');
    }
  },
);
