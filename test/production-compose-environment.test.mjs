import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { productionTestEnvironment } from '../infra/compose/production-test-environment.mjs';
import * as config from '../src/server/config.ts';

// QA gate 7 (G7-1-I1/T2): every production service must receive, through its
// Compose `environment` block, every variable its code reads. A key the code
// reads but Compose does not pass silently falls back to its default in
// production, which is how TURNSTILE_SITE_KEY, the ESP tier and cap keys and
// the giveaway, referral-attribution and IP-velocity settings went missing.
//
// What a service reads is measured, not listed: the module closure of each
// service's entry points names the configuration getters it imports, and each
// getter runs against a recording environment.

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const composeFile = join(root, 'infra/compose/docker-compose.production.yml');
const configFile = join(root, 'src/server/config.ts');

// Configuration that must never reach production: the schema rejects it there.
const forbiddenInProduction = new Set(['RESEND_TEST_RECIPIENT']);

const loadPatterns = [
  /\bimport\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bexport\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\bimport\s+['"]([^'"]+)['"]/gu,
];

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { recursive: true });
  return entries
    .map((entry) => join(directory, entry))
    .filter((path) => /\.(?:astro|[cm]?[jt]s)$/u.test(path))
    .sort();
}

/** Source files reachable from the entries through relative imports. */
async function closure(entries) {
  const seen = new Map();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file) || !/\.(?:astro|[cm]?[jt]s)$/u.test(file)) continue;
    const source = withoutComments(await readFile(file, 'utf8'));
    seen.set(file, source);
    for (const pattern of loadPatterns) {
      for (const match of source.matchAll(pattern)) {
        if (!match[1].startsWith('.')) continue;
        const target = resolve(dirname(file), match[1]);
        if (await isFile(target)) pending.push(target);
      }
    }
  }
  return seen;
}

function configImports(file, source) {
  const names = new Set();
  for (const match of source.matchAll(
    /\bimport\s+(?!type\b)\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu,
  )) {
    if (resolve(dirname(file), match[2]) !== configFile) continue;
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)[0];
      if (name !== '' && !part.trim().startsWith('type ')) names.add(name);
    }
  }
  return names;
}

/** A valid production environment, so every getter reads every key it uses. */
function fixtureEnvironment() {
  return {
    ...productionTestEnvironment(),
    BREVO_API_KEY: 'production-fixture-brevo-key',
    BREVO_LIST_ID: '1',
    BREVO_SENDING_DOMAIN: config.productionBrevoSendingDomain,
    DATABASE_URL: 'postgresql://user:password@postgres:5432/valstara_waitlist',
    HOST: '0.0.0.0',
    NODE_ENV: 'production',
    PORT: '4321',
  };
}

/** Environment keys the given modules read when the service starts. */
export function keysRead(modules) {
  const reads = new Set();
  const environment = new Proxy(fixtureEnvironment(), {
    get(target, key) {
      if (typeof key === 'string') reads.add(key);
      return target[key];
    },
  });
  for (const [file, source] of modules) {
    for (const name of configImports(file, source)) {
      if (name === 'getConfig' || name === 'validateConfig')
        config.validateConfig(environment);
      else if (name.startsWith('get') && typeof config[name] === 'function')
        config[name](environment);
    }
    if (file === configFile) continue;
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu))
      reads.add(match[1]);
  }
  return [...reads].filter((key) => !forbiddenInProduction.has(key)).sort();
}

export function missingKeys(read, composeEnvironment) {
  const passed = new Set(Object.keys(composeEnvironment ?? {}));
  return read.filter((key) => !passed.has(key));
}

async function renderedProductionCompose() {
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--format', 'json'],
    {
      env: { ...process.env, ...productionTestEnvironment() },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

async function serviceModules() {
  // The app image first runs `node ./src/server/config.ts`, then the Astro
  // server built from the middleware and every page.
  const app = await closure([
    join(root, 'src/server/config.ts'),
    join(root, 'src/middleware.ts'),
    ...(await filesUnder(join(root, 'src/pages'))),
  ]);
  return {
    app,
    maintenance: await closure([
      join(root, 'src/server/subscriber/run-maintenance.ts'),
    ]),
    migrate: await closure([join(root, 'src/server/db/run-migrations.ts')]),
  };
}

test('every production service receives every environment variable its code reads', async () => {
  const [compose, modules] = await Promise.all([
    renderedProductionCompose(),
    serviceModules(),
  ]);
  const missing = {};
  for (const [service, files] of Object.entries(modules)) {
    const read = keysRead(files);
    assert.ok(read.length > 0, `${service} reads no environment`);
    const absent = missingKeys(read, compose.services[service].environment);
    if (absent.length > 0) missing[service] = absent;
  }
  assert.deepEqual(
    missing,
    {},
    'production Compose does not pass these variables to the services that read them',
  );
});

test('the measurement sees the keys behind each service’s configuration getters', async () => {
  const modules = await serviceModules();
  const app = keysRead(modules.app);
  const maintenance = keysRead(modules.maintenance);
  for (const key of [
    'TURNSTILE_SITE_KEY',
    'IP_VELOCITY_THRESHOLD',
    'REFERRAL_ATTRIBUTION_DROP_PERCENT',
    'GIVEAWAY_SANCTIONED_COUNTRIES',
    'RESEND_TIER',
    'BREVO_DAILY_CAP',
  ])
    assert.ok(app.includes(key), `the app read set lacks ${key}`);
  for (const key of [
    'REFERRAL_ATTRIBUTION_BASELINE_DAYS',
    'GIVEAWAY_SUBSTITUTION_DAYS',
    'RESEND_DAILY_CAP',
    'BREVO_TIER',
    'SEED_TEST_CONFIG_PATH',
  ])
    assert.ok(
      maintenance.includes(key),
      `the maintenance read set lacks ${key}`,
    );
  assert.deepEqual(keysRead(modules.migrate), [
    'MIGRATION_DATABASE_URL',
    'VALSTARA_APP_DB_PASSWORD',
  ]);
  assert.ok(!app.includes('RESEND_TEST_RECIPIENT'));
});

test('a key removed from a service’s Compose block is reported', async () => {
  const [compose, modules] = await Promise.all([
    renderedProductionCompose(),
    serviceModules(),
  ]);
  const planted = { ...compose.services.maintenance.environment };
  delete planted.RESEND_TIER;
  assert.deepEqual(missingKeys(keysRead(modules.maintenance), planted), [
    'RESEND_TIER',
  ]);
});
