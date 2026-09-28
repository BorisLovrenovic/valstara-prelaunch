import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { waitFor } from '../infra/compose/wait-for.mjs';

const execFileAsync = promisify(execFile);
const composeUrl = new URL(
  '../infra/compose/docker-compose.production.yml',
  import.meta.url,
);
const caddyUrl = new URL('../infra/compose/Caddyfile', import.meta.url);
const dockerfileUrl = new URL('../Dockerfile', import.meta.url);
const migrationRunnerUrl = new URL(
  '../src/server/db/run-migrations.ts',
  import.meta.url,
);
const workflowUrl = new URL(
  '../.github/workflows/main-image.yml',
  import.meta.url,
);

const sha = '0123456789012345678901234567890123456789';
const composeEnvironment = {
  ...process.env,
  ADMIN_CREDENTIAL: 'production-infra-admin-credential-32-chars',
  ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  CADDY_ORIGIN_CERT_PATH: '/run/valstara-test-origin-cert.pem',
  CADDY_ORIGIN_KEY_PATH: '/run/valstara-test-origin-key.pem',
  IP_PREFIX_PEPPER: 'test-prefix-pepper',
  REFERRAL_SIGNING_SECRET: 'test-referral-secret',
  EMAIL_BASE_URL: 'https://valstara.com',
  EMAIL_TOKEN_SECRET: 'production-infra-email-token-secret-32-chars',
  P1_ALERT_WEBHOOK_TOKEN: 'test-alert-token',
  P1_ALERT_WEBHOOK_URL: 'https://alerts.example.test/valstara',
  RESEND_API_KEY: 'test-resend-key',
  RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
  RESEND_KEY_MODE: 'live',
  RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
  RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
  RESEND_SENDING_DOMAIN: 'send.valstara.com',
  TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
  UMAMI_APP_SECRET: 'test-umami-app-secret',
  UMAMI_DB_PASSWORD: 'test-umami-database-password',
  UMAMI_DB_USER: 'umami',
  VALSTARA_APP_DB_PASSWORD: 'test-app-database-password',
  VALSTARA_DB_PASSWORD: 'test-owner-database-password',
  VALSTARA_DB_USER: 'valstara',
  VALSTARA_IMAGE: `ghcr.io/example/valstara-prelaunch:${sha}`,
  VALSTARA_RELEASE: sha,
};

async function renderedProductionCompose() {
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '-f', composeUrl.pathname, 'config', '--format', 'json'],
    { env: composeEnvironment, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

test('production-stack waits use an elapsed-time deadline', async () => {
  let elapsedMs = 0;
  let operationCalls = 0;
  let deadline;
  let deadlineCallback;
  let deadlineCancelled = false;
  const advance = (delayMs) => {
    elapsedMs += delayMs;
    if (deadlineCallback && elapsedMs >= deadline) {
      const callback = deadlineCallback;
      deadlineCallback = undefined;
      callback();
    }
  };
  const scheduler = {
    cancel: () => {
      deadlineCancelled = true;
      deadlineCallback = undefined;
    },
    schedule: (callback, delayMs) => {
      deadline = elapsedMs + delayMs;
      deadlineCallback = callback;
      return 1;
    },
    sleep: async (delayMs) => {
      advance(delayMs);
    },
  };

  await assert.rejects(
    waitFor(
      'backend did not recover',
      async () => {
        operationCalls += 1;
        advance(700);
        return 'unhealthy';
      },
      'healthy',
      1_000,
      scheduler,
    ),
    /backend did not recover: expected healthy, last observed unhealthy/,
  );
  assert.equal(operationCalls, 1);
  assert.equal(deadlineCancelled, true);
});

test('main pushes produce an immutable SHA image and retain three versions', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /push:\n {4}branches:\n {6}- main/);
  assert.match(
    workflow,
    /paths:\n {6}- 'src\/\*\*'\n {6}- 'infra\/\*\*'\n {6}- 'scripts\/\*\*'/,
  );
  assert.doesNotMatch(workflow, /docs\/\*\*/);
  assert.match(
    workflow,
    /tags: \$\{\{ steps\.image\.outputs\.name \}\}:\$\{\{ github\.sha \}\}/,
  );
  assert.match(workflow, /push: true/);
  assert.match(workflow, /min-versions-to-keep: 3/);
  assert.match(workflow, /package-type: container/);
});

test('the production image is multi-stage, health-checked, and non-root', async () => {
  const dockerfile = await readFile(dockerfileUrl, 'utf8');

  assert.equal((dockerfile.match(/^FROM /gm) ?? []).length, 4);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /RUN npm prune --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(
    dockerfile,
    /^COPY --chown=node:node --from=build \/app\/src\/content\/giveaway-award-catalog\.json \.\/src\/content\/giveaway-award-catalog\.json$/m,
  );
  assert.match(
    dockerfile,
    /CMD \["sh", "-c", "node \.\/src\/server\/config\.ts && exec node \.\/dist\/server\/entry\.mjs"\]/,
  );
});

test('the production migration entry point resolves under native Node TypeScript', async () => {
  const environment = { ...process.env };
  delete environment.MIGRATION_DATABASE_URL;
  delete environment.VALSTARA_APP_DB_PASSWORD;

  await assert.rejects(
    execFileAsync(process.execPath, [migrationRunnerUrl.pathname], {
      env: environment,
    }),
    (error) => {
      assert.match(error.stderr, /MIGRATION_DATABASE_URL is required/);
      assert.doesNotMatch(error.stderr, /ERR_MODULE_NOT_FOUND/);
      return true;
    },
  );
});

test('production Compose uses the SHA image and hard-disables swap', async () => {
  const config = await renderedProductionCompose();
  const expectedServices = [
    'app',
    'caddy',
    'maintenance',
    'migrate',
    'postgres',
    'umami',
  ];

  assert.deepEqual(Object.keys(config.services).sort(), expectedServices);
  assert.equal(
    config.services.app.image,
    `ghcr.io/example/valstara-prelaunch:${sha}`,
  );
  assert.equal(config.services.migrate.image, config.services.app.image);
  assert.equal(config.services.maintenance.image, config.services.app.image);
  for (const key of [
    'ADMIN_CREDENTIAL',
    'ADMIN_TOTP_SECRET',
    'DATABASE_URL',
    'EMAIL_BASE_URL',
    'EMAIL_TOKEN_SECRET',
    'IP_PREFIX_PEPPER',
    'REFERRAL_SIGNING_SECRET',
    'RESEND_API_KEY',
    'RESEND_DKIM_EXPECTED_VALUE',
    'RESEND_KEY_MODE',
    'RESEND_RSEND_CNAME_EXPECTED_TARGET',
    'RESEND_SENDING_DOMAIN',
    'RESEND_SEND_CNAME_EXPECTED_TARGET',
    'TURNSTILE_SECRET_KEY',
  ]) {
    assert.notEqual(
      config.services.app.environment[key],
      undefined,
      `production app is missing ${key}`,
    );
  }

  for (const service of expectedServices) {
    const definition = config.services[service];
    assert.ok(definition.mem_limit > 0, `${service} has no memory limit`);
    assert.equal(
      definition.memswap_limit,
      definition.mem_limit,
      `${service} does not disable swap`,
    );
  }

  assert.equal(config.services.app.ports, undefined);
  assert.equal(config.services.maintenance.ports, undefined);
  assert.deepEqual(Object.keys(config.services.maintenance.environment), [
    'DATABASE_URL',
    'DRAND_CHAIN_HASH',
    'DRAND_CHAIN_PUBLIC_KEY',
    'DRAND_RELAY_URLS',
    'EMAIL_BASE_URL',
    'EMAIL_TOKEN_SECRET',
    'NODE_ENV',
    'P1_ALERT_WEBHOOK_TOKEN',
    'P1_ALERT_WEBHOOK_URL',
    'RESEND_API_KEY',
    'RESEND_DKIM_EXPECTED_VALUE',
    'RESEND_KEY_MODE',
    'RESEND_RSEND_CNAME_EXPECTED_TARGET',
    'RESEND_SENDING_DOMAIN',
    'RESEND_SEND_CNAME_EXPECTED_TARGET',
    'VERIFICATION_RATE_BASELINE_DAYS',
    'VERIFICATION_RATE_COHORT_HOURS',
    'VERIFICATION_RATE_COLLAPSE_PERCENT',
    'VERIFICATION_RATE_MINIMUM_SIGNUPS',
    'WAITLIST_LIVE_AT',
  ]);
  assert.equal(config.services.postgres.ports, undefined);
  assert.equal(config.services.umami.ports, undefined);
  assert.equal(config.networks.backend.internal, true);
  assert.deepEqual(Object.keys(config.services.caddy.ports).length, 2);
});

test('Caddy rejects direct peers and actively health-gates the app', async () => {
  const caddyfile = await readFile(caddyUrl, 'utf8');
  const cloudflareRanges = [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22',
    '2400:cb00::/32',
    '2606:4700::/32',
    '2803:f800::/32',
    '2405:b500::/32',
    '2405:8100::/32',
    '2a06:98c0::/29',
    '2c0f:f248::/32',
  ];

  for (const range of cloudflareRanges) {
    assert.ok(caddyfile.includes(range), `missing Cloudflare range ${range}`);
  }

  assert.match(caddyfile, /@not_cloudflare not remote_ip/);
  assert.match(caddyfile, /respond @not_cloudflare 403/);
  assert.match(caddyfile, /tls \/run\/secrets\/caddy_origin_cert/);
  assert.match(caddyfile, /health_uri \//);
  assert.match(caddyfile, /health_fails 2/);
  assert.match(caddyfile, /health_passes 2/);
});
