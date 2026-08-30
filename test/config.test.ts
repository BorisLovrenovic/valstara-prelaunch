import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  appEnvironmentKeys,
  ConfigurationError,
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
  });
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
