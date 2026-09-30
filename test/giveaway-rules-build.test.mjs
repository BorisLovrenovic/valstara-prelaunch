import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const rulesVersion = 'VAL-GW-LAUNCH-20261001-r1';
const earlierRulesVersion = 'VAL-GW-LAUNCH-20260925-r1';
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
    const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ADMIN_CREDENTIAL: 'giveaway-rules-test-admin-credential',
        ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        DATABASE_URL:
          'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
        IP_PREFIX_PEPPER: 'giveaway-rules-test-prefix-pepper',
        REFERRAL_SIGNING_SECRET: 'giveaway-rules-test-referral-secret',
        RESEND_API_KEY: 'giveaway-rules-test-resend-key',
        RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
        RESEND_KEY_MODE: 'test',
        RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
        RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
        RESEND_SENDING_DOMAIN: 'send.valstara.com',
        TURNSTILE_SECRET_KEY: 'giveaway-rules-test-turnstile-secret',
        HOST: '127.0.0.1',
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise((resolve) => server.once('close', resolve));
    let output = '';
    let serverError;
    server.once('error', (error) => {
      serverError = error;
    });
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    server.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    try {
      let current;
      let origin;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (serverError !== undefined) {
          throw new Error(
            `Rules server could not start: ${serverError.message}`,
            {
              cause: serverError,
            },
          );
        }
        if (server.exitCode !== null || server.signalCode !== null) {
          throw new Error(`Rules server exited before startup: ${output}`);
        }
        const port = /Server listening on http:\/\/127\.0\.0\.1:(\d+)/u.exec(
          output,
        )?.[1];
        if (port !== undefined) {
          origin = `http://127.0.0.1:${port}`;
          try {
            current = await globalThis.fetch(`${origin}/giveaway/rules`, {
              redirect: 'manual',
              signal: globalThis.AbortSignal.timeout(1_000),
            });
            break;
          } catch {
            // The server may still be finishing startup.
          }
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
      }
      assert.ok(current, `Rules server did not start: ${output}`);
      const permanent = await globalThis.fetch(
        `${origin}/giveaway/rules/${rulesVersion}`,
        {
          redirect: 'manual',
          signal: globalThis.AbortSignal.timeout(5_000),
        },
      );
      assert.equal(current.status, 200, output);
      assert.equal(permanent.status, 200, output);
      const earlier = await globalThis.fetch(
        `${origin}/giveaway/rules/${earlierRulesVersion}`,
        { redirect: 'manual', signal: globalThis.AbortSignal.timeout(5_000) },
      );
      assert.equal(earlier.status, 200, output);
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
      assert.match(currentArticle[3], /support@valstara\.com/u);
      assert.doesNotMatch(currentArticle[3], /@subslush\.com/u);
      const earlierArticle = articlePattern.exec(await earlier.text());
      assert.ok(earlierArticle);
      assert.equal(earlierArticle[1], earlierRulesVersion);
      assert.match(earlierArticle[3], /compliance@subslush\.com/u);
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
      if (server.exitCode === null && server.signalCode === null) server.kill();
      await closed;
    }
  },
);
