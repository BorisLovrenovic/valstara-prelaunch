import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  appEnvironmentKeys,
  ConfigurationError,
  getDatabaseUrl,
  getP1AlertConfiguration,
  getVerificationRateConfiguration,
  turnstileTestSiteKey,
  validateConfig,
} from '../src/server/config.ts';

const execFileAsync = promisify(execFile);

const validEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL:
    'postgresql://valstara_app:local-password@127.0.0.1:5434/valstara_waitlist',
  HOST: '127.0.0.1',
  IP_PREFIX_PEPPER: 'local-test-prefix-pepper',
  NODE_ENV: 'test',
  PORT: '4321',
  RESEND_API_KEY: 'local-test-resend-key',
  RESEND_TEST_RECIPIENT: 'delivered@resend.dev',
  TURNSTILE_SECRET_KEY: 'local-test-turnstile-secret',
};

function withVariable(
  key: string,
  value: string | undefined,
): NodeJS.ProcessEnv {
  const environment = { ...validEnvironment };
  if (value === undefined) {
    delete environment[key];
  } else {
    environment[key] = value;
  }
  return environment;
}

async function assertBootRejects(
  environment: NodeJS.ProcessEnv,
  key: string,
): Promise<void> {
  const bootEnvironment = { ...process.env, ...environment };
  delete bootEnvironment[key];
  await assert.rejects(
    execFileAsync(process.execPath, ['./src/server/config.ts'], {
      cwd: new URL('..', import.meta.url),
      env: bootEnvironment,
    }),
    (error) => {
      assert.ok(
        typeof error === 'object' &&
          error !== null &&
          'stderr' in error &&
          typeof error.stderr === 'string',
      );
      assert.match(error.stderr, new RegExp(`${key} is required`, 'u'));
      assert.doesNotMatch(error.stderr, /local-test/u);
      return true;
    },
  );
}

test('E1-12 validates and types the complete application environment', () => {
  assert.deepEqual(validateConfig(validEnvironment), {
    databaseUrl: validEnvironment.DATABASE_URL,
    host: '127.0.0.1',
    ipPrefixPepper: 'local-test-prefix-pepper',
    nodeEnvironment: 'test',
    port: 4321,
    resendApiKey: 'local-test-resend-key',
    resendTestRecipient: 'delivered@resend.dev',
    turnstileSecretKey: 'local-test-turnstile-secret',
    turnstileSiteKey: turnstileTestSiteKey,
    verificationRate: {
      baselineDays: 7,
      cohortHours: 24,
      collapsePercent: 50,
      minimumSignups: 50,
    },
  });
});

test('a database-only process validates only its required connection URL', () => {
  assert.equal(getDatabaseUrl(validEnvironment), validEnvironment.DATABASE_URL);
  assert.throws(
    () => getDatabaseUrl(withVariable('DATABASE_URL', undefined)),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.variableName, 'DATABASE_URL');
      return true;
    },
  );
});

test('E3-10 validates monitoring defaults and configuration overrides', () => {
  assert.deepEqual(getVerificationRateConfiguration(validEnvironment), {
    baselineDays: 7,
    cohortHours: 24,
    collapsePercent: 50,
    minimumSignups: 50,
  });
  assert.deepEqual(
    getVerificationRateConfiguration({
      ...validEnvironment,
      VERIFICATION_RATE_BASELINE_DAYS: '14',
      VERIFICATION_RATE_COHORT_HOURS: '12',
      VERIFICATION_RATE_COLLAPSE_PERCENT: '40',
      VERIFICATION_RATE_MINIMUM_SIGNUPS: '100',
    }),
    {
      baselineDays: 14,
      cohortHours: 12,
      collapsePercent: 40,
      minimumSignups: 100,
    },
  );
  assert.throws(
    () =>
      getVerificationRateConfiguration({
        ...validEnvironment,
        VERIFICATION_RATE_COLLAPSE_PERCENT: '0',
      }),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.variableName, 'VERIFICATION_RATE_COLLAPSE_PERCENT');
      return true;
    },
  );
});

test('the P1 alert transport requires authenticated HTTPS configuration in production', () => {
  assert.deepEqual(
    getP1AlertConfiguration({
      NODE_ENV: 'production',
      P1_ALERT_WEBHOOK_TOKEN: 'operator-alert-token',
      P1_ALERT_WEBHOOK_URL: 'https://alerts.example.test/valstara',
    }),
    {
      token: 'operator-alert-token',
      url: 'https://alerts.example.test/valstara',
    },
  );
  assert.throws(
    () =>
      getP1AlertConfiguration({
        NODE_ENV: 'production',
        P1_ALERT_WEBHOOK_TOKEN: 'operator-alert-token',
        P1_ALERT_WEBHOOK_URL: 'http://alerts.example.test/valstara',
      }),
    /P1_ALERT_WEBHOOK_URL/u,
  );
  assert.throws(
    () => getP1AlertConfiguration({ NODE_ENV: 'production' }),
    /P1_ALERT_WEBHOOK_URL/u,
  );
});

test('E3-05 defaults the public site key to the placeholder and honours an override', () => {
  // The public Turnstile site key is not a secret and never fails boot: absent,
  // it falls back to the temporary Cloudflare test key (swapped for the real one
  // in E12-05); present, the provided value wins.
  assert.equal(
    validateConfig(withVariable('TURNSTILE_SITE_KEY', undefined))
      .turnstileSiteKey,
    turnstileTestSiteKey,
  );
  assert.equal(
    validateConfig(withVariable('TURNSTILE_SITE_KEY', '0x4AAAAAAAreal'))
      .turnstileSiteKey,
    '0x4AAAAAAAreal',
  );
  assert.throws(
    () => validateConfig(withVariable('TURNSTILE_SITE_KEY', 'has space')),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.variableName, 'TURNSTILE_SITE_KEY');
      return true;
    },
  );
});

test('E1-12 applies only the documented Node adapter defaults', () => {
  const environment = { ...validEnvironment };
  delete environment.HOST;
  delete environment.NODE_ENV;
  delete environment.PORT;

  const config = validateConfig(environment);
  assert.equal(config.host, undefined);
  assert.equal(config.nodeEnvironment, 'development');
  assert.equal(config.port, undefined);
});

for (const key of [
  'DATABASE_URL',
  'IP_PREFIX_PEPPER',
  'RESEND_API_KEY',
  'RESEND_TEST_RECIPIENT',
  'TURNSTILE_SECRET_KEY',
] as const) {
  test(`E1-12 rejects a missing ${key} at boot with a named error`, async () => {
    assert.throws(
      () => validateConfig(withVariable(key, undefined)),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variableName, key);
        assert.match(error.message, new RegExp(key));
        assert.doesNotMatch(error.message, /local-test/u);
        return true;
      },
    );
    await assertBootRejects(withVariable(key, undefined), key);
  });
}

const malformedCases = [
  ['DATABASE_URL', 'not-a-url'],
  ['DATABASE_URL', 'https://example.test/database'],
  ['DATABASE_URL', 'postgresql://missing-credentials.example.test/database'],
  ['HOST', 'bad host'],
  ['IP_PREFIX_PEPPER', ' padded-secret'],
  ['NODE_ENV', 'staging'],
  ['PORT', '0'],
  ['PORT', 'not-a-port'],
  ['RESEND_API_KEY', 'key\nwith-control'],
  ['RESEND_TEST_RECIPIENT', 'not-an-address'],
  ['TURNSTILE_SECRET_KEY', 'secret-with-padding '],
] as const;

for (const [key, value] of malformedCases) {
  test(`E1-12 rejects malformed ${key}`, () => {
    assert.throws(
      () => validateConfig(withVariable(key, value)),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.variableName, key);
        assert.match(error.message, new RegExp(key));
        assert.doesNotMatch(error.message, new RegExp(value));
        return true;
      },
    );
  });
}

test('E1-12 local, CI, and production commands validate before starting Astro', async () => {
  const [localStart, ciCompose, dockerfile] = await Promise.all([
    readFile(new URL('../infra/compose/run-app.sh', import.meta.url), 'utf8'),
    readFile(
      new URL('../infra/compose/docker-compose.ci.yml', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  ]);

  assert.match(localStart, /node src\/server\/config\.ts\nexec npm run dev/u);
  assert.match(
    ciCompose,
    /node \.\/src\/server\/config\.ts && exec node \.\/dist\/server\/entry\.mjs/u,
  );
  assert.match(
    dockerfile,
    /node \.\/src\/server\/config\.ts && exec node \.\/dist\/server\/entry\.mjs/u,
  );
});

test('E1-12 documented app inventory exactly matches the validated schema', async () => {
  const inventory = await readFile(
    new URL('../infra/ENV.md', import.meta.url),
    'utf8',
  );
  const section = inventory.match(
    /## Application boot schema\n(?<body>[\s\S]*?)\n## /u,
  )?.groups?.body;
  assert.notEqual(
    section,
    undefined,
    'application boot schema section missing',
  );

  const documentedKeys = [
    ...(section ?? '').matchAll(/^\| `([A-Z_]+)`\s+\|/gmu),
  ]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined)
    .sort();

  assert.deepEqual(documentedKeys, [...appEnvironmentKeys].sort());
  for (const key of documentedKeys) {
    assert.match(section ?? '', new RegExp('^\\| `' + key + '`\\s+\\|', 'mu'));
  }
});

test('E1-12 complete inventory documents every repository environment variable', async () => {
  const projectRoot = new URL('..', import.meta.url);
  const inventory = await readFile(
    new URL('../infra/ENV.md', import.meta.url),
    'utf8',
  );
  const documentedKeys = new Set(
    [...inventory.matchAll(/^\| `([A-Z][A-Z0-9_]*)`\s+\|/gmu)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined),
  );
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const sourcePaths = stdout
    .split('\0')
    .filter(Boolean)
    .filter(
      (path) =>
        path !== 'infra/ENV.md' &&
        path !== 'test/config.test.ts' &&
        !path.startsWith('docs/') &&
        !path.startsWith('test/fixtures/'),
    );
  const usedKeys = new Set<string>(appEnvironmentKeys);

  for (const path of sourcePaths) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      'utf8',
    );
    addMatches(
      usedKeys,
      source,
      /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/gu,
    );

    if (/\.(?:sh|ya?ml)$/u.test(path) || path.endsWith('Caddyfile')) {
      addMatches(usedKeys, source, /\$\{([A-Z][A-Z0-9_]*)/gu);
      addMatches(usedKeys, source, /\$([A-Z][A-Z0-9_]*)/gu);
    }
    if (/\.ya?ml$/u.test(path)) {
      addMatches(usedKeys, source, /^\s+([A-Z][A-Z0-9_]*):/gmu);
    }
    if (path === 'Dockerfile') {
      addMatches(usedKeys, source, /(?:^ENV\s+|^\s+)([A-Z][A-Z0-9_]*)=/gmu);
    }
  }

  const undocumentedKeys = [...usedKeys]
    .filter((key) => !documentedKeys.has(key))
    .sort();
  assert.deepEqual(undocumentedKeys, []);
});

function addMatches(keys: Set<string>, source: string, pattern: RegExp): void {
  for (const match of source.matchAll(pattern)) {
    const key = match[1] ?? match[2];
    if (key !== undefined) {
      keys.add(key);
    }
  }
}
